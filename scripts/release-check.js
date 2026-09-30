const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
require("dotenv").config();

const root = path.join(__dirname, "..");
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

function runNodeScript(label, relativePath) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, relativePath)],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env
    }
  );

  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();

  record(
    label,
    result.status === 0,
    output || `exit code ${result.status}`
  );
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function checkFile(relativePath) {
  record(
    `Required file: ${relativePath}`,
    exists(relativePath),
    exists(relativePath) ? "present" : "missing"
  );
}

function checkEnv(name) {
  const value = String(process.env[name] || "").trim();

  record(
    `Environment: ${name}`,
    Boolean(value),
    value ? "configured" : "missing"
  );
}

function checkGit() {
  const result = spawnSync(
    "git",
    ["status", "--porcelain"],
    {
      cwd: root,
      encoding: "utf8"
    }
  );

  if (result.error) {
    record(
      "Git working tree",
      false,
      result.error.message || "Unable to execute git."
    );
    return;
  }

  if (result.status !== 0) {
    record(
      "Git working tree",
      false,
      (result.stderr || "git status failed").trim()
    );
    return;
  }

  const dirty = String(result.stdout || "").trim();

  record(
    "Git working tree",
    !dirty,
    dirty ? `uncommitted changes:\n${dirty}` : "clean"
  );
}

function checkDatabaseExists() {
  const dbPath =
    process.env.DATABASE_PATH ||
    path.join(root, "techcpr.db");

  const resolved = path.isAbsolute(dbPath)
    ? dbPath
    : path.join(root, dbPath);

  record(
    "SQLite database file",
    fs.existsSync(resolved),
    fs.existsSync(resolved) ? resolved : `missing: ${resolved}`
  );
}

function checkBackupExists() {
  const backupDir =
    process.env.BACKUP_DIRECTORY ||
    path.join(root, "backups");

  if (!fs.existsSync(backupDir)) {
    record(
      "Recent database backup",
      false,
      "backup directory missing"
    );
    return;
  }

  const backups = fs.readdirSync(backupDir)
    .filter(name => /^techcpr-.*\.db$/i.test(name))
    .map(name => ({
      name,
      fullPath: path.join(backupDir, name)
    }))
    .map(item => ({
      ...item,
      mtimeMs: fs.statSync(item.fullPath).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!backups.length) {
    record(
      "Recent database backup",
      false,
      "no backup files found"
    );
    return;
  }

  const newest = backups[0];
  const ageHours = (Date.now() - newest.mtimeMs) / 3600000;

  record(
    "Recent database backup",
    ageHours <= 24,
    `${newest.name} (${ageHours.toFixed(1)} hours old)`
  );
}

[
  "server.js",
  "database.js",
  "mikrotik.js",
  "logger.js",
  "public/plans.html",
  "public/success.html",
  "public/admin.html",
  "public/dashboard.html",
  "public/reports.html",
  "public/recovery.html",
  "scripts/preflight.js",
  "scripts/security-check.js",
  "scripts/check-sync.js",
  "scripts/backup-db.js",
  "scripts/patch-node-routeros.js",
  "scripts/test-webhook-replay.js"
].forEach(checkFile);

[
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ADMIN_PASSWORD",
  "MIKROTIK_HOST",
  "MIKROTIK_USER",
  "MIKROTIK_PASSWORD"
].forEach(checkEnv);

checkDatabaseExists();
checkBackupExists();
checkGit();

runNodeScript(
  "Production preflight",
  "scripts/preflight.js"
);

runNodeScript(
  "Security check",
  "scripts/security-check.js"
);

runNodeScript(
  "Router/database synchronization",
  "scripts/check-sync.js"
);

console.log("");
console.log("TechCPR RC7 Release Candidate Check");
console.log("===================================");

for (const result of results) {
  console.log(
    `${result.ok ? "PASS" : "FAIL"}  ${result.name}`
  );

  if (!result.ok && result.detail) {
    console.log(
      `      ${String(result.detail).replace(/\n/g, "\n      ")}`
    );
  }
}

const failures = results.filter(result => !result.ok);

console.log("");

if (failures.length) {
  console.error(
    `Release candidate check failed with ${failures.length} issue(s).`
  );
  process.exit(1);
}

console.log("Release candidate automated checks passed.");
console.log("");
console.log(
  "Manual production validation: live Stripe checkout, success credentials, " +
  "admin pages, CSV export, graceful Ctrl+C shutdown, and duplicate webhook replay."
);