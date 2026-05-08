const express = require("express");
const puppeteer = require("puppeteer");
const proxyChain = require("proxy-chain");
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

// ── Generate link via Puppeteer ───────────────────────────────────────────
app.post("/api/generate-link", async (req, res) => {
  const { accessToken, sessionToken, country = "ID", mode = "hosted", proxy } = req.body;

  if (!accessToken) return res.status(400).json({ error: "accessToken required" });
  if (!sessionToken) return res.status(400).json({ error: "sessionToken required for browser auth" });

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

  let browser;
  let anonProxy = null;
  try {
    console.log(`[${new Date().toISOString()}] Generate — ${country} | ${mode} | proxy:${proxy || "none"}`);

    const launchArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"];

    // Anonymize proxy (handles auth)
    if (proxy) {
      anonProxy = await proxyChain.anonymizeProxy(proxy);
      launchArgs.push(`--proxy-server=${anonProxy}`);
      console.log(`  → Proxy: ${anonProxy}`);
    }

    browser = await puppeteer.launch({ headless: "new", args: launchArgs });
    const page = await browser.newPage();
    await page.setUserAgent(UA);

    // Set session cookie
    await page.setCookie({
      name: "__Secure-next-auth.session-token",
      value: sessionToken,
      domain: "chatgpt.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });

    // Navigate
    console.log("  → Navigating...");
    await page.goto("https://chatgpt.com", { waitUntil: "networkidle2", timeout: 90000 });
    console.log("  → ✓ Page loaded");

    // Checkout API call with 45s timeout
    console.log("  → Calling checkout API...");
    const result = await page.evaluate(async (token, payloadStr, timeoutMs) => {

      async function fetchWithTimeout(url, opts, ms) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
          const res = await fetch(url, { ...opts, signal: controller.signal });
          clearTimeout(timer);
          return res;
        } catch (e) {
          clearTimeout(timer);
          throw e;
        }
      }

      async function tryCheckout(body) {
        try {
          const response = await fetchWithTimeout(
            "https://chatgpt.com/backend-api/payments/checkout",
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body,
            },
            timeoutMs
          );
          const text = await response.text();
          let data;
          try { data = JSON.parse(text); } catch (e) {
            return { error: `Non-JSON (${response.status}): ${text.substring(0, 200)}` };
          }
          if (!response.ok) return { error: `API ${response.status}`, details: data };
          return { success: true, data };
        } catch (e) {
          if (e.name === "AbortError") return { error: "API call timed out (45s)" };
          return { error: e.message };
        }
      }

      // Try with promo
      let result = await tryCheckout(payloadStr);

      // If promo rejected, retry without
      if (result.error && !result.success) {
        const p = JSON.parse(payloadStr);
        if (p.promo_campaign) {
          delete p.promo_campaign;
          const r2 = await tryCheckout(JSON.stringify(p));
          if (r2.success) { r2.promoSkipped = true; return r2; }
          if (r2.error && r2.error !== "API call timed out (45s)") return r2;
        }
      }

      return result;
    }, accessToken, JSON.stringify(payload), 45000);

    // Cleanup
    await browser.close(); browser = null;
    if (anonProxy) { await proxyChain.closeAnonymizedProxy(anonProxy); anonProxy = null; }

    console.log("  → Result:", JSON.stringify(result, null, 2));

    if (result.error) {
      return res.status(502).json({ error: result.error, details: result.details });
    }

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

    console.log("  →", output.link ? `✓ Link generated` : "✗ No link");
    return res.json(output);

  } catch (err) {
    console.error("Error:", err.message);
    if (browser) try { await browser.close(); } catch (e) {}
    if (anonProxy) try { await proxyChain.closeAnonymizedProxy(anonProxy); } catch (e) {}
    return res.status(500).json({ error: "Error: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Diaa Store GPT Pay running at http://localhost:${PORT}\n`);
});
