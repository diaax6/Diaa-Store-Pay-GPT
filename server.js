const express = require("express");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;
const CONFIG_PATH = path.join(__dirname, "config.json");
const CURL_CHROME = "/usr/local/bin/curl_chrome116";

// ── Helpers ───────────────────────────────────────────────────────────────
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// Sessions (in-memory)
const sessions = new Map(); // token → { role: "admin"|"user", createdAt }
const SESSION_TTL = 60 * 60 * 1000; // 1 hour

function createSession(role) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { role, createdAt: Date.now() });
  return token;
}

function getSession(req) {
  const token = req.cookies?.["session"];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  return s;
}

// Cookie parser middleware (simple)
app.use((req, res, next) => {
  req.cookies = {};
  const hdr = req.headers.cookie;
  if (hdr) hdr.split(";").forEach(c => {
    const [k, ...v] = c.trim().split("=");
    req.cookies[k] = v.join("=");
  });
  next();
});

app.use(express.json({ limit: "10mb" }));

// ── Auth middleware ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not authenticated" });
  req.userRole = session.role;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session || session.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  req.userRole = "admin";
  next();
}

// ── Static files (login page always accessible) ───────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Auth routes ───────────────────────────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;
  const cfg = loadConfig();

  let role = null;
  if (password === cfg.adminPassword) role = "admin";
  else if (password === cfg.userPassword) role = "user";

  if (!role) return res.status(401).json({ error: "Invalid password" });

  const token = createSession(role);
  res.setHeader("Set-Cookie", `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
  return res.json({ success: true, role });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.cookies?.["session"];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `session=; Path=/; HttpOnly; Max-Age=0`);
  return res.json({ success: true });
});

app.get("/api/auth/me", (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ authenticated: false });
  return res.json({ authenticated: true, role: session.role });
});

// ── Admin routes ──────────────────────────────────────────────────────────
app.get("/api/admin/config", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  return res.json({
    globalProxy: cfg.globalProxy || "",
    userPassword: cfg.userPassword || "",
  });
});

app.post("/api/admin/proxy", requireAdmin, (req, res) => {
  const { proxy } = req.body;
  const cfg = loadConfig();
  cfg.globalProxy = proxy || "";
  saveConfig(cfg);
  console.log(`[Admin] Global proxy set to: ${cfg.globalProxy || "(none)"}`);
  return res.json({ success: true, globalProxy: cfg.globalProxy });
});

app.post("/api/admin/passwords", requireAdmin, (req, res) => {
  const { adminPassword, userPassword } = req.body;
  const cfg = loadConfig();
  if (adminPassword) cfg.adminPassword = adminPassword;
  if (userPassword) cfg.userPassword = userPassword;
  saveConfig(cfg);
  return res.json({ success: true });
});

// ── Country configs ───────────────────────────────────────────────────────
const PROMO = { promo_campaign_id: "plus-1-month-free", is_coupon_from_query_param: false };
const COUNTRIES = {
  ID: { currency: "IDR", promo: PROMO },
  US: { currency: "USD", promo: PROMO },
  JP: { currency: "JPY", promo: PROMO },
  GB: { currency: "GBP", promo: PROMO },
};

// ── Parse session ─────────────────────────────────────────────────────────
app.post("/api/parse-session", requireAuth, (req, res) => {
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
      hasValidToken: true,
    },
  });
});

// ── curl-impersonate checkout ─────────────────────────────────────────────
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
    if (proxy) args.push("-x", proxy);
    args.push("https://chatgpt.com/backend-api/payments/checkout");

    execFile(CURL_CHROME, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl error: ${err.message}`));
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch (e) {
        if (stdout.includes("<html")) reject(new Error("Cloudflare blocked"));
        else reject(new Error(`Invalid response: ${stdout.substring(0, 200)}`));
      }
    });
  });
}

// ── Generate link ─────────────────────────────────────────────────────────
app.post("/api/generate-link", requireAuth, async (req, res) => {
  const { accessToken, offerCountry = "JP", billingCountry = "ID", mode = "hosted", proxy: userProxy } = req.body;

  const offer = offerCountry || "JP";
  const billing = billingCountry || "ID";

  if (!accessToken) return res.status(400).json({ error: "accessToken required" });

  const offerCC = COUNTRIES[offer];
  const billingCC = COUNTRIES[billing];
  if (!offerCC) return res.status(400).json({ error: "Unsupported offer country" });
  if (!billingCC) return res.status(400).json({ error: "Unsupported billing country" });

  // Determine proxy: user proxy → global proxy → none
  const cfg = loadConfig();
  const proxy = userProxy || cfg.globalProxy || null;

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
    console.log(`[${new Date().toISOString()}] Generate — offer:${offer} billing:${billing} | ${mode} | proxy:${proxy ? "yes" : "none"}`);

    let data;
    let promoSkipped = false;
    try {
      data = await curlCheckout(accessToken, payload, proxy);
      if (data.detail || data.error) throw new Error(data.detail || data.error);
    } catch (e) {
      if (payload.promo_campaign) {
        console.log("  → Promo failed, retrying without...");
        const noPromo = { ...payload };
        delete noPromo.promo_campaign;
        data = await curlCheckout(accessToken, noPromo, proxy);
        if (data.detail || data.error) {
          return res.status(502).json({ error: data.detail || data.error || e.message });
        }
        promoSkipped = true;
      } else {
        return res.status(502).json({ error: e.message });
      }
    }

    console.log("  → ✓ Success");

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
