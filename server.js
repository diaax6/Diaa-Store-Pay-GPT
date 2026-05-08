const express = require("express");
const { execFile } = require("child_process");
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

// Path to curl-impersonate-chrome binary
const CURL_CHROME = "/usr/local/bin/curl_chrome116";

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

// ── Call ChatGPT API using curl-impersonate (bypasses Cloudflare!) ─────────
function curlCheckout(accessToken, payload, proxy) {
  return new Promise((resolve, reject) => {
    const args = [
      "-s",
      "-X", "POST",
      "-H", `Authorization: Bearer ${accessToken}`,
      "-H", "Content-Type: application/json",
      "-H", "Accept: application/json",
      "-d", JSON.stringify(payload),
      "--max-time", "20",
    ];

    // Add proxy if provided (for Japan IP)
    if (proxy) args.push("-x", proxy);

    args.push("https://chatgpt.com/backend-api/payments/checkout");

    execFile(CURL_CHROME, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl error: ${err.message}`));
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch (e) {
        if (stdout.includes("<html")) {
          reject(new Error("Cloudflare blocked"));
        } else {
          reject(new Error(`Invalid response: ${stdout.substring(0, 200)}`));
        }
      }
    });
  });
}

// ── Generate link ─────────────────────────────────────────────────────────
app.post("/api/generate-link", async (req, res) => {
  const { accessToken, offerCountry = "JP", billingCountry = "ID", mode = "hosted", proxy } = req.body;

  // Back-compat
  const offer = offerCountry || req.body.country || "JP";
  const billing = billingCountry || req.body.country || "ID";

  if (!accessToken) return res.status(400).json({ error: "accessToken required" });

  const offerCC = COUNTRIES[offer];
  const billingCC = COUNTRIES[billing];
  if (!offerCC) return res.status(400).json({ error: "Unsupported offer country" });
  if (!billingCC) return res.status(400).json({ error: "Unsupported billing country" });

  // Build payload: promo from offer, billing from billing country
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

  try {
    console.log(`[${new Date().toISOString()}] Generate — offer:${offer} billing:${billing} | ${mode} | proxy:${proxy || "none"}`);

    // Try with promo first
    let data;
    let promoSkipped = false;
    try {
      data = await curlCheckout(accessToken, payload, proxy || null);
      if (data.detail || data.error) throw new Error(data.detail || data.error);
    } catch (e) {
      if (payload.promo_campaign) {
        console.log("  → Promo failed, retrying without...");
        const noPromo = { ...payload };
        delete noPromo.promo_campaign;
        data = await curlCheckout(accessToken, noPromo, proxy || null);
        if (data.detail || data.error) {
          return res.status(502).json({ error: data.detail || data.error || e.message });
        }
        promoSkipped = true;
      } else {
        return res.status(502).json({ error: e.message });
      }
    }

    console.log("  → ✓ Success");

    // Build output
    const output = { success: true, mode, promoSkipped, raw: data };

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
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Diaa Store GPT Pay running at http://localhost:${PORT}\n`);
});
