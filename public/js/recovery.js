(() => {
  "use strict";

  const loginPanel = document.getElementById("recovery-login");
  const content = document.getElementById("recovery-content");
  const passwordInput = document.getElementById("recovery-password");
  const loginButton = document.getElementById("recovery-login-button");
  const loginMessage = document.getElementById("recovery-login-message");
  const refreshButton = document.getElementById("recovery-refresh");
  const signoutButton = document.getElementById("recovery-signout");
  const message = document.getElementById("recovery-message");
  const updated = document.getElementById("recovery-updated");

  const missingUsers = document.getElementById("missing-users");
  const stateMismatches = document.getElementById("state-mismatches");
  const orphanUsers = document.getElementById("orphan-users");

  loginButton.addEventListener("click", login);
  passwordInput.addEventListener("keydown", event => {
    if (event.key === "Enter") login();
  });
  refreshButton.addEventListener("click", loadSyncStatus);
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
      loginPanel.hidden = true;
      content.hidden = false;
      await loadSyncStatus();
    } catch (error) {
      TechCPR.setMessage(loginMessage, error.message || "Login failed.", "error");
    } finally {
      loginButton.disabled = false;
      loginButton.textContent = "Sign In";
    }
  }

  async function signOut() {
    await TechCPRAdmin.logout();
    passwordInput.value = "";
    content.hidden = true;
    loginPanel.hidden = false;
    passwordInput.focus();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: TechCPRAdmin.headers({
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }

    return data;
  }

  async function loadSyncStatus() {
    refreshButton.disabled = true;
    refreshButton.textContent = "Scanning…";
    TechCPR.setMessage(message, "Comparing SQLite and MikroTik…");

    try {
      const data = await api("/api/admin/sync-status", { cache: "no-store" });
      render(data);
      TechCPR.setMessage(
        message,
        data.healthy
          ? "Router and database synchronization is healthy."
          : "Differences found. Review each item before using a repair action.",
        data.healthy ? "success" : "error"
      );
    } catch (error) {
      TechCPR.setMessage(message, error.message, "error");
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Scan Again";
    }
  }

  function render(data) {
    const missing = data.missingOnRouter || [];
    const mismatches = data.stateMismatches || [];
    const orphans = data.orphanedRouterUsers || [];
    const differenceCount = missing.length + mismatches.length + orphans.length;

    document.getElementById("sync-health").textContent =
      data.healthy ? "Healthy" : "Review";
    document.getElementById("sync-db-count").textContent =
      data.databaseUsersChecked || 0;
    document.getElementById("sync-router-count").textContent =
      data.routerUsersChecked || 0;
    document.getElementById("sync-difference-count").textContent =
      differenceCount;

    updated.textContent = `Updated ${TechCPR.formatDate(data.timestamp)}`;

    renderRepairable(
      missingUsers,
      missing,
      item => `${item.username} • ${item.email || ""} • ${item.wifiStatus}`,
      "Recreate / Repair"
    );

    renderRepairable(
      stateMismatches,
      mismatches,
      item =>
        `${item.username} • DB ${item.wifiStatus} • Router ${item.routerDisabled ? "Disabled" : "Enabled"}`,
      "Correct State"
    );

    renderOrphans(orphans);
  }

  function renderRepairable(container, items, labelBuilder, buttonLabel) {
    container.replaceChildren();

    if (!items.length) {
      container.append(emptyRow("No differences found."));
      return;
    }

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "recovery-row";

      const text = document.createElement("div");
      text.className = "recovery-row__text";

      const title = document.createElement("strong");
      title.textContent = item.username;

      const detail = document.createElement("span");
      detail.textContent = labelBuilder(item);

      text.append(title, detail);

      const button = document.createElement("button");
      button.className = "button button--secondary recovery-action";
      button.type = "button";
      button.textContent = buttonLabel;
      button.addEventListener("click", () => repairUser(item, button));

      row.append(text, button);
      container.append(row);
    }
  }

  function renderOrphans(items) {
    orphanUsers.replaceChildren();

    if (!items.length) {
      orphanUsers.append(emptyRow("No orphaned TechCPR router users found."));
      return;
    }

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "recovery-row";

      const text = document.createElement("div");
      text.className = "recovery-row__text";

      const title = document.createElement("strong");
      title.textContent = item.username;

      const detail = document.createElement("span");
      detail.textContent =
        `${item.disabled ? "Disabled" : "Enabled"} • Profile ${item.profile || "Unknown"}`;

      text.append(title, detail);

      const button = document.createElement("button");
      button.className = "button button--danger recovery-action";
      button.type = "button";
      button.disabled = item.disabled;
      button.textContent = item.disabled ? "Already Disabled" : "Disable Orphan";
      button.addEventListener("click", () => quarantineOrphan(item, button));

      row.append(text, button);
      orphanUsers.append(row);
    }
  }

  async function repairUser(item, button) {
    const confirmed = confirm(
      `Repair MikroTik state for ${item.username}?\n\n` +
      "This may recreate, enable, or disable this single HotSpot user so it matches SQLite."
    );

    if (!confirmed) return;

    button.disabled = true;
    button.textContent = "Repairing…";

    try {
      const result = await api(`/api/admin/recovery/users/${item.id}/repair`, {
        method: "POST",
        body: JSON.stringify({ confirmation: "REPAIR" })
      });

      TechCPR.setMessage(
        message,
        `${result.username}: recovery action ${result.action} completed.`
      );
      render(result.sync);
    } catch (error) {
      TechCPR.setMessage(message, error.message, "error");
      button.disabled = false;
      button.textContent = "Retry Repair";
    }
  }

  async function quarantineOrphan(item, button) {
    const confirmed = confirm(
      `Disable orphaned MikroTik user ${item.username}?\n\n` +
      "This does NOT delete the user. It only disables access so it can be reviewed safely."
    );

    if (!confirmed) return;

    button.disabled = true;
    button.textContent = "Disabling…";

    try {
      const result = await api(
        `/api/admin/recovery/orphans/${encodeURIComponent(item.username)}/disable`,
        {
          method: "POST",
          body: JSON.stringify({ confirmation: "DISABLE" })
        }
      );

      TechCPR.setMessage(
        message,
        `${result.username} was disabled for manual review.`
      );
      render(result.sync);
    } catch (error) {
      TechCPR.setMessage(message, error.message, "error");
      button.disabled = false;
      button.textContent = "Retry Disable";
    }
  }

  function emptyRow(text) {
    const row = document.createElement("div");
    row.className = "recovery-empty";
    row.textContent = text;
    return row;
  }

  async function resumeAdminSession() {
    if (!TechCPRAdmin.hasSession()) return;
    if (!await TechCPRAdmin.validate()) return;

    loginPanel.hidden = true;
    content.hidden = false;
    await loadSyncStatus();
  }

  resumeAdminSession();
})();
