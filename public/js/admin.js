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
  const metricSuspended = document.getElementById("metric-suspended");

  const manualPanel = document.getElementById("manual-panel");
  const newCustomerButton = document.getElementById("new-customer-button");
  const closeManualButton = document.getElementById("close-manual-button");
  const manualEmail = document.getElementById("manual-email");
  const manualPlan = document.getElementById("manual-plan");
  const createCustomerButton = document.getElementById("create-customer-button");
  const manualResult = document.getElementById("manual-result");

  const extendDialog = document.getElementById("extend-dialog");
  const extendCustomerName = document.getElementById("extend-customer-name");
  const extendPlan = document.getElementById("extend-plan");
  const confirmExtendButton = document.getElementById("confirm-extend-button");
  const extendMessage = document.getElementById("extend-message");

  let adminPassword = "";
  let users = [];
  let extendingUserId = null;

  loginButton.addEventListener("click", login);
  passwordInput.addEventListener("keydown", event => {
    if (event.key === "Enter") login();
  });
  refreshButton.addEventListener("click", loadUsers);
  logoutButton.addEventListener("click", logout);
  searchInput.addEventListener("input", render);
  planFilter.addEventListener("change", render);
  statusFilter.addEventListener("change", render);

  newCustomerButton.addEventListener("click", () => {
    manualPanel.hidden = false;
    manualEmail.focus();
  });
  closeManualButton.addEventListener("click", () => {
    manualPanel.hidden = true;
    manualResult.hidden = true;
  });
  createCustomerButton.addEventListener("click", createManualCustomer);
  confirmExtendButton.addEventListener("click", extendCustomer);
  extendDialog.addEventListener("close", () => {
    extendingUserId = null;
    extendMessage.textContent = "";
    extendMessage.className = "dialog-message";
  });

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
    manualPanel.hidden = true;
    passwordInput.focus();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "x-admin-password": adminPassword,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }

    return data;
  }

  async function loadUsers() {
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing…";
    TechCPR.setMessage(adminMessage, "Loading customer records…");

    try {
      users = await api("/api/admin/users", { cache: "no-store" });
      users = Array.isArray(users) ? users : [];
      updateMetrics();
      render();
      TechCPR.setMessage(adminMessage, `Loaded ${users.length} customer record(s).`);
    } catch (error) {
      TechCPR.setMessage(adminMessage, error.message, "error");
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh";
    }
  }

  function updateMetrics() {
    const now = Date.now();
    const next24Hours = now + 24 * 60 * 60 * 1000;

    metricTotal.textContent = users.length;
    metricActive.textContent = users.filter(user =>
      normalize(user.wifi_status) === "active"
    ).length;
    metricSuspended.textContent = users.filter(user =>
      normalize(user.wifi_status) === "suspended"
    ).length;
    metricExpiring.textContent = users.filter(user => {
      const expires = Date.parse(user.expires);
      return Number.isFinite(expires) && expires > now && expires <= next24Hours;
    }).length;
  }

  function render() {
    const query = normalize(searchInput.value);
    const selectedPlan = normalize(planFilter.value);
    const selectedStatus = normalize(statusFilter.value);

    const filtered = users.filter(user => {
      const searchText = normalize([
        user.email,
        user.plan,
        user.username,
        user.payment_status,
        user.wifi_status,
        user.mikrotik_status
      ].join(" "));

      return (!query || searchText.includes(query)) &&
        (!selectedPlan || normalize(user.plan) === selectedPlan) &&
        (!selectedStatus || normalize(user.wifi_status) === selectedStatus);
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
      actionCell(user)
    );
    return row;
  }

  function actionCell(user) {
    const cell = document.createElement("td");
    const group = document.createElement("div");
    group.className = "customer-actions";

    group.append(
      actionButton("Extend", "button--secondary", () => openExtend(user))
    );

    const status = normalize(user.wifi_status);

    if (status === "active") {
      group.append(
        actionButton("Suspend", "button--secondary", () => suspendUser(user))
      );
    } else if (status === "suspended" && Date.parse(user.expires) > Date.now()) {
      group.append(
        actionButton("Activate", "button--secondary", () => reactivateUser(user))
      );
    }

    group.append(
      actionButton("Delete", "button--danger", () => deleteUser(user))
    );

    cell.append(group);
    return cell;
  }

  function actionButton(label, className, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mini-button ${className}`;
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function openExtend(user) {
    extendingUserId = user.id;
    extendCustomerName.textContent =
      `${user.email} • ${user.username} • expires ${TechCPR.formatDate(user.expires)}`;
    extendPlan.value = "day";
    extendMessage.textContent = "";
    extendMessage.className = "dialog-message";
    extendDialog.showModal();
  }

  async function extendCustomer() {
    if (!extendingUserId) {
      extendMessage.textContent = "No customer is selected.";
      extendMessage.className = "dialog-message dialog-message--error";
      return;
    }

    confirmExtendButton.disabled = true;
    confirmExtendButton.textContent = "Extending…";
    extendMessage.textContent = "Updating expiration and synchronizing the router…";
    extendMessage.className = "dialog-message";

    try {
      const result = await api(`/api/admin/users/${extendingUserId}/extend`, {
        method: "POST",
        body: JSON.stringify({ plan: extendPlan.value })
      });

      if (result.warning) {
        extendMessage.textContent =
          `Expiration was extended, but MikroTik sync needs attention: ${result.warning}`;
        extendMessage.className = "dialog-message dialog-message--warning";
        TechCPR.setMessage(
          adminMessage,
          "Access time extended, but MikroTik provisioning needs attention.",
          "error"
        );
        await loadUsers();
        return;
      }

      extendMessage.textContent =
        `Access extended through ${TechCPR.formatDate(result.expires)}.`;
      extendMessage.className = "dialog-message dialog-message--success";

      await loadUsers();

      setTimeout(() => {
        extendDialog.close();
        extendingUserId = null;
        TechCPR.setMessage(adminMessage, "Customer access extended.");
      }, 650);
    } catch (error) {
      extendMessage.textContent = error.message || "Unable to extend customer.";
      extendMessage.className = "dialog-message dialog-message--error";
    } finally {
      confirmExtendButton.disabled = false;
      confirmExtendButton.textContent = "Extend Access";
    }
  }

  async function suspendUser(user) {
    if (!confirm(`Suspend WiFi access for ${user.email}?`)) return;

    try {
      await api(`/api/admin/users/${user.id}/suspend`, { method: "POST" });
      TechCPR.setMessage(adminMessage, "Customer suspended.");
      await loadUsers();
    } catch (error) {
      TechCPR.setMessage(adminMessage, error.message, "error");
    }
  }

  async function reactivateUser(user) {
    try {
      await api(`/api/admin/users/${user.id}/reactivate`, { method: "POST" });
      TechCPR.setMessage(adminMessage, "Customer reactivated.");
      await loadUsers();
    } catch (error) {
      TechCPR.setMessage(adminMessage, error.message, "error");
    }
  }

  async function deleteUser(user) {
    const confirmed = confirm(
      `Permanently delete ${user.email} and remove ${user.username} from the router?`
    );
    if (!confirmed) return;

    try {
      await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
      TechCPR.setMessage(adminMessage, "Customer deleted.");
      await loadUsers();
    } catch (error) {
      TechCPR.setMessage(adminMessage, error.message, "error");
    }
  }

  async function createManualCustomer() {
    const email = manualEmail.value.trim();

    if (!email) {
      TechCPR.setMessage(adminMessage, "Enter a customer email.", "error");
      return;
    }

    createCustomerButton.disabled = true;
    createCustomerButton.textContent = "Creating…";

    try {
      const data = await api("/api/admin/users/manual", {
        method: "POST",
        body: JSON.stringify({
          email,
          plan: manualPlan.value
        })
      });

      manualResult.hidden = false;
      manualResult.innerHTML = "";

      const title = document.createElement("strong");
      title.textContent = "Account created";

      const details = document.createElement("span");
      details.textContent =
        `Username: ${data.username} • Password: ${data.password} • Expires: ${TechCPR.formatDate(data.expires)}`;

      manualResult.append(title, details);
      manualEmail.value = "";
      TechCPR.setMessage(adminMessage, "Manual customer created.");
      await loadUsers();
    } catch (error) {
      TechCPR.setMessage(adminMessage, error.message, "error");
    } finally {
      createCustomerButton.disabled = false;
      createCustomerButton.textContent = "Create Account";
    }
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
    const normalized = normalize(value);

    badge.className = `badge ${badgeClass(normalized)}`;
    badge.textContent = value || "Unknown";
    cell.append(badge);
    return cell;
  }

  function badgeClass(value) {
    if (["paid", "manual", "active", "created", "ok", "connected"].some(word =>
      value.includes(word)
    )) {
      return "badge--success";
    }

    if (["error", "expired", "failed", "unavailable"].some(word =>
      value.includes(word)
    )) {
      return "badge--danger";
    }

    return "badge--warning";
  }

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }
})();
