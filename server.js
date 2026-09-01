const express = require("express");
const Stripe = require("stripe");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const db = require("./database");
const createCode = require("./generator");
const mikrotik = require("./mikrotik");
const logger = require("./logger");

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
app.use(logger.requestMiddleware);

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

  const paymentIntent =
    typeof session.payment_intent === "string" ? session.payment_intent : null;

  let customer = await db.get(
    `SELECT *
     FROM wifi_users
     WHERE stripe_session = ?`,
    [session.id]
  );

  if (!customer) {
    const username = `CPR${createCode(5)}`;
    const password = createCode(8);
    const created = new Date();
    const expires = new Date(created.getTime() + selectedPlan.durationMs);

    try {
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
          mikrotik_status,
          provision_attempts,
          last_provision_attempt,
          last_provision_error,
          provisioned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          "Pending",
          0,
          null,
          null,
          null
        ]
      );
    } catch (error) {
      if (!/UNIQUE constraint failed.*stripe_session/i.test(error.message)) {
        throw error;
      }

      logger.warn("Concurrent Stripe provisioning insert was deduplicated", {
        stripeSession: session.id
      });
    }

    customer = await db.get(
      `SELECT *
       FROM wifi_users
       WHERE stripe_session = ?`,
      [session.id]
    );
  }

  if (!customer) {
    throw new Error(
      `Unable to create or retrieve WiFi record for Stripe session ${session.id}`
    );
  }

  if (
    customer.wifi_status === "Active" &&
    customer.mikrotik_status === "Created"
  ) {
    logger.info("Stripe session already fully provisioned", {
      stripeSession: session.id,
      userId: customer.id,
      username: customer.username
    });

    return customer;
  }

  const attemptTime = new Date().toISOString();

  await db.run(
    `UPDATE wifi_users
     SET payment_status = 'Paid',
         stripe_payment_intent = COALESCE(?, stripe_payment_intent),
         provision_attempts = COALESCE(provision_attempts, 0) + 1,
         last_provision_attempt = ?,
         last_provision_error = NULL
     WHERE id = ?`,
    [paymentIntent, attemptTime, customer.id]
  );

  try {
    const routerUsers = await mikrotik.listWifiUsers();
    const routerUser = routerUsers.find(
      user => user.name === customer.username
    );

    if (!routerUser) {
      await mikrotik.createWifiUser({
        username: customer.username,
        password: customer.password,
        profile: selectedPlan.profile,
        comment: `TechCPR ${selectedPlan.displayName} - ${email}`
      });
    } else if (routerUser.disabled) {
      await mikrotik.enableWifiUser(customer.username);
    }

    const provisionedAt = new Date().toISOString();

    await db.run(
      `UPDATE wifi_users
       SET wifi_status = 'Active',
           mikrotik_status = 'Created',
           last_provision_error = NULL,
           provisioned_at = COALESCE(provisioned_at, ?)
       WHERE id = ?`,
      [provisionedAt, customer.id]
    );

    logger.info("Provisioned WiFi access for Stripe session", {
      stripeSession: session.id,
      userId: customer.id,
      username: customer.username
    });

    return await db.get(
      "SELECT * FROM wifi_users WHERE id = ?",
      [customer.id]
    );
  } catch (error) {
    const errorMessage = String(error.message || error).slice(0, 250);

    await db.run(
      `UPDATE wifi_users
       SET wifi_status = 'Provisioning Error',
           mikrotik_status = ?,
           last_provision_error = ?
       WHERE id = ?`,
      [errorMessage, errorMessage, customer.id]
    );

    logger.error("Paid customer provisioning failed", {
      stripeSession: session.id,
      userId: customer.id,
      username: customer.username,
      error
    });

    throw error;
  }
}

async function beginWebhookEvent(event) {
  const now = new Date().toISOString();
  const sessionId =
    event.data?.object?.object === "checkout.session"
      ? event.data.object.id
      : null;

  const existing = await db.get(
    "SELECT * FROM stripe_webhook_events WHERE event_id = ?",
    [event.id]
  );

  if (!existing) {
    await db.run(
      `INSERT INTO stripe_webhook_events (
        event_id,
        event_type,
        stripe_session,
        status,
        attempts,
        last_error,
        first_received,
        last_received,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.type,
        sessionId,
        "Processing",
        1,
        null,
        now,
        now,
        null
      ]
    );

    return { alreadyCompleted: false };
  }

  if (existing.status === "Completed") {
    await db.run(
      `UPDATE stripe_webhook_events
       SET last_received = ?
       WHERE event_id = ?`,
      [now, event.id]
    );

    return { alreadyCompleted: true };
  }

  await db.run(
    `UPDATE stripe_webhook_events
     SET status = 'Processing',
         attempts = attempts + 1,
         last_received = ?,
         last_error = NULL
     WHERE event_id = ?`,
    [now, event.id]
  );

  return { alreadyCompleted: false };
}

async function completeWebhookEvent(eventId) {
  const now = new Date().toISOString();

  await db.run(
    `UPDATE stripe_webhook_events
     SET status = 'Completed',
         completed_at = ?,
         last_error = NULL,
         last_received = ?
     WHERE event_id = ?`,
    [now, now, eventId]
  );
}

async function failWebhookEvent(eventId, error) {
  const now = new Date().toISOString();
  const message = String(error.message || error).slice(0, 500);

  await db.run(
    `UPDATE stripe_webhook_events
     SET status = 'Failed',
         last_error = ?,
         last_received = ?
     WHERE event_id = ?`,
    [message, now, eventId]
  );
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
      const eventState = await beginWebhookEvent(event);

      if (eventState.alreadyCompleted) {
        logger.info("Duplicate completed Stripe webhook ignored", {
          eventId: event.id,
          eventType: event.type
        });

        return res.json({
          received: true,
          duplicate: true
        });
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        if (session.payment_status === "paid") {
          await provisionCompletedCheckout(session);
        }
      }

      await completeWebhookEvent(event.id);

      return res.json({ received: true });
    } catch (error) {
      try {
        await failWebhookEvent(event.id, error);
      } catch (trackingError) {
        logger.error("Unable to record Stripe webhook failure", {
          eventId: event.id,
          error: trackingError
        });
      }

      logger.error("Stripe webhook processing error", {
        eventId: event.id,
        eventType: event.type,
        error
      });

      /*
       * Return 500 so Stripe retries. The retry is safe because both the
       * webhook event and stripe_session are now idempotent.
       */
      return res.status(500).json({
        error: "Webhook processing failed and will be retried."
      });
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



async function buildSyncStatus() {
  const [databaseUsers, routerUsers] = await Promise.all([
    db.all(
      `SELECT id, email, plan, username, password, wifi_status,
              mikrotik_status, expires
       FROM wifi_users
       WHERE wifi_status IN ('Active', 'Suspended', 'Provisioning Error')
       ORDER BY username`
    ),
    mikrotik.listWifiUsers()
  ]);

  const routerByName = new Map(
    routerUsers.filter(user => user.name).map(user => [user.name, user])
  );
  const databaseByName = new Map(
    databaseUsers.map(user => [user.username, user])
  );

  const missingOnRouter = databaseUsers
    .filter(user => !routerByName.has(user.username))
    .map(user => ({
      id: user.id,
      username: user.username,
      email: user.email,
      plan: user.plan,
      wifiStatus: user.wifi_status,
      mikrotikStatus: user.mikrotik_status
    }));

  const stateMismatches = databaseUsers
    .filter(user => {
      const routerUser = routerByName.get(user.username);
      if (!routerUser) return false;

      const shouldBeDisabled = user.wifi_status === "Suspended";
      return routerUser.disabled !== shouldBeDisabled;
    })
    .map(user => {
      const routerUser = routerByName.get(user.username);

      return {
        id: user.id,
        username: user.username,
        email: user.email,
        wifiStatus: user.wifi_status,
        routerDisabled: routerUser.disabled
      };
    });

  const orphanedRouterUsers = routerUsers
    .filter(user =>
      user.name &&
      /^CPR/i.test(user.name) &&
      !databaseByName.has(user.name)
    )
    .map(user => ({
      username: user.name,
      disabled: user.disabled,
      profile: user.profile,
      comment: user.comment
    }));

  return {
    healthy:
      missingOnRouter.length === 0 &&
      stateMismatches.length === 0 &&
      orphanedRouterUsers.length === 0,
    databaseUsersChecked: databaseUsers.length,
    routerUsersChecked: routerUsers.length,
    missingOnRouter,
    stateMismatches,
    orphanedRouterUsers,
    timestamp: new Date().toISOString()
  };
}

app.get("/api/admin/sync-status", requireAdmin, async (req, res) => {
  try {
    return res.json(await buildSyncStatus());
  } catch (error) {
    logger.error("Router/database sync check failed", { error });
    return res.status(500).json({
      error: "Unable to compare database and MikroTik users."
    });
  }
});

app.post("/api/admin/recovery/users/:id/repair", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const confirmation = String(req.body?.confirmation || "");

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid customer ID." });
  }

  if (confirmation !== "REPAIR") {
    return res.status(400).json({
      error: 'Recovery requires confirmation value "REPAIR".'
    });
  }

  try {
    const user = await db.get(
      `SELECT id, email, plan, username, password, wifi_status,
              mikrotik_status, expires
       FROM wifi_users
       WHERE id = ?`,
      [userId]
    );

    if (!user) {
      return res.status(404).json({ error: "Customer not found." });
    }

    if (!["Active", "Suspended", "Provisioning Error"].includes(user.wifi_status)) {
      return res.status(400).json({
        error: `Customer status ${user.wifi_status} is not eligible for recovery.`
      });
    }

    if (Date.parse(user.expires) <= Date.now()) {
      return res.status(400).json({
        error: "Expired accounts must be extended before router recovery."
      });
    }

    const routerUsers = await mikrotik.listWifiUsers();
    const routerUser = routerUsers.find(item => item.name === user.username);
    const planEntry = Object.values(plans).find(
      plan => plan.displayName === user.plan
    );
    const profile =
      planEntry?.profile ||
      process.env.MIKROTIK_CUSTOMER_PROFILE ||
      "customer";

    let action = "";

    if (!routerUser) {
      await mikrotik.createWifiUser({
        username: user.username,
        password: user.password,
        profile,
        comment: `Recovered by TechCPR - ${user.email}`
      });

      action = "recreated";

      if (user.wifi_status === "Suspended") {
        await mikrotik.disableWifiUser(user.username);
        action = "recreated-disabled";
      }
    } else if (user.wifi_status === "Suspended" && !routerUser.disabled) {
      await mikrotik.disableWifiUser(user.username);
      action = "disabled";
    } else if (
      ["Active", "Provisioning Error"].includes(user.wifi_status) &&
      routerUser.disabled
    ) {
      await mikrotik.enableWifiUser(user.username);
      action = "enabled";
    } else {
      action = "already-correct";
    }

    const finalWifiStatus =
      user.wifi_status === "Suspended" ? "Suspended" : "Active";
    const finalMikrotikStatus =
      finalWifiStatus === "Suspended" ? "Disabled" : "Created";

    await db.run(
      `UPDATE wifi_users
       SET wifi_status = ?,
           mikrotik_status = ?
       WHERE id = ?`,
      [finalWifiStatus, finalMikrotikStatus, userId]
    );

    logger.info("Router recovery completed", {
      userId,
      username: user.username,
      action
    });

    return res.json({
      success: true,
      action,
      username: user.username,
      wifiStatus: finalWifiStatus,
      mikrotikStatus: finalMikrotikStatus,
      sync: await buildSyncStatus()
    });
  } catch (error) {
    logger.error("Router recovery failed", {
      userId,
      error
    });

    return res.status(500).json({
      error: error.message || "Unable to repair customer router state."
    });
  }
});

app.post(
  "/api/admin/recovery/orphans/:username/disable",
  requireAdmin,
  async (req, res) => {
    const username = String(req.params.username || "").trim();
    const confirmation = String(req.body?.confirmation || "");

    if (!/^CPR[A-Z0-9]+$/i.test(username)) {
      return res.status(400).json({
        error: "Only TechCPR-managed HotSpot usernames may be quarantined."
      });
    }

    if (confirmation !== "DISABLE") {
      return res.status(400).json({
        error: 'Quarantine requires confirmation value "DISABLE".'
      });
    }

    try {
      const databaseUser = await db.get(
        "SELECT id FROM wifi_users WHERE username = ?",
        [username]
      );

      if (databaseUser) {
        return res.status(409).json({
          error: "This username exists in the database and is not an orphan."
        });
      }

      const result = await mikrotik.disableWifiUser(username);

      if (result.missing) {
        return res.status(404).json({
          error: "The orphaned router user no longer exists."
        });
      }

      logger.warn("Orphaned MikroTik user quarantined", {
        username
      });

      return res.json({
        success: true,
        action: "disabled",
        username,
        sync: await buildSyncStatus()
      });
    } catch (error) {
      logger.error("Orphan quarantine failed", {
        username,
        error
      });

      return res.status(500).json({
        error: error.message || "Unable to quarantine orphaned router user."
      });
    }
  }
);


const MAINTENANCE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.MAINTENANCE_INTERVAL_MS || 5 * 60_000)
);
const MAINTENANCE_MAX_REPAIRS = Math.max(
  1,
  Number(process.env.MAINTENANCE_MAX_REPAIRS || 10)
);
const MAINTENANCE_AUTO_REPAIR =
  String(process.env.MAINTENANCE_AUTO_REPAIR || "true").toLowerCase() !== "false";

const maintenanceState = {
  running: false,
  enabled: true,
  autoRepair: MAINTENANCE_AUTO_REPAIR,
  intervalMs: MAINTENANCE_INTERVAL_MS,
  lastRunAt: null,
  lastResult: "Waiting",
  lastDifferences: null,
  lastRepairs: 0,
  lastError: null
};

async function repairManagedUserAutomatically(userId) {
  const user = await db.get(
    `SELECT id, email, plan, username, password, wifi_status,
            mikrotik_status, expires
     FROM wifi_users
     WHERE id = ?`,
    [userId]
  );

  if (!user) {
    return { userId, action: "skipped-missing-database-record" };
  }

  if (!["Active", "Suspended", "Provisioning Error"].includes(user.wifi_status)) {
    return { userId, username: user.username, action: "skipped-status" };
  }

  if (Date.parse(user.expires) <= Date.now()) {
    return { userId, username: user.username, action: "skipped-expired" };
  }

  const routerUsers = await mikrotik.listWifiUsers();
  const routerUser = routerUsers.find(item => item.name === user.username);

  const planEntry = Object.values(plans).find(
    plan => plan.displayName === user.plan
  );

  const profile =
    planEntry?.profile ||
    process.env.MIKROTIK_CUSTOMER_PROFILE ||
    "customer";

  let action = "already-correct";

  if (!routerUser) {
    await mikrotik.createWifiUser({
      username: user.username,
      password: user.password,
      profile,
      comment: `Auto-recovered by TechCPR - ${user.email}`
    });

    action = "recreated";

    if (user.wifi_status === "Suspended") {
      await mikrotik.disableWifiUser(user.username);
      action = "recreated-disabled";
    }
  } else if (user.wifi_status === "Suspended" && !routerUser.disabled) {
    await mikrotik.disableWifiUser(user.username);
    action = "disabled";
  } else if (
    ["Active", "Provisioning Error"].includes(user.wifi_status) &&
    routerUser.disabled
  ) {
    await mikrotik.enableWifiUser(user.username);
    action = "enabled";
  }

  const finalWifiStatus =
    user.wifi_status === "Suspended" ? "Suspended" : "Active";
  const finalMikrotikStatus =
    finalWifiStatus === "Suspended" ? "Disabled" : "Created";

  await db.run(
    `UPDATE wifi_users
     SET wifi_status = ?,
         mikrotik_status = ?
     WHERE id = ?`,
    [finalWifiStatus, finalMikrotikStatus, userId]
  );

  return {
    userId,
    username: user.username,
    action,
    wifiStatus: finalWifiStatus,
    mikrotikStatus: finalMikrotikStatus
  };
}

async function runMaintenanceCycle({ source = "scheduled", allowRepair = true } = {}) {
  if (maintenanceState.running) {
    return {
      skipped: true,
      reason: "Maintenance cycle already running.",
      state: { ...maintenanceState }
    };
  }

  maintenanceState.running = true;
  maintenanceState.lastError = null;

  const startedAt = new Date();

  try {
    await markExpiredUsers();

    const before = await buildSyncStatus();
    const repairCandidates = new Map();

    for (const item of before.missingOnRouter) {
      repairCandidates.set(item.id, item);
    }

    for (const item of before.stateMismatches) {
      repairCandidates.set(item.id, item);
    }

    const repaired = [];

    if (allowRepair && MAINTENANCE_AUTO_REPAIR) {
      for (const userId of [...repairCandidates.keys()].slice(
        0,
        MAINTENANCE_MAX_REPAIRS
      )) {
        try {
          const result = await repairManagedUserAutomatically(userId);
          repaired.push(result);

          logger.info("Automatic lifecycle repair completed", {
            source,
            userId,
            username: result.username,
            action: result.action
          });
        } catch (error) {
          logger.error("Automatic lifecycle repair failed", {
            source,
            userId,
            error
          });
        }
      }
    }

    const after =
      repaired.length > 0 ? await buildSyncStatus() : before;

    const remainingDifferences =
      after.missingOnRouter.length +
      after.stateMismatches.length +
      after.orphanedRouterUsers.length;

    maintenanceState.lastRunAt = new Date().toISOString();
    maintenanceState.lastRepairs = repaired.length;
    maintenanceState.lastDifferences = remainingDifferences;
    maintenanceState.lastResult =
      remainingDifferences === 0 ? "Healthy" : "Review";

    logger.info("Lifecycle maintenance cycle completed", {
      source,
      autoRepair: MAINTENANCE_AUTO_REPAIR,
      repaired: repaired.length,
      differences: remainingDifferences,
      durationMs: Date.now() - startedAt.getTime()
    });

    return {
      success: true,
      source,
      autoRepair: MAINTENANCE_AUTO_REPAIR,
      repaired,
      sync: after,
      state: { ...maintenanceState }
    };
  } catch (error) {
    maintenanceState.lastRunAt = new Date().toISOString();
    maintenanceState.lastResult = "Error";
    maintenanceState.lastError = error.message;

    logger.error("Lifecycle maintenance cycle failed", {
      source,
      error
    });

    throw error;
  } finally {
    maintenanceState.running = false;
  }
}

app.get("/api/admin/maintenance-status", requireAdmin, (req, res) => {
  return res.json({
    ...maintenanceState,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/admin/maintenance/run", requireAdmin, async (req, res) => {
  try {
    const result = await runMaintenanceCycle({
      source: "admin",
      allowRepair: true
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Unable to run lifecycle maintenance."
    });
  }
});


app.get("/api/admin/provisioning-status", requireAdmin, async (req, res) => {
  try {
    const failedUsers = await db.all(
      `SELECT
         id,
         email,
         plan,
         username,
         stripe_session,
         wifi_status,
         mikrotik_status,
         provision_attempts,
         last_provision_attempt,
         last_provision_error
       FROM wifi_users
       WHERE payment_status = 'Paid'
         AND wifi_status IN ('Pending', 'Provisioning Error')
       ORDER BY created DESC`
    );

    const failedEvents = await db.all(
      `SELECT
         event_id,
         event_type,
         stripe_session,
         status,
         attempts,
         last_error,
         first_received,
         last_received
       FROM stripe_webhook_events
       WHERE status = 'Failed'
       ORDER BY last_received DESC
       LIMIT 25`
    );

    return res.json({
      healthy: failedUsers.length === 0 && failedEvents.length === 0,
      failedUsers,
      failedEvents,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error("Provisioning status lookup failed", { error });
    return res.status(500).json({
      error: "Unable to load provisioning status."
    });
  }
});

app.post(
  "/api/admin/provisioning/users/:id/retry",
  requireAdmin,
  async (req, res) => {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "Invalid customer ID." });
    }

    try {
      const user = await db.get(
        `SELECT *
         FROM wifi_users
         WHERE id = ?`,
        [userId]
      );

      if (!user) {
        return res.status(404).json({ error: "Customer not found." });
      }

      if (user.payment_status !== "Paid") {
        return res.status(400).json({
          error: "Only paid customer provisioning may be retried."
        });
      }

      const planKey = Object.entries(plans).find(
        ([, plan]) => plan.displayName === user.plan
      )?.[0];

      if (!planKey) {
        return res.status(400).json({
          error: `Unable to map stored plan: ${user.plan}`
        });
      }

      const syntheticSession = {
        id: user.stripe_session,
        metadata: { plan: planKey },
        customer_details: { email: user.email },
        customer_email: user.email,
        payment_intent: user.stripe_payment_intent,
        payment_status: "paid"
      };

      const result = await provisionCompletedCheckout(syntheticSession);

      logger.info("Admin provisioning retry completed", {
        userId,
        stripeSession: user.stripe_session,
        username: user.username
      });

      return res.json({
        success: true,
        id: result.id,
        username: result.username,
        wifiStatus: result.wifi_status,
        mikrotikStatus: result.mikrotik_status
      });
    } catch (error) {
      logger.error("Admin provisioning retry failed", {
        userId,
        error
      });

      return res.status(500).json({
        error: error.message || "Unable to retry provisioning."
      });
    }
  }
);

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
      maintenance: {
        enabled: maintenanceState.enabled,
        autoRepair: maintenanceState.autoRepair,
        running: maintenanceState.running,
        lastRunAt: maintenanceState.lastRunAt,
        lastResult: maintenanceState.lastResult,
        lastDifferences: maintenanceState.lastDifferences,
        lastRepairs: maintenanceState.lastRepairs,
        lastError: maintenanceState.lastError
      },
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

let httpServer = null;
let expirationTimer = null;
let maintenanceTimer = null;
let maintenanceInitialTimer = null;
let shuttingDown = false;

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("TechCPR shutdown started", { reason, exitCode });

  if (expirationTimer) {
    clearInterval(expirationTimer);
    expirationTimer = null;
  }

  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }

  if (maintenanceInitialTimer) {
    clearTimeout(maintenanceInitialTimer);
    maintenanceInitialTimer = null;
  }

  if (httpServer) {
    await new Promise(resolve => {
      const forceTimer = setTimeout(() => {
        logger.warn("HTTP shutdown timeout reached; continuing shutdown.");
        resolve();
      }, 8_000);

      forceTimer.unref();

      httpServer.close(() => {
        clearTimeout(forceTimer);
        resolve();
      });
    });
  }

  try {
    await db.close();
    logger.info("SQLite connection closed.");
  } catch (error) {
    logger.error("SQLite close failed", { error });
    exitCode = exitCode || 1;
  }

  logger.info("TechCPR shutdown complete", { reason, exitCode });
  process.exit(exitCode);
}

async function start() {
  await db.initialize();
  await markExpiredUsers();

  expirationTimer = setInterval(markExpiredUsers, 60_000);
  expirationTimer.unref();

  maintenanceInitialTimer = setTimeout(() => {
    runMaintenanceCycle({
      source: "startup",
      allowRepair: true
    }).catch(error => {
      logger.error("Startup lifecycle maintenance failed", { error });
    });
  }, 15_000);
  maintenanceInitialTimer.unref();

  maintenanceTimer = setInterval(() => {
    runMaintenanceCycle({
      source: "scheduled",
      allowRepair: true
    }).catch(error => {
      logger.error("Scheduled lifecycle maintenance failed", { error });
    });
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();

  httpServer = app.listen(port, () => {
    logger.info("TechCPR server started", {
      baseUrl,
      node: process.versions.node,
      pid: process.pid
    });
  });
}

process.on("SIGINT", () => {
  shutdown("SIGINT", 0);
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM", 0);
});

process.on("uncaughtException", error => {
  logger.error("Uncaught exception", { error });
  shutdown("uncaughtException", 1);
});

process.on("unhandledRejection", reason => {
  logger.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason : new Error(String(reason))
  });
  shutdown("unhandledRejection", 1);
});

start().catch(error => {
  logger.error("TechCPR server failed to start", { error });
  shutdown("startup failure", 1);
});
