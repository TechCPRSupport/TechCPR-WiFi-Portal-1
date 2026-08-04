(() => {
  "use strict";

  window.TechCPR = Object.freeze({
    setMessage(element, text, type = "success") {
      if (!element) return;
      element.textContent = text;
      element.className = `status-message ${type === "error" ? "is-error" : "is-success"}`;
    },

    setBusy(buttons, busy, busyLabel = "Please wait…", idleLabel = "Get Access") {
      for (const button of buttons) {
        button.disabled = busy;
        button.textContent = busy ? busyLabel : idleLabel;
      }
    }
  });
})();
