const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Country configs ───────────────────────────────────────────────────────
const PROMO = { promo_campaign_id: "plus-1-month-free", is_coupon_from_query_param: false };
const COUNTRIES = {
  ID: { currency: "IDR", promo: PROMO },
  US: { currency: "USD", promo: PROMO },
  JP: { currency: "JPY", promo: PROMO },
  GB: { currency: "GBP", promo: PROMO },
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// ── Parse session ─────────────────────────────────────────────────────────
app.post("/api/parse-session", (req, res) => {
  const { sessionData } = req.body;
  if (!sessionData) return res.status(400).json({ error: "No data" });

  const raw = typeof sessionData === "string" ? sessionData.trim() : JSON.stringify(sessionData);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }

  const extract = (field, regex) => {
    if (parsed) {
      const keys = field.split(".");
      let val = parsed;
      for (const k of keys) { val = val?.[k]; }
      if (val) return val;
    }
    const m = raw.match(regex);
    return m ? m[1] : null;
  };

  const accessToken = extract("accessToken", /"accessToken"\s*:\s*"(eyJ[A-Za-z0-9_\-\.]+)"/);
  const sessionToken = extract("sessionToken", /"sessionToken"\s*:\s*"([^"]+)"/);
  const userName = extract("user.name", /"name"\s*:\s*"([^"]+)"/);
  const userEmail = extract("user.email", /"email"\s*:\s*"([^"]+)"/);
  const planType = extract("account.planType", /"planType"\s*:\s*"([^"]+)"/);
  const structure = extract("account.structure", /"structure"\s*:\s*"([^"]+)"/);
  const expires = extract("expires", /"expires"\s*:\s*"([^"]+)"/);

  if (!accessToken) return res.status(400).json({ error: "No accessToken found." });

  return res.json({
    success: true,
    info: {
      user: { name: userName || "Unknown", email: userEmail || "Unknown" },
      account: { planType: planType || "free", structure: structure || "Unknown" },
      expires,
      accessToken,
      sessionToken: sessionToken || null,
      hasValidToken: true,
    },
  });
});

// ── Generate link — DIRECT API (no Puppeteer!) ───────────────────────────
app.post("/api/generate-link", async (req, res) => {
  const { accessToken, country = "ID", mode = "hosted" } = req.body;

  if (!accessToken) return res.status(400).json({ error: "accessToken required" });

  const cc = COUNTRIES[country];
  if (!cc) return res.status(400).json({ error: "Unsupported country" });

  // Build payload
  let payload;
  if (mode === "hosted") {
    payload = {
      plan_name: "chatgptplusplan",
      billing_details: { country, currency: cc.currency },
      cancel_url: "https://chatgpt.com/#pricing",
      checkout_ui_mode: "hosted",
    };
    if (cc.promo) payload.promo_campaign = cc.promo;
  } else {
    payload = {
      entry_point: "all_plans_pricing_modal",
      plan_name: "chatgptplusplan",
      billing_details: { country, currency: cc.currency },
      checkout_ui_mode: "custom",
    };
    if (cc.promo) payload.promo_campaign = cc.promo;
  }

  try {
    console.log(`[${new Date().toISOString()}] Direct API — ${country} | ${mode}`);

    // Direct API call — no Puppeteer, no proxy!
    async function callCheckout(body) {
      const response = await fetch("https://chatgpt.com/backend-api/payments/checkout", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": UA,
          "Origin": "https://chatgpt.com",
          "Referer": "https://chatgpt.com/",
        },
        body: JSON.stringify(body),
        timeout: 30000,
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (e) {
        return { ok: false, error: `Non-JSON (${response.status}): ${text.substring(0, 300)}` };
      }
      if (!response.ok) return { ok: false, status: response.status, error: `API ${response.status}`, details: data };
      return { ok: true, data };
    }

    // Try with promo
    let result = await callCheckout(payload);

    // If promo rejected, retry without
    if (!result.ok && payload.promo_campaign) {
      console.log("  → Promo rejected, retrying without...");
      const noPromo = { ...payload };
      delete noPromo.promo_campaign;
      const r2 = await callCheckout(noPromo);
      if (r2.ok) { result = r2; result.promoSkipped = true; }
      else result = r2;
    }

    if (!result.ok) {
      console.log("  → Error:", result.error);
      return res.status(502).json({ error: result.error, details: result.details });
    }

    console.log("  → ✓ Success");

    // Build output
    const data = result.data;
    const output = { success: true, mode, promoSkipped: result.promoSkipped || false, raw: data };

    if (mode === "hosted") {
      output.link = data.url || data.stripe_hosted_url || data.checkout_url;
      output.checkout_session_id = data.checkout_session_id;
    } else {
      const entity = data.processor_entity || "openai_llc";
      const sid = data.checkout_session_id;
      output.link = sid ? `https://chatgpt.com/checkout/${entity}/${sid}` : null;
      output.checkout_session_id = sid;
    }

    if (!output.link) { output.success = false; output.error = "No link in response"; }

    console.log("  →", output.link ? `✓ ${output.link.substring(0, 60)}...` : "✗ No link");
    return res.json(output);

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: "Error: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Diaa Store GPT Pay running at http://localhost:${PORT}\n`);
});
