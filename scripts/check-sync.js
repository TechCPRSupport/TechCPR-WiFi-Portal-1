require("dotenv").config();

const db = require("../database");
const mikrotik = require("../mikrotik");

async function main() {
  await db.initialize();

  const databaseUsers = await db.all(
    `SELECT username, wifi_status, mikrotik_status
     FROM wifi_users
     WHERE wifi_status IN ('Active', 'Suspended', 'Provisioning Error')
     ORDER BY username`
  );

  const routerUsers = await mikrotik.listWifiUsers();

  const routerByName = new Map(
    routerUsers.filter(user => user.name).map(user => [user.name, user])
  );
  const databaseByName = new Map(
    databaseUsers.map(user => [user.username, user])
  );

  const problems = [];

  for (const user of databaseUsers) {
    const routerUser = routerByName.get(user.username);

    if (!routerUser) {
      problems.push(`${user.username}: missing on MikroTik`);
      continue;
    }

    const shouldBeDisabled = user.wifi_status === "Suspended";

    if (routerUser.disabled !== shouldBeDisabled) {
      problems.push(
        `${user.username}: DB=${user.wifi_status}, router disabled=${routerUser.disabled}`
      );
    }
  }

  for (const user of routerUsers) {
    if (
      user.name &&
      /^CPR/i.test(user.name) &&
      !databaseByName.has(user.name)
    ) {
      problems.push(`${user.name}: exists on MikroTik but not in database`);
    }
  }

  console.log(`Database managed users checked: ${databaseUsers.length}`);
  console.log(`MikroTik HotSpot users checked: ${routerUsers.length}`);

  if (!problems.length) {
    console.log("Router/database synchronization check passed.");
  } else {
    console.log("Router/database synchronization differences:");
    for (const problem of problems) {
      console.log(` - ${problem}`);
    }
    process.exitCode = 2;
  }

  await db.close();
}

main().catch(async error => {
  console.error("Synchronization check failed:", error.message);

  try {
    await db.close();
  } catch {
    // Ignore close errors on failed startup.
  }

  process.exitCode = 1;
});
