const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const databasePath =
  process.env.DATABASE_PATH ||
  path.join(__dirname, "techcpr.db");

const connection = new sqlite3.Database(databasePath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        id: this.lastID,
        changes: this.changes
      });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
    });
  });
}

async function columnExists(tableName, columnName) {
  const columns = await all(`PRAGMA table_info(${tableName})`);
  return columns.some(column => column.name === columnName);
}

async function addColumnIfMissing(tableName, columnName, definition) {
  if (!(await columnExists(tableName, columnName))) {
    await run(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`
    );
  }
}

async function initialize() {
  await run("PRAGMA journal_mode = WAL");
  await run("PRAGMA foreign_keys = ON");
  await run("PRAGMA busy_timeout = 5000");

  await run(`
    CREATE TABLE IF NOT EXISTS wifi_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      plan TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      expires TEXT NOT NULL,
      created TEXT NOT NULL,
      stripe_session TEXT NOT NULL,
      stripe_payment_intent TEXT,
      payment_status TEXT NOT NULL DEFAULT 'Paid',
      wifi_status TEXT NOT NULL DEFAULT 'Pending',
      mikrotik_status TEXT NOT NULL DEFAULT 'Pending'
    )
  `);

  await addColumnIfMissing(
    "wifi_users",
    "stripe_payment_intent",
    "TEXT"
  );
  await addColumnIfMissing(
    "wifi_users",
    "mikrotik_status",
    "TEXT NOT NULL DEFAULT 'Pending'"
  );
  await addColumnIfMissing(
    "wifi_users",
    "provision_attempts",
    "INTEGER NOT NULL DEFAULT 0"
  );
  await addColumnIfMissing(
    "wifi_users",
    "last_provision_attempt",
    "TEXT"
  );
  await addColumnIfMissing(
    "wifi_users",
    "last_provision_error",
    "TEXT"
  );
  await addColumnIfMissing(
    "wifi_users",
    "provisioned_at",
    "TEXT"
  );

  await run(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      stripe_session TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      first_received TEXT NOT NULL,
      last_received TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_wifi_users_stripe_session
    ON wifi_users(stripe_session)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_wifi_users_email
    ON wifi_users(email)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_wifi_users_expires
    ON wifi_users(expires)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_session
    ON stripe_webhook_events(stripe_session)
  `);

  const duplicateSessions = await all(`
    SELECT stripe_session, COUNT(*) AS count
    FROM wifi_users
    WHERE stripe_session IS NOT NULL
      AND stripe_session <> ''
    GROUP BY stripe_session
    HAVING COUNT(*) > 1
  `);

  if (!duplicateSessions.length) {
    await run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wifi_users_stripe_session_unique
      ON wifi_users(stripe_session)
    `);
  } else {
    console.warn(
      "Duplicate stripe_session rows detected; unique session protection was not enabled."
    );
  }

  console.log(`TechCPR database ready: ${databasePath}`);
}

function close() {
  return new Promise((resolve, reject) => {
    connection.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

module.exports = {
  initialize,
  run,
  get,
  all,
  close,
  path: databasePath
};
