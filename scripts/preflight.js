const fs = require("fs");
const path = require("path");
require("dotenv").config();

const requiredVariables = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ADMIN_PASSWORD",
  "MIKROTIK_HOST",
  "MIKROTIK_USER",
  "MIKROTIK_PASSWORD"
];

const missing = requiredVariables.filter(name => !String(process.env[name] || "").trim());

function fail(message) {
  console.error(`[PRESTART] ${message}`);
  process.exitCode = 1;
}

function parseNodeMajor() {
  return Number(process.versions.node.split(".")[0]);
}

if (parseNodeMajor() < 20) {
  fail(`Node.js 20 or newer is required. Current version: ${process.versions.node}`);
}

if (missing.length) {
  fail(`Missing required environment variable(s): ${missing.join(", ")}`);
}

const databasePath =
  process.env.DATABASE_PATH ||
  path.join(__dirname, "..", "techcpr.db");

const databaseDirectory = path.dirname(databasePath);

try {
  fs.mkdirSync(databaseDirectory, { recursive: true });
  fs.accessSync(databaseDirectory, fs.constants.R_OK | fs.constants.W_OK);
} catch (error) {
  fail(`Database directory is not readable/writable: ${databaseDirectory}`);
}

const channelPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "node-routeros",
  "dist",
  "Channel.js"
);

if (!fs.existsSync(channelPath)) {
  fail("node-routeros is not installed. Run npm install.");
} else {
  const source = fs.readFileSync(channelPath, "utf8");

  if (!source.includes("case '!empty':")) {
    fail("RouterOS 7 compatibility patch is not present in node-routeros.");
  } else if (
    !source.includes("case '!empty':\n                break;") &&
    !source.includes("case '!empty':\r\n                break;")
  ) {
    fail("RouterOS 7 !empty handling is not the expected RC5.4.1 behavior.");
  }
}

if (!process.exitCode) {
  console.log("[PRESTART] TechCPR production preflight passed.");
  console.log(`[PRESTART] Node.js ${process.versions.node}`);
  console.log(`[PRESTART] Database: ${databasePath}`);
}
