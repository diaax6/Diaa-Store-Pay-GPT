const express = require("express");
const puppeteer = require("puppeteer");
const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
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

// ── HYBRID: Puppeteer for Cloudflare bypass, node-fetch with proxy for API ──
app.post("/api/generate-link", async (req, res) => {
  const { accessToken, sessionToken, offerCountry = "JP", billingCountry = "ID", mode = "hosted", proxy } = req.body;

  const offer = offerCountry || req.body.country || "JP";
  const billing = billingCountry || req.body.country || "ID";

  if (!accessToken) return res.status(400).json({ error: "accessToken required" });
  if (!sessionToken) return res.status(400).json({ error: "sessionToken required for browser auth" });

  const offerCC = COUNTRIES[offer];
  const billingCC = COUNTRIES[billing];
  if (!offerCC) return res.status(400).json({ error: "Unsupported offer country" });
  if (!billingCC) return res.status(400).json({ error: "Unsupported billing country" });

  // Build payload
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
    console.log(`[${new Date().toISOString()}] HYBRID — offer:${offer} billing:${billing} mode:${mode} proxy:${proxy || "none"}`);

    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Puppeteer WITHOUT proxy — bypass Cloudflare (fast!)
    // ═══════════════════════════════════════════════════════════════
    console.log("  [1/3] Launching browser (no proxy) to bypass Cloudflare...");

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    });

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

    // Navigate to bypass Cloudflare
    await page.goto("https://chatgpt.com", { waitUntil: "networkidle2", timeout: 30000 });
    console.log("  [1/3] ✓ Cloudflare bypassed");

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: Extract cookies from browser session
    // ═══════════════════════════════════════════════════════════════
    console.log("  [2/3] Extracting cookies...");
    const cookies = await page.cookies("https://chatgpt.com");
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");

    await browser.close();
    browser = null;
    console.log(`  [2/3] ✓ Got ${cookies.length} cookies`);

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: API call via node-fetch WITH proxy (fast, just HTTP!)
    // ═══════════════════════════════════════════════════════════════
    console.log("  [3/3] Calling checkout API" + (proxy ? ` through proxy...` : " directly..."));

    // Create proxy agent if proxy is provided
    let agent = null;
    if (proxy) {
      if (proxy.startsWith("socks")) {
        agent = new SocksProxyAgent(proxy);
      } else {
        agent = new HttpsProxyAgent(proxy);
      }
    }

    const fetchOpts = {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": UA,
        "Cookie": cookieStr,
        "Origin": "https://chatgpt.com",
        "Referer": "https://chatgpt.com/",
      },
      body: JSON.stringify(payload),
      timeout: 30000,
    };
    if (agent) fetchOpts.agent = agent;

    // Try with promo
    let response = await fetch("https://chatgpt.com/backend-api/payments/checkout", fetchOpts);
    let data;

    if (!response.ok) {
      // If promo rejected, retry without
      if (payload.promo_campaign) {
        console.log("  [3/3] Promo rejected, retrying without promo...");
        const payloadNoPromo = { ...payload };
        delete payloadNoPromo.promo_campaign;
        fetchOpts.body = JSON.stringify(payloadNoPromo);
        response = await fetch("https://chatgpt.com/backend-api/payments/checkout", fetchOpts);
      }
    }

    const text = await response.text();
    try { data = JSON.parse(text); } catch (e) {
      return res.status(502).json({ error: `Non-JSON (${response.status}): ${text.substring(0, 300)}` });
    }

    if (!response.ok) {
      return res.status(502).json({ error: `API error ${response.status}`, details: data });
    }

    console.log("  [3/3] ✓ Checkout response received");

    // Build output
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

    console.log("  → Done:", output.link ? "✓ Link generated" : "✗ No link");
    return res.json(output);

  } catch (err) {
    console.error("Error:", err.message);
    if (browser) try { await browser.close(); } catch (e) {}
    return res.status(500).json({ error: "Error: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Diaa Store GPT Pay running at http://localhost:${PORT}\n`);
});
