(() => {
  "use strict";

  const loginPanel = document.getElementById("login-panel");
  const dashboard = document.getElementById("dashboard");
  const passwordInput = document.getElementById("admin-password");
  const loginButton = document.getElementById("login-button");
  const loginMessage = document.getElementById("login-message");
  const adminMessage = document.getElementById("admin-message");
  const usersBody = document.getElementById("users-body");
  const searchInput = document.getElementById("search");
  const planFilter = document.getElementById("plan-filter");
  const statusFilter = document.getElementById("status-filter");
  const refreshButton = document.getElementById("refresh-button");
  const logoutButton = document.getElementById("logout-button");
  const recordCount = document.getElementById("record-count");

  const metricTotal = document.getElementById("metric-total");
  const metricActive = document.getElementById("metric-active");
  const metricExpiring = document.getElementById("metric-expiring");
  const metricPaid = document.getElementById("metric-paid");

  let adminPassword = "";
  let users = [];

  loginButton.addEventListener("click", login);
  passwordInput.addEventListener("keydown", event => {
    if (event.key === "Enter") login();
  });
  refreshButton.addEventListener("click", loadUsers);
  logoutButton.addEventListener("click", logout);
  searchInput.addEventListener("input", render);
  planFilter.addEventListener("change", render);
  statusFilter.addEventListener("change", render);

  async function login() {
    const password = passwordInput.value;

    if (!password) {
      TechCPR.setMessage(loginMessage, "Enter the administrator password.", "error");
      passwordInput.focus();
      return;
    }

    loginButton.disabled = true;
    loginButton.textContent = "Signing In…";

    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Login failed.");
      }

      adminPassword = password;
      loginMessage.textContent = "";
      loginPanel.hidden = true;
      dashboard.hidden = false;
      await loadUsers();
    } catch (error) {
      TechCPR.setMessage(loginMessage, error.message || "Login failed.", "error");
    } finally {
      loginButton.disabled = false;
      loginButton.textContent = "Sign In";
    }
  }

  function logout() {
    adminPassword = "";
    users = [];
    passwordInput.value = "";
    dashboard.hidden = true;
    loginPanel.hidden = false;
    usersBody.replaceChildren();
    searchInput.value = "";
    planFilter.value = "";
    statusFilter.value = "";
    passwordInput.focus();
  }

  async function loadUsers() {
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing…";
    TechCPR.setMessage(adminMessage, "Loading customer records…");

    try {
      const response = await fetch("/api/admin/users", {
        headers: { "x-admin-password": adminPassword },
        cache: "no-store"
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to load customers.");
      }

      users = Array.isArray(data) ? data : [];
      updateMetrics();
      render();
      TechCPR.setMessage(adminMessage, `Loaded ${users.length} customer record(s).`);
    } catch (error) {
      TechCPR.setMessage(
        adminMessage,
        error.message || "Unable to load customers.",
        "error"
      );
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh";
    }
  }

  function updateMetrics() {
    const now = Date.now();
    const next24Hours = now + 24 * 60 * 60 * 1000;

    const active = users.filter(user =>
      String(user.wifi_status || "").toLowerCase() === "active"
    ).length;

    const expiring = users.filter(user => {
      const expires = Date.parse(user.expires);
      return Number.isFinite(expires) && expires > now && expires <= next24Hours;
    }).length;

    const paid = users.filter(user =>
      String(user.payment_status || "").toLowerCase() === "paid"
    ).length;

    metricTotal.textContent = users.length;
    metricActive.textContent = active;
    metricExpiring.textContent = expiring;
    metricPaid.textContent = paid;
  }

  function render() {
    const query = searchInput.value.trim().toLowerCase();
    const selectedPlan = planFilter.value.toLowerCase();
    const selectedStatus = statusFilter.value.toLowerCase();

    const filtered = users.filter(user => {
      const searchText = [
        user.email,
        user.plan,
        user.username,
        user.payment_status,
        user.wifi_status,
        user.mikrotik_status
      ].join(" ").toLowerCase();

      const matchesQuery = !query || searchText.includes(query);
      const matchesPlan =
        !selectedPlan || String(user.plan || "").toLowerCase() === selectedPlan;
      const matchesStatus =
        !selectedStatus ||
        String(user.wifi_status || "").toLowerCase() === selectedStatus;

      return matchesQuery && matchesPlan && matchesStatus;
    });

    if (!filtered.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 8;
      cell.className = "admin-table__empty";
      cell.textContent = users.length
        ? "No customer records match the current filters."
        : "No customer records are available.";
      row.append(cell);
      usersBody.replaceChildren(row);
    } else {
      usersBody.replaceChildren(...filtered.map(createRow));
    }

    recordCount.textContent = `Showing ${filtered.length} of ${users.length} record(s)`;
  }

  function createRow(user) {
    const row = document.createElement("tr");

    row.append(
      textCell(user.email, "admin-table__email"),
      textCell(user.plan),
      textCell(user.username),
      textCell(TechCPR.formatDate(user.expires)),
      badgeCell(user.payment_status),
      badgeCell(user.wifi_status),
      badgeCell(user.mikrotik_status),
      textCell(TechCPR.formatDate(user.created))
    );

    return row;
  }

  function textCell(value, className = "") {
    const cell = document.createElement("td");
    cell.textContent = value ?? "—";
    if (className) cell.className = className;
    if (value) cell.title = String(value);
    return cell;
  }

  function badgeCell(value) {
    const cell = document.createElement("td");
    const badge = document.createElement("span");
    const normalized = String(value || "").toLowerCase();

    badge.className = `badge ${badgeClass(normalized)}`;
    badge.textContent = value || "Unknown";
    cell.append(badge);
    return cell;
  }

  function badgeClass(value) {
    if (["paid", "active", "created", "ok", "connected"].some(word => value.includes(word))) {
      return "badge--success";
    }

    if (["error", "expired", "failed", "unavailable"].some(word => value.includes(word))) {
      return "badge--danger";
    }

    return "badge--warning";
  }
})();
