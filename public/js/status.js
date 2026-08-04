(() => {
  "use strict";

  const refreshButton = document.getElementById("refresh-status");
  const message = document.getElementById("message");
  const overallState = document.getElementById("overall-state");
  const timestamp = document.getElementById("timestamp");

  const cards = {
    server: document.getElementById("server"),
    database: document.getElementById("database"),
    stripe: document.getElementById("stripe"),
    mikrotik: document.getElementById("mikrotik")
  };

  refreshButton.addEventListener("click", loadStatus);
  loadStatus();

  async function loadStatus() {
    refreshButton.disabled = true;
    refreshButton.textContent = "Checking…";
    TechCPR.setMessage(message, "");

    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Unable to retrieve system status.");
      }

      const health = {
        server: evaluate("server", data.server),
        database: evaluate("database", data.database),
        stripe: evaluate("stripe", data.stripe),
        mikrotik: evaluate("mikrotik", data.mikrotik)
      };

      renderCard("server", data.server, health.server);
      renderCard("database", data.database, health.database);
      renderCard("stripe", data.stripe, health.stripe);
      renderCard("mikrotik", data.mikrotik, health.mikrotik);

      const allHealthy = Object.values(health).every(Boolean);
      overallState.textContent = allHealthy ? "All systems operational" : "Attention required";
      overallState.className = `health-summary__value ${allHealthy ? "is-healthy" : "is-warning"}`;
      timestamp.textContent = data.timestamp
        ? `Last checked ${TechCPR.formatDate(data.timestamp)}`
        : "Status timestamp unavailable";
    } catch (error) {
      overallState.textContent = "Status unavailable";
      overallState.className = "health-summary__value is-error";
      TechCPR.setMessage(
        message,
        error.message || "Unable to retrieve system status.",
        "error"
      );
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh Status";
    }
  }

  function evaluate(type, value) {
    const normalized = String(value || "").trim().toLowerCase();

    if (type === "mikrotik") {
      return Boolean(normalized && !["offline", "unavailable", "unknown", "error"].includes(normalized));
    }

    return ["ok", "configured", "online", "connected", "healthy"].includes(normalized);
  }

  function renderCard(type, value, healthy) {
    const card = cards[type];
    const state = card.querySelector("[data-state]");
    const valueElement = card.querySelector("[data-value]");

    state.innerHTML = `<span class="health-dot"></span>${healthy ? "Operational" : "Check required"}`;
    state.className = `health-card__state ${healthy ? "is-healthy" : "is-warning"}`;
    valueElement.textContent = value || "Unavailable";
  }
})();
