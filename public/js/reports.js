(() => {
  "use strict";

  const loginPanel = document.getElementById("reports-login");
  const content = document.getElementById("reports-content");
  const passwordInput = document.getElementById("reports-password");
  const loginButton = document.getElementById("reports-login-button");
  const loginMessage = document.getElementById("reports-login-message");
  const refreshButton = document.getElementById("reports-refresh");
  const signoutButton = document.getElementById("reports-signout");
  const exportButton = document.getElementById("export-csv");
  const message = document.getElementById("reports-message");
  const updated = document.getElementById("reports-updated");
  const trend = document.getElementById("revenue-trend");
  const planReport = document.getElementById("plan-report");
  const accountReport = document.getElementById("account-report");

  let adminPassword = "";

  loginButton.addEventListener("click", login);
  passwordInput.addEventListener("keydown", event => {
    if (event.key === "Enter") login();
  });
  refreshButton.addEventListener("click", loadReports);
  signoutButton.addEventListener("click", signOut);
  exportButton.addEventListener("click", exportCsv);

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
      await TechCPRAdmin.login(password);
      adminPassword = "";
      loginPanel.hidden = true;
      content.hidden = false;
      await loadReports();
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

  async function loadReports() {
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing…";

    try {
      const response = await fetch("/api/admin/reports", {
        headers: TechCPRAdmin.headers(),
        cache: "no-store"
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to load reports.");
      }

      document.getElementById("report-revenue-today").textContent =
        money(data.periods.today.revenueCents);
      document.getElementById("report-revenue-7").textContent =
        money(data.periods.last7Days.revenueCents);
      document.getElementById("report-revenue-30").textContent =
        money(data.periods.last30Days.revenueCents);
      document.getElementById("report-sales-30").textContent =
        data.periods.last30Days.sales;

      renderTrend(data.trend || []);
      renderPlans(data.plans || []);
      renderAccounts(data.accounts || {});

      updated.textContent = `Updated ${TechCPR.formatDate(data.timestamp)}`;
      TechCPR.setMessage(message, "Reporting data is current.");
    } catch (error) {
      TechCPR.setMessage(message, error.message || "Unable to load reports.", "error");
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh";
    }
  }

  function money(cents) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD"
    }).format(Number(cents || 0) / 100);
  }

  function renderTrend(items) {
    trend.replaceChildren();

    const max = Math.max(1, ...items.map(item => Number(item.revenueCents || 0)));

    for (const item of items) {
      const wrapper = document.createElement("div");
      wrapper.className = "trend-day";
      wrapper.title = `${item.date}: ${money(item.revenueCents)} / ${item.sales} sale(s)`;

      const bar = document.createElement("div");
      bar.className = "trend-day__bar";
      bar.style.height = `${Math.max(4, (Number(item.revenueCents || 0) / max) * 100)}%`;

      const label = document.createElement("span");
      label.className = "trend-day__label";
      label.textContent = item.date.slice(8);

      wrapper.append(bar, label);
      trend.append(wrapper);
    }
  }

  function renderPlans(items) {
    planReport.replaceChildren();

    if (!items.length) {
      planReport.textContent = "No paid sales in the last 30 days.";
      return;
    }

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "report-row";

      const name = document.createElement("strong");
      name.textContent = item.plan;

      const detail = document.createElement("span");
      detail.textContent = `${item.sales} sale(s) • ${money(item.revenueCents)}`;

      row.append(name, detail);
      planReport.append(row);
    }
  }

  function renderAccounts(accounts) {
    accountReport.replaceChildren();

    const entries = Object.entries(accounts).sort((a, b) => b[1] - a[1]);

    if (!entries.length) {
      accountReport.textContent = "No customer accounts found.";
      return;
    }

    for (const [status, count] of entries) {
      const row = document.createElement("div");
      row.className = "report-row";

      const name = document.createElement("strong");
      name.textContent = status;

      const detail = document.createElement("span");
      detail.textContent = `${count} account(s)`;

      row.append(name, detail);
      accountReport.append(row);
    }
  }

  async function exportCsv() {
    exportButton.disabled = true;
    exportButton.textContent = "Exporting…";

    try {
      const response = await fetch("/api/admin/reports.csv", {
        headers: TechCPRAdmin.headers(),
        cache: "no-store"
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Unable to export CSV.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "techcpr-wifi-report.csv";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      TechCPR.setMessage(message, "CSV report exported.");
    } catch (error) {
      TechCPR.setMessage(message, error.message || "Unable to export CSV.", "error");
    } finally {
      exportButton.disabled = false;
      exportButton.textContent = "Export CSV";
    }
  }
  async function resumeAdminSession() {
    if (!TechCPRAdmin.hasSession()) return;
    if (!await TechCPRAdmin.validate()) return;

    loginPanel.hidden = true;
    content.hidden = false;
    await loadReports();
  }

  resumeAdminSession();

})();