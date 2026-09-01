(() => {
  "use strict";

  const TOKEN_KEY = "techcpr_admin_token";
  const EXPIRES_KEY = "techcpr_admin_expires";

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  function clear() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXPIRES_KEY);
  }

  function headers(extra = {}) {
    const token = getToken();
    return {
      ...(token ? { "x-admin-token": token } : {}),
      ...extra
    };
  }

  async function login(password) {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const data = await response.json();

    if (!response.ok || !data.success || !data.token) {
      throw new Error(data.error || "Login failed.");
    }

    sessionStorage.setItem(TOKEN_KEY, data.token);
    sessionStorage.setItem(EXPIRES_KEY, data.expiresAt || "");
    return data;
  }

  async function validate() {
    if (!getToken()) return false;

    try {
      const response = await fetch("/api/admin/session", {
        headers: headers(),
        cache: "no-store"
      });

      if (!response.ok) {
        clear();
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  async function logout() {
    try {
      if (getToken()) {
        await fetch("/api/admin/logout", {
          method: "POST",
          headers: headers()
        });
      }
    } finally {
      clear();
    }
  }

  window.TechCPRAdmin = Object.freeze({
    headers,
    login,
    validate,
    logout,
    clear,
    hasSession: () => Boolean(getToken())
  });
})();
