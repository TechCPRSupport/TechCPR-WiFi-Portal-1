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

  /*
   * These migrations preserve databases created by earlier project versions.
   */
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
