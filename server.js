const express = require("express");
const Stripe = require("stripe");
const path = require("path");
const crypto = require("crypto");
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

const ADMIN_SESSION_TTL_MS = Number(
  process.env.ADMIN_SESSION_TTL_MS || 8 * 60 * 60 * 1000
);
const adminSessions = new Map();

function cleanAdminSessions() {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (!session || session.expiresAt <= now) {
      adminSessions.delete(token);
    }
  }
}

function createAdminSession() {
  cleanAdminSessions();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(token, { expiresAt });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

function getAdminToken(req) {
  return String(req.get("x-admin-token") || "").trim();
}

function requireAdmin(req, res, next) {
  cleanAdminSessions();

  const token = getAdminToken(req);
  const session = token ? adminSessions.get(token) : null;

  if (session && session.expiresAt > Date.now()) {
    req.adminSessionToken = token;
    return next();
  }

  const suppliedPassword = req.get("x-admin-password");
  if (suppliedPassword === process.env.ADMIN_PASSWORD) {
    return next();
  }

  return res.status(401).json({ error: "Unauthorized." });
}

async function markExpiredUsers() {
  try {
    const now = new Date().toISOString();
    const expiredUsers = await db.all(
      `SELECT id, username
       FROM wifi_users
       WHERE expires <= ?
         AND wifi_status = 'Active'`,
      [now]
    );

    for (const user of expiredUsers) {
      let mikrotikStatus = "Expired";

      try {
        const result = await mikrotik.disableWifiUser(user.username);
        mikrotikStatus = result.missing ? "Missing" : "Disabled";
      } catch (error) {
        mikrotikStatus = `Disable Error: ${error.message}`.slice(0, 250);
        console.error(
          `Unable to disable expired MikroTik user ${user.username}:`,
          error.message
        );
      }

      await db.run(
        `UPDATE wifi_users
         SET wifi_status = 'Expired',
             mikrotik_status = ?
         WHERE id = ?`,
        [mikrotikStatus, user.id]
      );
    }
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
  if (req.body?.password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      error: "Invalid admin password."
    });
  }

  const session = createAdminSession();

  return res.json({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt
  });
});

app.get("/api/admin/session", requireAdmin, (req, res) => {
  return res.json({ success: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const token = getAdminToken(req);
  if (token) adminSessions.delete(token);
  return res.json({ success: true });
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


app.post("/api/admin/users/manual", requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const planKey = String(req.body?.plan || "");
  const selectedPlan = plans[planKey];

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Enter a valid customer email." });
  }

  if (!selectedPlan) {
    return res.status(400).json({ error: "Select a valid access plan." });
  }

  const created = new Date();
  const expires = new Date(created.getTime() + selectedPlan.durationMs);
  const username = `CPR${createCode(5)}`;
  const password = createCode(8);
  const manualSession = `manual:${crypto.randomUUID()}`;

  try {
    await mikrotik.createWifiUser({
      username,
      password,
      profile: selectedPlan.profile,
      comment: `TechCPR manual ${selectedPlan.displayName} - ${email}`
    });

    try {
      const result = await db.run(
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
          manualSession,
          null,
          "Manual",
          "Active",
          "Created"
        ]
      );

      return res.status(201).json({
        success: true,
        id: result.id,
        email,
        plan: selectedPlan.displayName,
        username,
        password,
        expires: expires.toISOString()
      });
    } catch (databaseError) {
      try {
        await mikrotik.removeWifiUser(username);
      } catch (rollbackError) {
        console.error(
          `Manual account rollback failed for ${username}:`,
          rollbackError.message
        );
      }

      throw databaseError;
    }
  } catch (error) {
    console.error("Manual customer creation failed:", error);
    return res.status(500).json({
      error: error.message || "Unable to create customer."
    });
  }
});

app.post("/api/admin/users/:id/extend", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const planKey = String(req.body?.plan || "");
  const selectedPlan = plans[planKey];

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid customer ID." });
  }

  if (!selectedPlan) {
    return res.status(400).json({ error: "Select a valid extension plan." });
  }

  try {
    const user = await db.get(
      `SELECT id, email, username, password, expires
       FROM wifi_users
       WHERE id = ?`,
      [userId]
    );

    if (!user) {
      return res.status(404).json({ error: "Customer not found." });
    }

    const currentExpiration = Date.parse(user.expires);
    const baseTime = Number.isFinite(currentExpiration)
      ? Math.max(Date.now(), currentExpiration)
      : Date.now();

    const newExpiration = new Date(baseTime + selectedPlan.durationMs);
    let routerStatus = "Created";
    let routerWarning = null;

    /*
     * Update the application database first. Extending time is an
     * administrative action and should not silently fail just because a
     * historical test user is missing from the router.
     */
    await db.run(
      `UPDATE wifi_users
       SET expires = ?,
           wifi_status = 'Active',
           mikrotik_status = 'Syncing'
       WHERE id = ?`,
      [newExpiration.toISOString(), userId]
    );

    try {
      await mikrotik.enableWifiUser(user.username);
      routerStatus = "Created";
    } catch (enableError) {
      if (/does not exist/i.test(enableError.message)) {
        try {
          await mikrotik.createWifiUser({
            username: user.username,
            password: user.password,
            profile: selectedPlan.profile,
            comment: `TechCPR extended ${selectedPlan.displayName} - ${user.email}`
          });
          routerStatus = "Created";
        } catch (createError) {
          routerStatus = "Provisioning Error";
          routerWarning = createError.message;
        }
      } else {
        routerStatus = "Provisioning Error";
        routerWarning = enableError.message;
      }
    }

    await db.run(
      `UPDATE wifi_users
       SET mikrotik_status = ?,
           wifi_status = ?
       WHERE id = ?`,
      [
        routerStatus,
        routerStatus === "Provisioning Error" ? "Provisioning Error" : "Active",
        userId
      ]
    );

    return res.json({
      success: true,
      expires: newExpiration.toISOString(),
      wifi_status:
        routerStatus === "Provisioning Error" ? "Provisioning Error" : "Active",
      mikrotik_status: routerStatus,
      warning: routerWarning
    });
  } catch (error) {
    console.error("Customer extension failed:", error);
    return res.status(500).json({
      error: error.message || "Unable to extend customer."
    });
  }
});

app.post("/api/admin/users/:id/suspend", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid customer ID." });
  }

  try {
    const user = await db.get(
      "SELECT id, username FROM wifi_users WHERE id = ?",
      [userId]
    );

    if (!user) {
      return res.status(404).json({ error: "Customer not found." });
    }

    const result = await mikrotik.disableWifiUser(user.username);

    await db.run(
      `UPDATE wifi_users
       SET wifi_status = 'Suspended',
           mikrotik_status = ?
       WHERE id = ?`,
      [result.missing ? "Missing" : "Disabled", userId]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("Customer suspension failed:", error);
    return res.status(500).json({
      error: error.message || "Unable to suspend customer."
    });
  }
});

app.post("/api/admin/users/:id/reactivate", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid customer ID." });
  }

  try {
    const user = await db.get(
      `SELECT id, username, expires
       FROM wifi_users
       WHERE id = ?`,
      [userId]
    );

    if (!user) {
      return res.status(404).json({ error: "Customer not found." });
    }

    if (Date.parse(user.expires) <= Date.now()) {
      return res.status(400).json({
        error: "This account is expired. Extend it before reactivating."
      });
    }

    await mikrotik.enableWifiUser(user.username);

    await db.run(
      `UPDATE wifi_users
       SET wifi_status = 'Active',
           mikrotik_status = 'Created'
       WHERE id = ?`,
      [userId]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("Customer reactivation failed:", error);
    return res.status(500).json({
      error: error.message || "Unable to reactivate customer."
    });
  }
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid customer ID." });
  }

  try {
    const user = await db.get(
      "SELECT id, username FROM wifi_users WHERE id = ?",
      [userId]
    );

    if (!user) {
      return res.status(404).json({ error: "Customer not found." });
    }

    await mikrotik.removeWifiUser(user.username);
    await db.run("DELETE FROM wifi_users WHERE id = ?", [userId]);

    return res.json({ success: true });
  } catch (error) {
    console.error("Customer deletion failed:", error);
    return res.status(500).json({
      error: error.message || "Unable to delete customer."
    });
  }
});


app.get("/api/admin/reports", requireAdmin, async (req, res) => {
  try {
    await markExpiredUsers();

    const now = new Date();
    const startToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    const start7 = new Date(startToday.getTime() - 6 * 24 * 60 * 60 * 1000);
    const start30 = new Date(startToday.getTime() - 29 * 24 * 60 * 60 * 1000);

    const paidRows = await db.all(
      `SELECT email, plan, created, payment_status, wifi_status
       FROM wifi_users
       WHERE payment_status = 'Paid'
         AND created >= ?
       ORDER BY created ASC`,
      [start30.toISOString()]
    );

    const accountRows = await db.all(
      `SELECT wifi_status, COUNT(*) AS count
       FROM wifi_users
       GROUP BY wifi_status`
    );

    const priceByPlan = new Map([
      [plans.day.displayName, plans.day.amount],
      [plans.week.displayName, plans.week.amount],
      [plans.month.displayName, plans.month.amount],
      ["24 Hours", plans.day.amount]
    ]);

    function rowAmount(row) {
      return priceByPlan.get(row.plan) || 0;
    }

    function summarizeSince(startDate) {
      const rows = paidRows.filter(row => Date.parse(row.created) >= startDate.getTime());
      return {
        sales: rows.length,
        revenueCents: rows.reduce((sum, row) => sum + rowAmount(row), 0)
      };
    }

    const today = summarizeSince(startToday);
    const last7Days = summarizeSince(start7);
    const last30Days = summarizeSince(start30);

    const planMap = new Map();
    for (const row of paidRows) {
      const key = row.plan || "Unknown";
      const current = planMap.get(key) || {
        plan: key,
        sales: 0,
        revenueCents: 0
      };
      current.sales += 1;
      current.revenueCents += rowAmount(row);
      planMap.set(key, current);
    }

    const trend = [];
    for (let offset = 29; offset >= 0; offset -= 1) {
      const date = new Date(startToday);
      date.setDate(startToday.getDate() - offset);

      const nextDate = new Date(date);
      nextDate.setDate(date.getDate() + 1);

      const rows = paidRows.filter(row => {
        const created = Date.parse(row.created);
        return created >= date.getTime() && created < nextDate.getTime();
      });

      trend.push({
        date: date.toISOString().slice(0, 10),
        sales: rows.length,
        revenueCents: rows.reduce((sum, row) => sum + rowAmount(row), 0)
      });
    }

    const accounts = {};
    for (const row of accountRows) {
      accounts[row.wifi_status || "Unknown"] = Number(row.count || 0);
    }

    return res.json({
      periods: {
        today,
        last7Days,
        last30Days
      },
      plans: [...planMap.values()].sort(
        (a, b) => b.revenueCents - a.revenueCents
      ),
      accounts,
      trend,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Reporting lookup failed:", error);
    return res.status(500).json({ error: "Unable to load reports." });
  }
});

app.get("/api/admin/reports.csv", requireAdmin, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT
         email,
         plan,
         username,
         created,
         expires,
         payment_status,
         wifi_status,
         mikrotik_status
       FROM wifi_users
       ORDER BY created DESC`
    );

    const priceByPlan = new Map([
      [plans.day.displayName, plans.day.amount],
      [plans.week.displayName, plans.week.amount],
      [plans.month.displayName, plans.month.amount],
      ["24 Hours", plans.day.amount]
    ]);

    function csvValue(value) {
      const text = String(value ?? "");
      return `"${text.replace(/"/g, '""')}"`;
    }

    const header = [
      "Email",
      "Plan",
      "Username",
      "Created",
      "Expires",
      "Payment Status",
      "WiFi Status",
      "MikroTik Status",
      "Revenue USD"
    ];

    const lines = [header.map(csvValue).join(",")];

    for (const row of rows) {
      const revenue =
        row.payment_status === "Paid"
          ? ((priceByPlan.get(row.plan) || 0) / 100).toFixed(2)
          : "0.00";

      lines.push([
        row.email,
        row.plan,
        row.username,
        row.created,
        row.expires,
        row.payment_status,
        row.wifi_status,
        row.mikrotik_status,
        revenue
      ].map(csvValue).join(","));
    }

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="techcpr-wifi-report.csv"'
    );
    res.type("text/csv");
    return res.send(lines.join("\r\n"));
  } catch (error) {
    console.error("CSV export failed:", error);
    return res.status(500).json({ error: "Unable to export report." });
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
