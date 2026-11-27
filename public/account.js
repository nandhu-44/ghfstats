/* Sign-in first: leads with "Continue with GitHub" when this deployment has sign-in set up.
 * Signed in, it links to the dashboard and lookups use the person's own GitHub sign-in.
 * On static hosting (no /api) the sign-in block is hidden and the lookup is the main thing. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const box = $("account");
  if (!box) return;

  const MESSAGES = {
    cancelled: "Sign-in was cancelled on GitHub.",
    expired: "That sign-in link expired. Try again.",
    failed: "GitHub sign-in didn't work. Try again in a moment.",
    unavailable: "Sign-in isn't set up on this site yet.",
    deleted: "Your data was deleted and ghfstats no longer has access to your GitHub account.",
  };
  const notice = MESSAGES[new URLSearchParams(location.search).get("signin")];

  function setNotice(text) {
    const hint = $("accountHint");
    hint.textContent = text;
    hint.classList.add("notice-text");
  }

  const config = window.ghfsConfig || Promise.resolve(null);
  config.then((cfg) => {
    if (!cfg || !cfg.signIn) {
      // No sign-in here: the lookup is the main path.
      $("lookupTitle").textContent = "Check any username";
      $("lookupHint").textContent = "Without a token, GitHub allows 60 requests an hour, enough for about 3,000 followers plus following.";
      if (notice) { $("accountLink").hidden = true; $("perks").hidden = true; setNotice(notice); }
      else box.hidden = true;
      return;
    }
    if (cfg.signedIn) {
      const link = $("accountLink");
      link.textContent = "Open your dashboard";
      link.href = "/dashboard";
      link.classList.remove("gh");
      $("accountHint").textContent = `Signed in as @${cfg.login}. Your account is snapshotted every day.`;
      $("perks").hidden = true;
      $("topNav").hidden = false;
      $("lookupTitle").textContent = "Check any username";
      $("lookupHint").textContent = "Lookups use your GitHub sign-in, so you get 5,000 requests an hour. Nothing about them is stored.";
    }
    if (notice) setNotice(notice);
  });
})();
