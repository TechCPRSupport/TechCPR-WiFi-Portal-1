(() => {
  "use strict";

  const loginPanel = document.getElementById("dashboard-login");
  const content = document.getElementById("dashboard-content");
  const passwordInput = document.getElementById("dashboard-password");
  const loginButton = document.getElementById("dashboard-login-button");
  const loginMessage = document.getElementById("dashboard-login-message");
  const refreshButton = document.getElementById("dashboard-refresh");
  const signoutButton = document.getElementById("dashboard-signout");
  const dashboardMessage = document.getElementById("dashboard-message");
  const updated = document.getElementById("dashboard-updated");
  const recent = document.getElementById("recent-purchases");

  let adminPassword = "";

  loginButton.addEventListener("click", login);
  passwordInput.addEventListener("keydown", event => {
    if (event.key === "Enter") login();
  });
  refreshButton.addEventListener("click", loadDashboard);
  signoutButton.addEventListener("click", signOut);

  async function login() {
    const password = passwordInput.value;
    if (!password) {
      TechCPR.setMessage(loginMessage, "Enter the administrator password.", "error");
      return;
    }

    loginButton.disabled = true;
    loginButton.textContent = "Signing In…";

    try {
      await TechCPRAdmin.login(password);
      adminPassword = "";
      loginPanel.hidden = true;
      content.hidden = false;
      await loadDashboard();
    } catch (error) {
      TechCPR.setMessage(loginMessage, error.message || "Login failed.", "error");
    } finally {
      loginButton.disabled = false;
      loginButton.textContent = "Sign In";
    }
  }

  async function signOut() {
    await TechCPRAdmin.logout();
    adminPassword = "";
    passwordInput.value = "";
    content.hidden = true;
    loginPanel.hidden = false;
    passwordInput.focus();
  }

  async function loadDashboard() {
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing…";

    try {
      const response = await fetch("/api/admin/dashboard", {
        headers: TechCPRAdmin.headers(),
        cache: "no-store"
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to load dashboard.");
      }

      document.getElementById("revenue-today").textContent =
        formatMoney(data.metrics.revenueTodayCents);
      document.getElementById("active-customers").textContent =
        data.metrics.activeCustomers;
      document.getElementById("expiring-soon").textContent =
        data.metrics.expiringSoon;
      document.getElementById("total-customers").textContent =
        data.metrics.totalCustomers;

      setSystemBadge("system-server", data.system.server);
      setSystemBadge("system-database", data.system.database);
      setSystemBadge("system-stripe", data.system.stripe);
      setSystemBadge("system-mikrotik", data.system.mikrotik);

      renderRecent(data.recentPurchases || []);
      updated.textContent = `Updated ${TechCPR.formatDate(data.timestamp)}`;
      TechCPR.setMessage(dashboardMessage, "Dashboard is current.");
    } catch (error) {
      TechCPR.setMessage(
        dashboardMessage,
        error.message || "Unable to load dashboard.",
        "error"
      );
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh";
    }
  }

  function formatMoney(cents) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD"
    }).format(Number(cents || 0) / 100);
  }

  function setSystemBadge(id, value) {
    const element = document.getElementById(id);
    const normalized = String(value || "").toLowerCase();
    const healthy =
      ["ok", "configured", "connected"].includes(normalized) ||
      (id === "system-mikrotik" &&
       normalized &&
       !["unavailable", "unknown", "error"].includes(normalized));

    element.textContent = value || "Unknown";
    element.className = `badge ${healthy ? "badge--success" : "badge--warning"}`;
  }

  function renderRecent(items) {
    if (!items.length) {
      recent.innerHTML = '<div class="recent-empty">No purchases yet.</div>';
      return;
    }

    recent.replaceChildren(...items.map(item => {
      const row = document.createElement("div");
      row.className = "recent-purchase";

      const details = document.createElement("div");
      details.className = "recent-purchase__details";

      const title = document.createElement("strong");
      title.textContent = item.plan || "WiFi Access";

      const meta = document.createElement("span");
      meta.textContent = `${item.email || "Unknown"} • ${TechCPR.formatDate(item.created)}`;

      details.append(title, meta);

      const status = document.createElement("span");
      const active = String(item.wifi_status || "").toLowerCase() === "active";
      status.className = `badge ${active ? "badge--success" : "badge--warning"}`;
      status.textContent = item.wifi_status || "Unknown";

      row.append(details, status);
      return row;
    }));
  }
  async function resumeAdminSession() {
    if (!TechCPRAdmin.hasSession()) return;
    if (!await TechCPRAdmin.validate()) return;

    loginPanel.hidden = true;
    content.hidden = false;
    await loadDashboard();
  }

  resumeAdminSession();

})();