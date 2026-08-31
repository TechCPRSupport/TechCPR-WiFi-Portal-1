const express = require("express");
const Stripe = require("stripe");
const path = require("path");
require("dotenv").config();

const db = require("./database");
const createCode = require("./generator");
const mikrotik = require("./mikrotik");

const REQUIRED_ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ADMIN_PASSWORD"
];

for (const name of REQUIRED_ENV) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, "");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const plans = Object.freeze({
  day: {
    displayName: "1 Day",
    stripeName: "TechCPR 1 Day WiFi",
    amount: Number(process.env.PRICE_DAY_CENTS || 1000),
    profile: process.env.MIKROTIK_CUSTOMER_PROFILE || "customer",
    durationMs: 24 * 60 * 60 * 1000
  },
  week: {
    displayName: "7 Days",
    stripeName: "TechCPR 7 Day WiFi",
    amount: Number(process.env.PRICE_WEEK_CENTS || 2500),
    profile: process.env.MIKROTIK_CUSTOMER_PROFILE || "customer",
    durationMs: 7 * 24 * 60 * 60 * 1000
  },
  month: {
    displayName: "1 Month",
    stripeName: "TechCPR 1 Month WiFi",
    amount: Number(process.env.PRICE_MONTH_CENTS || 5000),
    profile: process.env.MIKROTIK_CUSTOMER_PROFILE || "customer",
    durationMs: 30 * 24 * 60 * 60 * 1000
  }
});

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function requireAdmin(req, res, next) {
  const suppliedPassword = req.get("x-admin-password");

  if (suppliedPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  next();
}

async function markExpiredUsers() {
  try {
    await db.run(
      `UPDATE wifi_users
       SET wifi_status = 'Expired'
       WHERE expires <= ?
         AND wifi_status = 'Active'`,
      [new Date().toISOString()]
    );
  } catch (error) {
    console.error("Expiration update failed:", error.message);
  }
}

async function provisionCompletedCheckout(session) {
  const existing = await db.get(
    "SELECT id FROM wifi_users WHERE stripe_session = ?",
    [session.id]
  );

  if (existing) {
    console.log(`Stripe session already provisioned: ${session.id}`);
    return;
  }

  const planKey = session.metadata?.plan;
  const selectedPlan = plans[planKey];

  if (!selectedPlan) {
    throw new Error(`Unknown plan in Stripe session: ${planKey || "missing"}`);
  }

  const email = normalizeEmail(
    session.customer_details?.email || session.customer_email
  );

  if (!isValidEmail(email)) {
    throw new Error(`Stripe session has no valid customer email: ${session.id}`);
  }

  const username = `CPR${createCode(5)}`;
  const password = createCode(8);
  const created = new Date();
  const expires = new Date(created.getTime() + selectedPlan.durationMs);
  const paymentIntent =
    typeof session.payment_intent === "string" ? session.payment_intent : null;

  await db.run(
    `INSERT INTO wifi_users (
      email,
      plan,
      username,
      password,
      expires,
      created,
      stripe_session,
      stripe_payment_intent,
      payment_status,
      wifi_status,
      mikrotik_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      email,
      selectedPlan.displayName,
      username,
      password,
      expires.toISOString(),
      created.toISOString(),
      session.id,
      paymentIntent,
      "Paid",
      "Pending",
      "Pending"
    ]
  );

  try {
    await mikrotik.createWifiUser({
      username,
      password,
      profile: selectedPlan.profile,
      comment: `TechCPR ${selectedPlan.displayName} - ${email}`
    });

    await db.run(
      `UPDATE wifi_users
       SET wifi_status = 'Active',
           mikrotik_status = 'Created'
       WHERE stripe_session = ?`,
      [session.id]
    );

    console.log(`Provisioned WiFi access for Stripe session ${session.id}`);
  } catch (error) {
    await db.run(
      `UPDATE wifi_users
       SET wifi_status = 'Provisioning Error',
           mikrotik_status = ?
       WHERE stripe_session = ?`,
      [error.message.slice(0, 250), session.id]
    );

    throw error;
  }
}

/*
 * Stripe requires the unmodified raw request body. This route must appear
 * before express.json().
 */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.get("stripe-signature");

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Stripe webhook signature error:", error.message);
      return res.status(400).send("Invalid webhook signature.");
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        if (session.payment_status === "paid") {
          await provisionCompletedCheckout(session);
        }
      }

      return res.json({ received: true });
    } catch (error) {
      console.error("Stripe webhook processing error:", error);
      return res.status(500).json({ error: "Webhook processing failed." });
    }
  }
);

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "plans.html"));
});

app.post("/checkout", async (req, res) => {
  try {
    const planKey = String(req.body?.plan || "");
    const email = normalizeEmail(req.body?.email);
    const selectedPlan = plans[planKey];

    if (!selectedPlan) {
      return res.status(400).json({ error: "Please select a valid plan." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      metadata: { plan: planKey },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: selectedPlan.amount,
            product_data: {
              name: selectedPlan.stripeName
            }
          }
        }
      ],
      success_url:
        `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/plans.html`
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error("Checkout creation failed:", error);
    return res.status(500).json({ error: "Unable to start checkout." });
  }
});

app.get("/api/purchase/:sessionId", async (req, res) => {
  try {
    const purchase = await db.get(
      `SELECT
         email,
         plan,
         username,
         password,
         expires,
         payment_status,
         wifi_status
       FROM wifi_users
       WHERE stripe_session = ?`,
      [req.params.sessionId]
    );

    if (!purchase) {
      return res.status(404).json({
        error: "Your WiFi access is still being prepared. Please try again shortly."
      });
    }

    return res.json(purchase);
  } catch (error) {
    console.error("Purchase lookup failed:", error);
    return res.status(500).json({ error: "Unable to retrieve purchase." });
  }
});

app.get("/api/status", async (req, res) => {
  const status = {
    server: "ok",
    database: "unknown",
    stripe: process.env.STRIPE_SECRET_KEY ? "configured" : "not configured",
    mikrotik: "unknown",
    timestamp: new Date().toISOString()
  };

  try {
    await db.get("SELECT 1 AS ok");
    status.database = "ok";
  } catch {
    status.database = "error";
  }

  try {
    const router = await mikrotik.testConnection();
    status.mikrotik = router.identity || "connected";
  } catch {
    status.mikrotik = "unavailable";
  }

  return res.status(status.database === "ok" ? 200 : 503).json(status);
});

app.post("/api/admin/login", (req, res) => {
  if (req.body?.password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true });
  }

  return res.status(401).json({
    success: false,
    error: "Invalid admin password."
  });
});


app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    await markExpiredUsers();

    const now = new Date();
    const dayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).toISOString();
    const dayEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1
    ).toISOString();
    const expiringBefore = new Date(
      now.getTime() + 24 * 60 * 60 * 1000
    ).toISOString();

    const [
      totalRow,
      activeRow,
      expiringRow,
      paidTodayRows,
      recentPurchases
    ] = await Promise.all([
      db.get("SELECT COUNT(*) AS count FROM wifi_users"),
      db.get(
        "SELECT COUNT(*) AS count FROM wifi_users WHERE wifi_status = 'Active'"
      ),
      db.get(
        `SELECT COUNT(*) AS count
         FROM wifi_users
         WHERE expires > ?
           AND expires <= ?
           AND wifi_status = 'Active'`,
        [now.toISOString(), expiringBefore]
      ),
      db.all(
        `SELECT plan
         FROM wifi_users
         WHERE payment_status = 'Paid'
           AND created >= ?
           AND created < ?`,
        [dayStart, dayEnd]
      ),
      db.all(
        `SELECT
           email,
           plan,
           created,
           expires,
           payment_status,
           wifi_status,
           mikrotik_status
         FROM wifi_users
         ORDER BY created DESC
         LIMIT 6`
      )
    ]);

    const priceByPlan = new Map([
      [plans.day.displayName, plans.day.amount],
      [plans.week.displayName, plans.week.amount],
      [plans.month.displayName, plans.month.amount]
    ]);

    const revenueTodayCents = paidTodayRows.reduce(
      (total, row) => total + (priceByPlan.get(row.plan) || 0),
      0
    );

    const system = {
      server: "ok",
      database: "ok",
      stripe: process.env.STRIPE_SECRET_KEY ? "configured" : "not configured",
      mikrotik: "unknown"
    };

    try {
      const router = await mikrotik.testConnection();
      system.mikrotik = router.identity || "connected";
    } catch {
      system.mikrotik = "unavailable";
    }

    return res.json({
      metrics: {
        revenueTodayCents,
        totalCustomers: Number(totalRow?.count || 0),
        activeCustomers: Number(activeRow?.count || 0),
        expiringSoon: Number(expiringRow?.count || 0)
      },
      system,
      recentPurchases,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Admin dashboard lookup failed:", error);
    return res.status(500).json({ error: "Unable to load dashboard." });
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    await markExpiredUsers();

    const users = await db.all(
      `SELECT
         id,
         email,
         plan,
         username,
         password,
         expires,
         created,
         stripe_session,
         stripe_payment_intent,
         payment_status,
         wifi_status,
         mikrotik_status
       FROM wifi_users
       ORDER BY created DESC`
    );

    return res.json(users);
  } catch (error) {
    console.error("Admin user lookup failed:", error);
    return res.status(500).json({ error: "Unable to retrieve customers." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);
  res.status(500).json({ error: "Internal server error." });
});

async function start() {
  await db.initialize();
  await markExpiredUsers();

  setInterval(markExpiredUsers, 60_000).unref();

  app.listen(port, () => {
    console.log(`TechCPR server running at ${baseUrl}`);
  });
}

start().catch(error => {
  console.error("TechCPR server failed to start:", error);
  process.exit(1);
});
