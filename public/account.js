/* Shows "Continue with GitHub" when this deployment has sign-in set up. On static hosting
 * (no /api), the request fails and the page stays exactly as before. */
(function () {
  "use strict";
  const box = document.getElementById("account");
  const link = document.getElementById("accountLink");
  const hint = document.getElementById("accountHint");
  if (!box || location.protocol === "file:") return;

  const MESSAGES = {
    cancelled: "Sign-in was cancelled on GitHub.",
    expired: "That sign-in link expired. Try again.",
    failed: "GitHub sign-in didn't work. Try again in a moment.",
    unavailable: "Sign-in isn't set up on this site yet.",
    deleted: "Your data was deleted and ghfstats no longer has access to your GitHub account.",
  };
  const params = new URLSearchParams(location.search);
  const notice = MESSAGES[params.get("signin")];

  fetch("/api/config", { credentials: "same-origin", headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (!cfg || !cfg.signIn) {
        if (notice) { box.hidden = false; link.hidden = true; hint.textContent = notice; }
        return;
      }
      box.hidden = false;
      if (cfg.signedIn) {
        link.textContent = "Open your dashboard";
        link.href = "/dashboard";
        hint.textContent = `Signed in as @${cfg.login}.`;
      } else if (notice) {
        hint.textContent = notice;
      }
    })
    .catch(() => { /* static hosting: nothing to show */ });
})();
