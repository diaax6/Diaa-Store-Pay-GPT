(function () {
  "use strict";

  // ── Stars ───────────────────────────────────────────────────
  !function(){const c=document.getElementById("starsCanvas");if(!c)return;const x=c.getContext("2d");let w,h,s;function r(){w=c.width=innerWidth;h=c.height=innerHeight}function m(n){s=[];for(let i=0;i<n;i++)s.push({x:Math.random()*w,y:Math.random()*h,r:Math.random()*1.4+.3,a:Math.random()*.7+.2,v:Math.random()*.3+.05,p:Math.random()*Math.PI*2})}function d(t){x.clearRect(0,0,w,h);s.forEach(p=>{x.beginPath();x.arc(p.x,p.y,p.r,0,Math.PI*2);x.fillStyle=`rgba(255,255,255,${p.a*(Math.sin(t*.001*p.v+p.p)*.3+.7)})`;x.fill()});requestAnimationFrame(d)}r();m(180);addEventListener("resize",()=>{r();m(180)});requestAnimationFrame(d)}();

  // ── State ───────────────────────────────────────────────────
  let state = {
    accessToken: null,
    sessionToken: null,
    offerCountry: "JP",   // where to get promo from
    billingCountry: "ID", // where to bill (currency)
    mode: "hosted",
  };

  const $ = id => document.getElementById(id);

  // ── Offer Country Toggle (2x2 grid) ────────────────────────
  $("offerCountryToggle").querySelectorAll(".country-btn").forEach(b => {
    b.onclick = () => {
      $("offerCountryToggle").querySelectorAll(".country-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.offerCountry = b.dataset.country;
    };
  });

  // ── Billing Country Toggle ─────────────────────────────────
  $("billingToggle").querySelectorAll(".toggle-btn").forEach(b => {
    b.onclick = () => {
      $("billingToggle").querySelectorAll(".toggle-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.billingCountry = b.dataset.billing;
    };
  });

  // ── Mode Toggle ────────────────────────────────────────────
  $("modeToggle").querySelectorAll(".toggle-btn").forEach(b => {
    b.onclick = () => {
      $("modeToggle").querySelectorAll(".toggle-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.mode = b.dataset.mode;
    };
  });

  // ── Clear ───────────────────────────────────────────────────
  $("btnClear").onclick = () => {
    $("sessionInput").value = "";
    state.accessToken = null;
    state.sessionToken = null;
    $("resultSection").classList.add("hidden");
    $("errorBar").classList.add("hidden");
    $("accountToast").classList.add("hidden");
    $("sessionInput").focus();
  };

  // ── Generate ────────────────────────────────────────────────
  $("btnGenerate").onclick = generate;

  async function generate() {
    const raw = $("sessionInput").value.trim();
    if (!raw) return showError("Paste your session JSON first.");

    // Parse
    $("errorBar").classList.add("hidden");
    $("resultSection").classList.add("hidden");

    let parseRes;
    try {
      parseRes = await fetch("/api/parse-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionData: raw }),
      }).then(r => r.json());
    } catch (e) { return showError("Parse error: " + e.message); }

    if (!parseRes.success) return showError(parseRes.error || "Parse failed.");

    state.accessToken = parseRes.info.accessToken;
    state.sessionToken = parseRes.info.sessionToken;

    // Show toast
    showAccountToast(parseRes.info);

    if (!state.sessionToken) return showError("sessionToken not found in session data.");

    // Generate
    $("loader").classList.remove("hidden");
    $("btnGenerate").disabled = true;

    const proxy = $("proxyInput").value.trim() || null;

    try {
      const res = await fetch("/api/generate-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: state.accessToken,
          sessionToken: state.sessionToken,
          offerCountry: state.offerCountry,
          billingCountry: state.billingCountry,
          mode: state.mode,
          proxy: proxy,
        }),
      });
      const data = await res.json();
      $("loader").classList.add("hidden");
      $("btnGenerate").disabled = false;

      if (!res.ok || !data.success) return showError(data.error || "Generation failed.");

      // Show result
      $("resultLabel").textContent = state.mode === "hosted" ? "Hosted Payment Link" : "Embedded Checkout Link";
      $("resultLink").value = data.link;

      const meta = $("resultMeta");
      meta.innerHTML = "";
      [
        { l: "Offer", v: state.offerCountry + (data.promoSkipped ? " (no promo)" : " ✓ promo") },
        { l: "Billing", v: state.billingCountry },
        { l: "Mode", v: state.mode === "hosted" ? "Hosted" : "Embedded" },
      ].forEach(({ l, v }) => {
        const d = document.createElement("div");
        d.className = "meta-chip";
        d.innerHTML = `<span class="meta-chip-label">${l}</span><span class="meta-chip-value">${v}</span>`;
        meta.appendChild(d);
      });

      $("resultSection").classList.remove("hidden");
    } catch (e) {
      $("loader").classList.add("hidden");
      $("btnGenerate").disabled = false;
      showError("Error: " + e.message);
    }
  }

  // ── Copy ────────────────────────────────────────────────────
  $("btnCopy").onclick = async () => {
    const v = $("resultLink").value;
    if (!v) return;
    try { await navigator.clipboard.writeText(v); } catch { $("resultLink").select(); document.execCommand("copy"); }
    const btn = $("btnCopy");
    btn.classList.add("copied");
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
    }, 2000);
  };

  // ── Toast ───────────────────────────────────────────────────
  function showAccountToast(info) {
    $("tName").textContent = info.user.name;
    $("tEmail").textContent = info.user.email;

    const plan = (info.account.planType || "free").toLowerCase();
    const cls = plan === "plus" ? "plan-plus" : plan === "pro" ? "plan-pro" : "plan-free";
    $("tPlan").innerHTML = `<span class="plan-badge ${cls}">${plan.toUpperCase()}</span>`;

    $("tExpires").textContent = info.expires
      ? new Date(info.expires).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "—";

    $("accountToast").classList.remove("hidden");
  }

  $("toastClose").onclick = () => $("accountToast").classList.add("hidden");

  // ── Error ───────────────────────────────────────────────────
  function showError(msg) {
    $("errorMessage").textContent = msg;
    $("errorBar").classList.remove("hidden");
    $("loader").classList.add("hidden");
    $("btnGenerate").disabled = false;
  }

  $("btnDismiss").onclick = () => $("errorBar").classList.add("hidden");

})();
