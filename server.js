const express = require("express");
const puppeteer = require("puppeteer");
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
  const { accessToken, sessionToken, offerCountry = "JP", billingCountry = "ID", mode = "hosted", proxy } = req.body;

  // Back-compat: also accept old "country" field
  const offer = offerCountry || req.body.country || "JP";
  const billing = billingCountry || req.body.country || "ID";

  if (!accessToken) return res.status(400).json({ error: "accessToken required" });
  if (!sessionToken) return res.status(400).json({ error: "sessionToken required for browser auth" });

  const offerCC = COUNTRIES[offer];
  const billingCC = COUNTRIES[billing];
  if (!offerCC) return res.status(400).json({ error: "Unsupported offer country" });
  if (!billingCC) return res.status(400).json({ error: "Unsupported billing country" });

  // Build payload: promo from offerCountry, billing from billingCountry
  let payload;
  if (mode === "hosted") {
    payload = {
      plan_name: "chatgptplusplan",
      billing_details: { country: billing, currency: billingCC.currency },
      cancel_url: "https://chatgpt.com/#pricing",
      checkout_ui_mode: "hosted",
    };
    if (offerCC.promo) payload.promo_campaign = offerCC.promo;
  } else {
    payload = {
      entry_point: "all_plans_pricing_modal",
      plan_name: "chatgptplusplan",
      billing_details: { country: billing, currency: billingCC.currency },
      checkout_ui_mode: "custom",
    };
    if (offerCC.promo) payload.promo_campaign = offerCC.promo;
  }

  let browser;
  try {
    console.log(`[${new Date().toISOString()}] Launching browser — offer:${offer} billing:${billing} mode:${mode} proxy:${proxy || "none"}`);

    // Parse proxy — extract auth if present (http://user:pass@host:port → host:port + auth)
    let proxyServer = null;
    let proxyAuth = null;
    if (proxy) {
      try {
        const proxyUrl = new URL(proxy);
        if (proxyUrl.username && proxyUrl.password) {
          proxyAuth = { username: decodeURIComponent(proxyUrl.username), password: decodeURIComponent(proxyUrl.password) };
          proxyServer = `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`;
        } else {
          proxyServer = proxy;
        }
      } catch (e) {
        proxyServer = proxy; // fallback: use as-is
      }
    }

    const launchArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"];
    if (proxyServer) launchArgs.push(`--proxy-server=${proxyServer}`);

    browser = await puppeteer.launch({
      headless: "new",
      args: launchArgs,
    });

    const page = await browser.newPage();

    // Authenticate proxy if credentials exist
    if (proxyAuth) {
      await page.authenticate(proxyAuth);
      console.log("  → Proxy auth set");
    }

    // Set user agent
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");

    // Set the session cookie BEFORE navigating
    await page.setCookie({
      name: "__Secure-next-auth.session-token",
      value: sessionToken,
      domain: "chatgpt.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });

    // Navigate to chatgpt.com to pass Cloudflare
    console.log("  → Navigating to chatgpt.com...");
    await page.goto("https://chatgpt.com", { waitUntil: "networkidle2", timeout: 60000 });
    console.log("  → Page loaded, running checkout script...");

    // Run the checkout API call from within the page context
    // Try with promo first, retry without if rejected
    const result = await page.evaluate(async (token, payloadStr) => {
      async function tryCheckout(body) {
        const response = await fetch("https://chatgpt.com/backend-api/payments/checkout", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
        });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { return { error: `Non-JSON (${response.status}): ${text.substring(0, 200)}` }; }
        if (!response.ok) return { error: `API error ${response.status}`, details: data, status: response.status };
        return { success: true, data };
      }

      try {
        // Try with promo
        let result = await tryCheckout(payloadStr);

        // If promo was rejected, retry without it
        if (result.error && !result.success) {
          const payload = JSON.parse(payloadStr);
          if (payload.promo_campaign) {
            delete payload.promo_campaign;
            result = await tryCheckout(JSON.stringify(payload));
            if (result.success) result.promoSkipped = true;
          }
        }

        return result;
      } catch (e) {
        return { error: e.message };
      }
    }, accessToken, JSON.stringify(payload));

    await browser.close();
    browser = null;

    console.log("  → Result:", JSON.stringify(result, null, 2));

    if (result.error) {
      return res.status(502).json({ error: result.error, details: result.details });
    }

    const data = result.data;
    const output = { success: true, mode, raw: data };

    if (mode === "hosted") {
      output.link = data.url || data.stripe_hosted_url || data.checkout_url;
      output.checkout_session_id = data.checkout_session_id;
      output.processor_entity = data.processor_entity;
    } else {
      const entity = data.processor_entity || "openai_llc";
      const sid = data.checkout_session_id;
      output.link = sid ? `https://chatgpt.com/checkout/${entity}/${sid}` : null;
      output.checkout_session_id = sid;
      output.processor_entity = entity;
    }

    if (!output.link) {
      output.success = false;
      output.error = "No link in response";
    }

    return res.json(output);
  } catch (err) {
    console.error("Puppeteer error:", err.message);
    if (browser) try { await browser.close(); } catch (e) {}
    return res.status(500).json({ error: "Browser error: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Diaa Store GPT Pay running at http://localhost:${PORT}\n`);
});
