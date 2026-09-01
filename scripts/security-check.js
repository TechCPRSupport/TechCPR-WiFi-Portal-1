require("dotenv").config();

const checks = [];
const warnings = [];
const failures = [];

function ok(message) { checks.push(message); }
function warn(message) { warnings.push(message); }
function fail(message) { failures.push(message); }

const production =
  String(process.env.NODE_ENV || "development").toLowerCase() === "production";

const adminPassword = String(process.env.ADMIN_PASSWORD || "");
const stripeKey = String(process.env.STRIPE_SECRET_KEY || "");
const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "");
const routerPassword = String(process.env.MIKROTIK_PASSWORD || "");
const baseUrl = String(process.env.BASE_URL || "");

if (adminPassword.length >= 16) {
  ok("Administrator password length is acceptable.");
} else {
  fail("ADMIN_PASSWORD must be at least 16 characters.");
}

if (
  adminPassword &&
  !/replace|password|admin|techcpr/i.test(adminPassword)
) {
  ok("Administrator password does not look like a placeholder.");
} else {
  fail("ADMIN_PASSWORD appears weak or placeholder-like.");
}

if (routerPassword && !/replace|password/i.test(routerPassword)) {
  ok("MikroTik API password is configured.");
} else {
  fail("MIKROTIK_PASSWORD is missing or placeholder-like.");
}

if (/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) {
  ok("Stripe webhook signing secret is configured.");
} else {
  fail("STRIPE_WEBHOOK_SECRET is missing or malformed.");
}

if (production) {
  if (baseUrl.startsWith("https://")) {
    ok("Production BASE_URL uses HTTPS.");
  } else {
    fail("Production BASE_URL must use HTTPS.");
  }

  if (stripeKey.startsWith("sk_live_")) {
    ok("Stripe live-mode secret key is configured.");
  } else {
    fail("Production requires STRIPE_SECRET_KEY beginning with sk_live_.");
  }
} else {
  if (stripeKey.startsWith("sk_test_")) {
    ok("Stripe is intentionally operating in test mode.");
  } else if (stripeKey.startsWith("sk_live_")) {
    warn("Live Stripe key detected while NODE_ENV is not production.");
  } else {
    fail("STRIPE_SECRET_KEY is missing or malformed.");
  }

  if (!baseUrl.startsWith("https://")) {
    warn("BASE_URL is not HTTPS. This is acceptable for localhost testing only.");
  }
}

console.log("");
console.log("TechCPR Security Check");
console.log("======================");

for (const message of checks) console.log(`PASS  ${message}`);
for (const message of warnings) console.log(`WARN  ${message}`);
for (const message of failures) console.log(`FAIL  ${message}`);

console.log("");

if (failures.length) {
  console.error(`Security check failed with ${failures.length} issue(s).`);
  process.exit(1);
}

console.log(
  warnings.length
    ? `Security check passed with ${warnings.length} warning(s).`
    : "Security check passed."
);
