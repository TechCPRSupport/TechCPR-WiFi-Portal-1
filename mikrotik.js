const { RouterOSAPI } = require("node-routeros");

function getRouterConfig() {
    const requiredVariables = [
        "MIKROTIK_HOST",
        "MIKROTIK_USER",
        "MIKROTIK_PASSWORD"
    ];

    for (const variable of requiredVariables) {
        if (!process.env[variable]) {
            throw new Error(
                `Missing required environment variable: ${variable}`
            );
        }
    }

    return {
        host: process.env.MIKROTIK_HOST,
        user: process.env.MIKROTIK_USER,
        password: process.env.MIKROTIK_PASSWORD,
        port: Number(process.env.MIKROTIK_PORT || 8728),
        timeout: 10
    };
}

async function withConnection(action) {
    const connection = new RouterOSAPI(getRouterConfig());

    try {
        await connection.connect();
        return await action(connection);
    } finally {
        connection.close();
    }
}

async function testConnection() {
    return withConnection(async (connection) => {
        const identity = await connection.write("/system/identity/print");

        return {
            connected: true,
            identity: identity[0]?.name || "Unknown MikroTik"
        };
    });
}

async function getWifiUser(connection, username) {
    const users = await connection.write(
        "/ip/hotspot/user/print",
        [`?name=${username}`]
    );

    return users[0] || null;
}

async function createWifiUser({
    username,
    password,
    profile = "customer",
    comment = "Created by TechCPR WiFi Portal"
}) {
    if (!username || !password) {
        throw new Error(
            "Username and password are required to create a HotSpot user."
        );
    }

    return withConnection(async (connection) => {
        const existingUser = await getWifiUser(connection, username);

        if (existingUser) {
            throw new Error(`HotSpot user already exists: ${username}`);
        }

        await connection.write("/ip/hotspot/user/add", [
            `=name=${username}`,
            `=password=${password}`,
            `=profile=${profile}`,
            `=comment=${comment}`,
            "=disabled=no"
        ]);

        console.log(`MikroTik HotSpot user created: ${username}`);

        return {
            created: true,
            username,
            profile
        };
    });
}

async function disableWifiUser(username) {
    if (!username) {
        throw new Error("Username is required.");
    }

    return withConnection(async (connection) => {
        const existingUser = await getWifiUser(connection, username);

        if (!existingUser) {
            return {
                disabled: false,
                missing: true,
                username
            };
        }

        await connection.write("/ip/hotspot/user/set", [
            `=.id=${existingUser[".id"]}`,
            "=disabled=yes",
            "=comment=Expired by TechCPR WiFi Portal"
        ]);

        const activeSessions = await connection.write(
            "/ip/hotspot/active/print",
            [`?user=${username}`]
        );

        for (const session of activeSessions) {
            await connection.write("/ip/hotspot/active/remove", [
                `=.id=${session[".id"]}`
            ]);
        }

        return {
            disabled: true,
            username,
            disconnectedSessions: activeSessions.length
        };
    });
}

async function enableWifiUser(username) {
    if (!username) {
        throw new Error("Username is required.");
    }

    return withConnection(async (connection) => {
        const existingUser = await getWifiUser(connection, username);

        if (!existingUser) {
            throw new Error(`HotSpot user does not exist: ${username}`);
        }

        await connection.write("/ip/hotspot/user/set", [
            `=.id=${existingUser[".id"]}`,
            "=disabled=no"
        ]);

        return {
            enabled: true,
            username
        };
    });
}

async function removeWifiUser(username) {
    if (!username) {
        throw new Error("Username is required.");
    }

    return withConnection(async (connection) => {
        const existingUser = await getWifiUser(connection, username);

        if (!existingUser) {
            return {
                removed: false,
                missing: true,
                username
            };
        }

        await connection.write("/ip/hotspot/user/remove", [
            `=.id=${existingUser[".id"]}`
        ]);

        return {
            removed: true,
            username
        };
    });
}

async function listWifiUsers() {
    return withConnection(async (connection) => {
        const users = await connection.write("/ip/hotspot/user/print");

        return users.map(user => ({
            id: user[".id"] || null,
            name: user.name || "",
            profile: user.profile || "",
            disabled: String(user.disabled || "false").toLowerCase() === "true",
            comment: user.comment || ""
        }));
    });
}

module.exports = {
    testConnection,
    createWifiUser,
    disableWifiUser,
    enableWifiUser,
    removeWifiUser,
    listWifiUsers
};
