(() => {
  "use strict";

  const emailInput = document.getElementById("email");
  const message = document.getElementById("message");
  const buttons = [...document.querySelectorAll("[data-plan]")];

  function isValidEmail(value) {
    const email = String(value || "").trim();
    return (
      email.length >= 3 &&
      email.length <= 254 &&
      !/\s/.test(email) &&
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
    );
  }

  async function startCheckout(plan) {
    const email = emailInput.value.trim();

    if (!isValidEmail(email)) {
      TechCPR.setMessage(message, "Please enter a valid email address.", "error");
      emailInput.focus();
      return;
    }

    TechCPR.setBusy(buttons, true);
    TechCPR.setMessage(message, "Opening secure checkout…");

    try {
      const response = await fetch("/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, email })
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        throw new Error(`Checkout server returned HTTP ${response.status}.`);
      }

      if (!response.ok || !data.url) {
        throw new Error(data.error || "Unable to start checkout.");
      }

      window.location.assign(data.url);
    } catch (error) {
      console.error("Checkout failed:", error);
      TechCPR.setMessage(
        message,
        error.message || "Unable to connect to the payment server.",
        "error"
      );
      TechCPR.setBusy(buttons, false);
    }
  }

  for (const button of buttons) {
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const plan = button.dataset.plan || "";
      if (!plan) {
        TechCPR.setMessage(message, "Unable to determine the selected plan.", "error");
        return;
      }
      startCheckout(plan);
    });
  }
})();
