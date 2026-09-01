const fs = require("fs");
const path = require("path");
require("dotenv").config();

const db = require("../database");

const backupDirectory =
  process.env.BACKUP_DIRECTORY ||
  path.join(__dirname, "..", "backups");

const retentionDays = Math.max(
  1,
  Number(process.env.BACKUP_RETENTION_DAYS || 30)
);

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
}

async function removeOldBackups() {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(backupDirectory, {
    withFileTypes: true
  });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^techcpr-\d{4}-\d{2}-\d{2}T.*\.db$/i.test(entry.name)) continue;

    const fullPath = path.join(backupDirectory, entry.name);
    const stats = await fs.promises.stat(fullPath);

    if (stats.mtimeMs < cutoff) {
      await fs.promises.unlink(fullPath);
      console.log(`Removed expired backup: ${entry.name}`);
    }
  }
}

async function main() {
  await fs.promises.mkdir(backupDirectory, { recursive: true });

  const destination = path.join(
    backupDirectory,
    `techcpr-${timestamp()}.db`
  );

  await db.initialize();

  /*
   * VACUUM INTO creates a consistent SQLite database snapshot, including
   * committed data that may currently reside in WAL mode.
   */
  const escapedDestination = destination.replace(/'/g, "''");
  await db.run(`VACUUM INTO '${escapedDestination}'`);

  await db.close();

  const stats = await fs.promises.stat(destination);

  if (!stats.size) {
    throw new Error("Backup file was created but is empty.");
  }

  console.log(`Database backup created: ${destination}`);
  console.log(`Backup size: ${stats.size} bytes`);

  await removeOldBackups();
}

main().catch(async error => {
  console.error("Database backup failed:", error.message);

  try {
    await db.close();
  } catch {
    // Database may already be closed or may not have initialized.
  }

  process.exitCode = 1;
});
