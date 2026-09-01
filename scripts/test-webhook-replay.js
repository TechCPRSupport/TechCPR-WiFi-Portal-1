require("dotenv").config();

const Stripe = require("stripe");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const eventId = process.argv[2];

if (!eventId) {
  console.error("Usage: node scripts/test-webhook-replay.js evt_...");
  process.exit(1);
}

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("Missing STRIPE_SECRET_KEY in .env");
  process.exit(1);
}

if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.error("Missing STRIPE_WEBHOOK_SECRET in .env");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookUrl =
  process.env.TEST_WEBHOOK_URL || "http://localhost:3000/webhook";

const dbPath =
  process.env.DATABASE_PATH ||
  path.join(__dirname, "..", "techcpr.db");

function openDb() {
  return new sqlite3.Database(dbPath);
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function dbClose(db) {
  return new Promise((resolve, reject) => {
    db.close(error => error ? reject(error) : resolve());
  });
}

async function countSessionRows(sessionId) {
  const db = openDb();
  try {
    const row = await dbGet(
      db,
      `SELECT
         COUNT(*) AS count,
         MIN(expires) AS expires,
         MIN(username) AS username
       FROM wifi_users
       WHERE stripe_session = ?`,
      [sessionId]
    );
    return row;
  } finally {
    await dbClose(db);
  }
}

async function main() {
  const event = await stripe.events.retrieve(eventId);

  if (event.type !== "checkout.session.completed") {
    throw new Error(
      `Expected checkout.session.completed, received ${event.type}`
    );
  }

  const sessionId = event.data?.object?.id;

  if (!sessionId) {
    throw new Error("Stripe event does not contain a checkout session ID.");
  }

  const before = await countSessionRows(sessionId);

  console.log("Before replay:");
  console.log(`  Stripe session: ${sessionId}`);
  console.log(`  Database rows: ${before.count}`);
  console.log(`  Username: ${before.username || "none"}`);
  console.log(`  Expires: ${before.expires || "none"}`);

  const payload = JSON.stringify(event);

  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET
  });

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature
    },
    body: payload
  });

  const responseText = await response.text();

  console.log("");
  console.log(`Replay HTTP status: ${response.status}`);
  console.log(`Replay response: ${responseText}`);

  if (!response.ok) {
    throw new Error(
      `Webhook replay failed with HTTP ${response.status}`
    );
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  const after = await countSessionRows(sessionId);

  console.log("");
  console.log("After replay:");
  console.log(`  Database rows: ${after.count}`);
  console.log(`  Username: ${after.username || "none"}`);
  console.log(`  Expires: ${after.expires || "none"}`);

  const sameCount = Number(before.count) === Number(after.count);
  const sameUsername = before.username === after.username;
  const sameExpires = before.expires === after.expires;

  console.log("");
  if (sameCount && sameUsername && sameExpires) {
    console.log("PASS: duplicate webhook did not create or extend access.");
    process.exit(0);
  }

  console.error(
    "FAIL: duplicate replay changed the customer record."
  );
  process.exit(2);
}

main().catch(error => {
  console.error("Duplicate webhook test failed:", error.message);
  process.exit(1);
});
