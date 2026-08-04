(() => {
  "use strict";

  const form = document.getElementById("checkout-form");
  const emailInput = document.getElementById("email");
  const message = document.getElementById("message");
  const buttons = [...document.querySelectorAll("[data-plan]")];

  let selectedPlan = "";

  for (const button of buttons) {
    button.addEventListener("click", () => {
      selectedPlan = button.dataset.plan || "";
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!selectedPlan) {
      TechCPR.setMessage(message, "Please choose a plan.", "error");
      return;
    }

    if (!emailInput.checkValidity()) {
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
        body: JSON.stringify({
          plan: selectedPlan,
          email: emailInput.value.trim()
        })
      });

      const data = await response.json();

      if (!response.ok || !data.url) {
        throw new Error(data.error || "Unable to start checkout.");
      }

      window.location.assign(data.url);
    } catch (error) {
      TechCPR.setMessage(
        message,
        error.message || "Unable to connect to the payment server.",
        "error"
      );
      TechCPR.setBusy(buttons, false);
    }
  });
})();
