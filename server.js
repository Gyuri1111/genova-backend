// server.js — PROMPT + IMAGE SUPPORT (FINAL) + /notify (PREFS) + PUSH UTIL (FINAL)
//          + notifyUser (C1) + EMAIL (D) + GeNova HTML TEMPLATE (uses src/utils/emailTemplate.js)
//          + OFFLINE EDGE-CASE SUPPORT: lastResult + /my-latest-result + /mark-result-seen

const admin = require("firebase-admin");
const { Expo } = require("expo-server-sdk");
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

// ===== Render key bootstrap (CommonJS safe) =====
function writeJsonKeyFileIfMissing(relPath, envVarName) {
  try {
    const abs = path.resolve(process.cwd(), relPath);

    if (fs.existsSync(abs)) return;

    const raw = process.env[envVarName];
    if (!raw || !String(raw).trim()) {
      console.log(`⚠️ ENV ${envVarName} not set, skipping ${relPath}`);
      return;
    }

    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const json = JSON.parse(String(raw));
    fs.writeFileSync(abs, JSON.stringify(json, null, 2), "utf8");

    console.log(`🧾 Key file written: ${relPath}`);
  } catch (err) {
    console.error(`❌ Failed writing key file ${relPath} from ${envVarName}`, err);
  }
}

// Files expected by existing code
writeJsonKeyFileIfMissing("./firebase-admin-key.json", "FIREBASE_ADMIN_KEY_JSON");
writeJsonKeyFileIfMissing("./google-cloud-key.json", "GOOGLE_CLOUD_KEY_JSON");
// =================================================

const { Storage } = require("@google-cloud/storage");
const nodemailer = require("nodemailer");
require("dotenv").config();

const { emailTemplate } = require("./src/utils/emailTemplate");

const BUILD_TAG =
  "PROMPT_IMAGE_NOTIFYUSER_EMAIL_TEMPLATE_FIXED_2025-12-21__LASTRESULT_2025-12-21__PUSH_I18N_2025-12-26";


/* =========================
   HELPERS (TOP-LEVEL!)
========================= */

function addDaysToExpiry(existingUntilMs, days) {
  const now = Date.now();
  const base =
    Number.isFinite(existingUntilMs) && existingUntilMs > now
      ? existingUntilMs
      : now;

  return base + days * 24 * 60 * 60 * 1000;
}

function toMsFromTimestampLike(v) {
  if (!v) return null;

  if (typeof v === "number") {
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }

  if (typeof v === "string") {
    const d = new Date(v);
    return !isNaN(d.getTime()) ? d.getTime() : null;
  }

  if (typeof v === "object") {
    if (typeof v.toDate === "function") {
      const d = v.toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d.getTime() : null;
    }
    const sec =
  ("seconds" in v ? Number(v.seconds) : null) ??
  ("_seconds" in v ? Number(v._seconds) : null);

const ns =
  ("nanoseconds" in v ? Number(v.nanoseconds) : null) ??
  ("_nanoseconds" in v ? Number(v._nanoseconds) : null) ??
  0;

if (Number.isFinite(sec) && sec > 0) {
  return sec * 1000 + (Number.isFinite(ns) ? Math.floor(ns / 1e6) : 0);
}
  }

  return null;
}


const app = express();

function getPublicBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

app.use(express.json({ limit: "10mb" }));

console.log("🔥 RUNNING SERVER FILE:", __filename);
console.log("🔥 BUILD:", BUILD_TAG);

// ------------------------------------------------------------
// Firebase Admin init
// ------------------------------------------------------------
if (!admin.apps.length) {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : require("./firebase-admin-key.json");

  admin.initializeApp({
    credential: admin.credential.cert(sa),
  });
}

const db = admin.firestore();
const expo = new Expo();

// ------------------------------------------------------------
// Auth middleware
// ------------------------------------------------------------
const verifyFirebaseToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token)
    return res
      .status(401)
      .json({ success: false, error: "Missing Bearer token" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;

    // Auto-expiry cleanup (best-effort) so expired entitlements are cleared ASAP
    cleanupExpiredEntitlementsForUser(req.uid)
      .catch((e) => console.log('⚠️ cleanupExpiredEntitlementsForUser failed:', e?.message || e));

    next();
  } catch {
    return res.status(403).json({ success: false, error: "Invalid token" });
  }
};


// Manual trigger from the app (call on app start / Store open)
// Clears ONLY expired entitlement Until fields (no plan changes).
app.post("/cleanup-me", verifyFirebaseToken, async (req, res) => {
  try {
    await cleanupExpiredEntitlementsForUser(req.uid);
    return res.json({ success: true });
  } catch (e) {
    console.log("❌ /cleanup-me error:", e);
    return res.status(500).json({ success: false, error: "CLEANUP_FAILED" });
  }
});

// ------------------------------------------------------------
// Health + Version
// ------------------------------------------------------------


// ------------------------------------------------------------
// Expiry cleanup helpers (server-side safety net)
// - Clears expired entitlements and reverts expired plans to FREE
// - Also ensures promptBuilderUntil is ONLY for Studio plan
// ------------------------------------------------------------
function buildExpiryCleanupPatch(userData, nowMs) {
  const patch = {};
  const currentPlan = (userData && userData.plan) ? String(userData.plan) : "free";

  const ent = (userData && userData.entitlements && typeof userData.entitlements === "object")
    ? userData.entitlements
    : {};

  // Plan expiry: if planUntil expired -> fall back to FREE (no stacking here)
  const planUntilMs = toMsFromTimestampLike(userData?.planUntil);
  if (planUntilMs && planUntilMs <= nowMs) {
    patch["plan"] = "free";
    patch["planUntil"] = null;
  }

  const entitlementKeys = [
    "adFreeUntil",
    "noWatermarkUntil",
    "templatesUntil",
    "proPromptUntil",
    "promptBuilderUntil",
  ];

  for (const k of entitlementKeys) {
    const ms = toMsFromTimestampLike(ent[k]);
    if (ms && ms <= nowMs) {
      patch[`entitlements.${k}`] = null;
    }
  }

  const effectivePlan = currentPlan;
  if (effectivePlan !== "studio") {
    // Prompt Builder is Studio-only; always clear for non-studio
    patch["entitlements.promptBuilderUntil"] = null;
  } else {
    // Studio plan active: keep Prompt Builder aligned with planUntil
    const studioPlanUntilMs = toMsFromTimestampLike(userData?.planUntil);
    if (studioPlanUntilMs) {
      patch["entitlements.promptBuilderUntil"] = admin.firestore.Timestamp.fromMillis(studioPlanUntilMs);
    } else {
      // If somehow planUntil missing, be safe and clear
      patch["entitlements.promptBuilderUntil"] = null;
    }
  }

  return patch;
}

async function cleanupExpiredEntitlementsForUser(uid) {
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return;
    const userData = snap.data() || {};
    const patch = buildExpiryCleanupPatch(userData, Date.now());
    if (Object.keys(patch).length) {
      tx.update(userRef, patch);
    }
  });
}



app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/version", (_, res) => res.json({ ok: true, build: BUILD_TAG }));

// ------------------------------------------------------------
// 🌍 i18n helpers (EN/HU/DE) for PUSH + lastResult
// ------------------------------------------------------------
function normalizeLang(lang) {
  const l = String(lang || "").trim().toLowerCase();
  if (l.startsWith("hu")) return "hu";
  if (l.startsWith("de")) return "de";
  return "en";
}

function getUserLang(userDoc) {
  // priority: notifPrefs.language (as agreed)
  const prefLang = userDoc?.notifPrefs?.language;
  return normalizeLang(prefLang);
}

function formatVideoMetaLine({ lang, model, videoLength, resolution, fps }) {
  const m = model || "";
  const len = videoLength ?? "";
  const res = resolution || "";
  const f = fps ?? "";

  if (lang === "hu") {
    // "Modell" Hungarian spelling often "Modell", but "Model" is also OK. Using "Modell" for HU.
    return `Modell: ${m} • ${len}s • ${res} • ${f}fps`;
  }
  if (lang === "de") {
    return `Modell: ${m} • ${len}s • ${res} • ${f}fps`;
  }
  return `Model: ${m} • ${len}s • ${res} • ${f}fps`;
}

/**
 * Localize notifications by type. Uses data if available.
 * Returns { title, body }.
 */
function localizeNotification({ lang, type, title, body, data }) {
  const L = normalizeLang(lang);

  const model = data?.model ?? data?.meta?.model ?? "";
  const videoLength = data?.videoLength ?? data?.meta?.length ?? "";
  const resolution = data?.resolution ?? data?.meta?.resolution ?? "";
  const fps = data?.fps ?? data?.meta?.fps ?? "";

  if (type === "video") {
    const t =
      L === "hu"
        ? "🎬 A videó elkészült"
        : L === "de"
        ? "🎬 Dein Video ist fertig"
        : "🎬 Your video has been generated";

    const b =
      model || videoLength || resolution || fps
        ? formatVideoMetaLine({ lang: L, model, videoLength, resolution, fps })
        : body || "";

    return { title: t, body: b };
  }

  if (type === "system") {
    const t =
      L === "hu"
        ? "⚠️ Generálás sikertelen"
        : L === "de"
        ? "⚠️ Generierung fehlgeschlagen"
        : "⚠️ Generation failed";
    const b = body || (L === "hu" ? "Ismeretlen hiba" : L === "de" ? "Unbekannter Fehler" : "Unknown error");
    return { title: t, body: b };
  }

  if (type === "marketing") {
    // Keep provided title if it's custom, otherwise localize a generic one
    const t =
      title?.trim()
        ? title
        : L === "hu"
        ? "📣 GeNova újdonság"
        : L === "de"
        ? "📣 GeNova Update"
        : "📣 GeNova update";
    const b = body || "";
    return { title: t, body: b };
  }

  // default/generic
  return { title: title || "GeNova", body: body || "" };
}

// ------------------------------------------------------------
// 🔔 PUSH HELPERS (prefs + safe send)
// ------------------------------------------------------------
function allowByPrefs(type, userDoc) {
  const p = userDoc?.notifPrefs;
  if (!p?.pushNotif) return false;

  if (type === "video") return !!p.videoNotif;
  if (type === "system") return !!p.systemNotif;
  if (type === "marketing") return !!p.marketingNotif;

  // NOTE: emailNotif is not a push type; kept for completeness only.
  if (type === "email") return !!p.emailNotif;

  return false;
}

async function getUserDoc(uid) {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return null;
  return snap.data();
}

/**
 * ------------------------------------------------------------
 * Monetization (v1): Credits + time-based add-ons (entitlements)
 * - Source of truth: Firestore users/{uid}
 * - Credits debit is enforced server-side (transactions)
 * - Add-ons can be purchased for 7d / 30d (extend if already active)
 * ------------------------------------------------------------
 */

const MONETIZATION = {
  TRIAL_CREDITS: 5,
  DEFAULT_PLAN: "free",
  GENERATION_COST: 1, // credits per generation
  ADDONS: {
    // Watermark removal (time-based)
    no_watermark_7d: { cost: 50, days: 7, entitlementKey: "noWatermarkUntil" },
    no_watermark_30d: { cost: 150, days: 30, entitlementKey: "noWatermarkUntil" },

    // Ad-free (time-based) — for future UI/ads
    ad_free_7d: { cost: 20, days: 7, entitlementKey: "adFreeUntil" },
    ad_free_30d: { cost: 50, days: 30, entitlementKey: "adFreeUntil" },


// Templates access (time-based) — 7d and 30d grant their respective durations
templates_7d: { cost: 20, days: 7, entitlementKey: "templatesUntil" },
templates_30d: { cost: 50, days: 30, entitlementKey: "templatesUntil" },

// PRO Prompt Pack (time-based) — 7d and 30d grant their respective durations
pro_prompt_7d: { cost: 20, days: 7, entitlementKey: "proPromptUntil" },
pro_prompt_30d: { cost: 50, days: 30, entitlementKey: "proPromptUntil" },
  },
};


// ✅ Pack catalog (credit costs). Keep IDs in sync with src/data/promptPacks.js
const PACK_CATALOG = {
  product_pro: { cost: 60, tier: "pro" },
  // add more packs here later...
};


// 💰 Monetization v2 — compute-based costs + plan limits (hard caps)
// - Cost depends on: length, resolution, fps, model
// - Plan controls max allowed params + watermark defaults
const BILLING = {
  HARD_CAPS: {
    MAX_LENGTH_SEC: 20,
    MAX_FPS: 60,
  },
  // Allowed maxima per plan (v1)
  PLAN_LIMITS: {
    free:   { maxLength: 5,  maxFps: 30, maxResolution: "720p" },
    basic:  { maxLength: 5,  maxFps: 30, maxResolution: "1080p" },
    pro:    { maxLength: 10, maxFps: 60, maxResolution: "4k" },
    studio: { maxLength: 20, maxFps: 60, maxResolution: "4k" },
  },
  // Cost factors
  FPS_FACTOR: {
    24: 0.8,
    30: 1.0,
    60: 2.0,
  },
  RES_FACTOR: {
    "720p": 1.0,
    "1080p": 1.5,
    "4k": 3.0,
  },
  // Model cost multipliers (v1 defaults)
  MODEL_FACTOR: {
    kling: 1.0,
    veo: 1.4,
    runway: 1.3,
    pika: 1.2,
    svd: 1.0,
    default: 1.0,
  },
};

function normalizePlan(p) {
  const plan = String(p || MONETIZATION.DEFAULT_PLAN).toLowerCase();
  return BILLING.PLAN_LIMITS[plan] ? plan : MONETIZATION.DEFAULT_PLAN;
}

function normalizeResolution(res) {
  const r = String(res || "").toLowerCase().trim();
  if (r.includes("4k") || r.includes("2160")) return "4k";
  if (r.includes("1080")) return "1080p";
  if (r.includes("720")) return "720p";
  // fallback
  return "1080p";
}

function clampInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function resRank(r) {
  return r === "4k" ? 3 : (r === "1080p" ? 2 : 1);
}

function enforceCapsAndLimits({ plan, lengthSec, fps, resolution }) {
  // Hard caps
  if (lengthSec > BILLING.HARD_CAPS.MAX_LENGTH_SEC) {
    const err = new Error("LIMIT_HARD_CAP_LENGTH");
    err.code = "LIMIT_HARD_CAP_LENGTH";
    err.meta = { max: BILLING.HARD_CAPS.MAX_LENGTH_SEC, got: lengthSec };
    throw err;
  }
  if (fps > BILLING.HARD_CAPS.MAX_FPS) {
    const err = new Error("LIMIT_HARD_CAP_FPS");
    err.code = "LIMIT_HARD_CAP_FPS";
    err.meta = { max: BILLING.HARD_CAPS.MAX_FPS, got: fps };
    throw err;
  }

  const p = normalizePlan(plan);
  const limits = BILLING.PLAN_LIMITS[p] || BILLING.PLAN_LIMITS.free;

  if (lengthSec > limits.maxLength) {
    const err = new Error("LIMIT_LENGTH");
    err.code = "LIMIT_LENGTH";
    err.meta = { max: limits.maxLength, got: lengthSec, plan: p };
    throw err;
  }

  if (fps > limits.maxFps) {
    const err = new Error("LIMIT_FPS");
    err.code = "LIMIT_FPS";
    err.meta = { max: limits.maxFps, got: fps, plan: p };
    throw err;
  }

  if (resRank(resolution) > resRank(limits.maxResolution)) {
    const err = new Error("LIMIT_RESOLUTION");
    err.code = "LIMIT_RESOLUTION";
    err.meta = { max: limits.maxResolution, got: resolution, plan: p };
    throw err;
  }

  return { plan: p, limits };
}

function computeGenerationCost({ lengthSec, fps, resolution, model }) {
  const baseUnits = Math.max(1, Math.ceil(lengthSec / 5)); // 1 unit per 5s
  const fpsKey = fps >= 60 ? 60 : (fps <= 24 ? 24 : 30);
  const fpsFactor = BILLING.FPS_FACTOR[fpsKey] ?? 1.0;
  const resFactor = BILLING.RES_FACTOR[resolution] ?? 1.0;
  const modelKey = String(model || "").toLowerCase().trim();
  const modelFactor = BILLING.MODEL_FACTOR[modelKey] ?? BILLING.MODEL_FACTOR.default ?? 1.0;

  const cost = Math.max(1, Math.ceil(baseUnits * fpsFactor * resFactor * modelFactor));
  return { cost, breakdown: { baseUnits, fpsKey, fpsFactor, resFactor, modelFactor } };
}


function isTsLike(v) {
  return v && typeof v === "object" && typeof v.toDate === "function";
}

function tsNow() {
  return admin.firestore.Timestamp.now();
}

function addDaysTs(baseTs, days) {
  const base = isTsLike(baseTs) ? baseTs.toDate() : new Date();
  return admin.firestore.Timestamp.fromDate(new Date(base.getTime() + days * 24 * 60 * 60 * 1000));
}

function entitlementActive(untilTs) {
  if (!isTsLike(untilTs)) return false;
  return untilTs.toMillis() > tsNow().toMillis();
}

function computeWatermarkApplied(userData) {
  const plan = String(userData?.plan || MONETIZATION.DEFAULT_PLAN);
  const ent = userData?.entitlements || {};
  const noWm = entitlementActive(ent?.noWatermarkUntil);
  const planNoWm = plan === "pro" || plan === "studio";
  return !(planNoWm || noWm);
}


async function ensureTrialValidateAndDebit(uid, genParams) {
  // genParams: { model, lengthSec, fps, resolution }
  const userRef = db.collection("users").doc(uid);

  let result = {
    creditsBefore: 0,
    creditsAfter: 0,
    plan: MONETIZATION.DEFAULT_PLAN,
    entitlements: {},
    watermarkApplied: true,
    trialGranted: false,
    cost: 0,
    breakdown: {},
    limits: BILLING.PLAN_LIMITS.free,
    normalized: {},
  };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);

    // If missing, create minimal doc and grant trial once
    if (!snap.exists) {
      const init = {
        plan: MONETIZATION.DEFAULT_PLAN,
        credits: MONETIZATION.TRIAL_CREDITS,
        trialCreditsGranted: true,
        entitlements: {},
        notifPrefs: {},
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Validate/cost under free plan caps
      const planInfo = enforceCapsAndLimits({
        plan: init.plan,
        lengthSec: genParams.lengthSec,
        fps: genParams.fps,
        resolution: genParams.resolution,
      });
      const costInfo = computeGenerationCost({
        lengthSec: genParams.lengthSec,
        fps: genParams.fps,
        resolution: genParams.resolution,
        model: genParams.model,
      });

      tx.set(userRef, init, { merge: true });

      const credits = init.credits || 0;
      result.trialGranted = true;
      result.plan = planInfo.plan;
      result.entitlements = init.entitlements;
      result.watermarkApplied = computeWatermarkApplied({ plan: planInfo.plan, entitlements: init.entitlements });
      result.limits = planInfo.limits;
      result.cost = costInfo.cost;
      result.breakdown = costInfo.breakdown;
      result.normalized = { ...genParams, plan: planInfo.plan };

      if (credits < costInfo.cost) {
        const err = new Error("NO_CREDITS");
        err.code = "NO_CREDITS";
        throw err;
      }

      result.creditsBefore = credits;
      result.creditsAfter = credits - costInfo.cost;

      tx.update(userRef, {
        credits: admin.firestore.FieldValue.increment(-costInfo.cost),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return;
    }

    const data = snap.data() || {};
    const credits = Number(data.credits ?? 0);
    const plan = normalizePlan(data.plan);
    const entitlements = data.entitlements || {};

    // Grant trial once if needed (legacy users)
    if (!data.trialCreditsGranted) {
      tx.update(userRef, {
        credits: admin.firestore.FieldValue.increment(MONETIZATION.TRIAL_CREDITS),
        trialCreditsGranted: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      result.trialGranted = true;
    }

    const creditsEffective = credits + (data.trialCreditsGranted ? 0 : MONETIZATION.TRIAL_CREDITS);

    // Validate params under plan limits (hard caps included)
    const planInfo = enforceCapsAndLimits({
      plan,
      lengthSec: genParams.lengthSec,
      fps: genParams.fps,
      resolution: genParams.resolution,
    });

    const costInfo = computeGenerationCost({
      lengthSec: genParams.lengthSec,
      fps: genParams.fps,
      resolution: genParams.resolution,
      model: genParams.model,
    });

    result.plan = planInfo.plan;
    result.entitlements = entitlements;
    result.watermarkApplied = computeWatermarkApplied({ plan: planInfo.plan, entitlements });
    result.limits = planInfo.limits;
    result.cost = costInfo.cost;
    result.breakdown = costInfo.breakdown;
    result.normalized = { ...genParams, plan: planInfo.plan };

    result.creditsBefore = creditsEffective;

    if (creditsEffective < costInfo.cost) {
      const err = new Error("NO_CREDITS");
      err.code = "NO_CREDITS";
      throw err;
    }

    result.creditsAfter = creditsEffective - costInfo.cost;

    tx.update(userRef, {
      credits: admin.firestore.FieldValue.increment(-costInfo.cost),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return result;
}

async function ensureTrialAndDebitCredits(uid, cost) {
  const userRef = db.collection("users").doc(uid);

  let result = {
    creditsBefore: 0,
    creditsAfter: 0,
    plan: MONETIZATION.DEFAULT_PLAN,
    entitlements: {},
    watermarkApplied: true,
    trialGranted: false,
  };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);

    // Create user doc if missing (minimal), and grant trial once
    if (!snap.exists) {
      const init = {
        credits: MONETIZATION.TRIAL_CREDITS,
        plan: MONETIZATION.DEFAULT_PLAN,
        trialCreditsGranted: true,
        entitlements: {},
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.set(userRef, init, { merge: true });

      const credits = init.credits || 0;
      result.trialGranted = true;
      result.plan = init.plan;
      result.entitlements = init.entitlements;
      result.watermarkApplied = computeWatermarkApplied(init);

      if (credits < cost) {
        const err = new Error("NO_CREDITS");
        err.code = "NO_CREDITS";
        throw err;
      }

      result.creditsBefore = credits;
      result.creditsAfter = credits - cost;

      tx.update(userRef, {
        credits: admin.firestore.FieldValue.increment(-cost),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return;
    }

    const data = snap.data() || {};
    const credits = Number(data.credits ?? 0);
    const plan = String(data.plan || MONETIZATION.DEFAULT_PLAN);
    const entitlements = data.entitlements || {};

    // Grant trial once if not granted yet
    if (!data.trialCreditsGranted) {
      tx.update(userRef, {
        credits: admin.firestore.FieldValue.increment(MONETIZATION.TRIAL_CREDITS),
        plan: plan || MONETIZATION.DEFAULT_PLAN,
        trialCreditsGranted: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      result.trialGranted = true;
    }

    const creditsEffective = credits + (data.trialCreditsGranted ? 0 : MONETIZATION.TRIAL_CREDITS);

    result.plan = plan;
    result.entitlements = entitlements;
    result.watermarkApplied = computeWatermarkApplied({ plan, entitlements });
    result.creditsBefore = creditsEffective;

    if (creditsEffective < cost) {
      const err = new Error("NO_CREDITS");
      err.code = "NO_CREDITS";
      throw err;
    }

    result.creditsAfter = creditsEffective - cost;

    tx.update(userRef, {
      credits: admin.firestore.FieldValue.increment(-cost),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return result;
}

async function buyAddon(uid, addonKey) {
  const cfg = MONETIZATION.ADDONS[addonKey];
  if (!cfg) {
    const err = new Error("UNKNOWN_ADDON");
    err.code = "UNKNOWN_ADDON";
    throw err;
  }

  const userRef = db.collection("users").doc(uid);
  let out = { addon: addonKey, cost: cfg.cost, creditsBefore: 0, creditsAfter: 0, entitlementKey: cfg.entitlementKey, until: null };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) {
      const err = new Error("USER_NOT_FOUND");
      err.code = "USER_NOT_FOUND";
      throw err;
    }
    const data = snap.data() || {};
    const credits = Number(data.credits ?? 0);
    if (credits < cfg.cost) {
      const err = new Error("NO_CREDITS");
      err.code = "NO_CREDITS";
      throw err;
    }

    const ent = data.entitlements || {};
    const currentUntil = ent?.[cfg.entitlementKey];
    const base = entitlementActive(currentUntil) ? currentUntil : tsNow();
    const nextUntil = addDaysTs(base, cfg.days);

    out.creditsBefore = credits;
    out.creditsAfter = credits - cfg.cost;
    out.until = nextUntil;

    tx.update(userRef, {
      credits: admin.firestore.FieldValue.increment(-cfg.cost),
      [`entitlements.${cfg.entitlementKey}`]: nextUntil,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return out;
}

async function sendPush(userDoc, payload) {
  try {
    const token = userDoc?.expoPushToken;
    if (!token) return { skipped: true, reason: "no_token" };
    if (!Expo.isExpoPushToken(token))
      return { skipped: true, reason: "invalid_token" };
    if (!allowByPrefs(payload.type, userDoc))
      return { skipped: true, reason: "prefs" };

    const messages = [
      {
        to: token,
        sound: "default",
        title: payload.title || "GeNova",
        body: payload.body || "",
        data: payload.data || {},
        priority: "high",
      },
    ];

    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];

    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    }

    return { success: true, tickets };
  } catch (e) {
    console.log("❌ sendPush error:", e);
    return { success: false, error: e?.message || "push_error" };
  }
}

// ------------------------------------------------------------
// ✉️ EMAIL HELPERS (MailerSend primary, SMTP fallback)
// ------------------------------------------------------------
function canEmailByPrefs(userDoc) {
  const p = userDoc?.notifPrefs;
  return !!p?.emailNotif;
}

async function resolveUserEmail(uid, userDoc) {
  if (userDoc?.email) return userDoc.email;

  // fallback: Firebase Auth
  try {
    const u = await admin.auth().getUser(uid);
    if (u?.email) return u.email;
  } catch (_) {}

  return null;
}

/**
 * Build BOTH: text + html
 * - html is the GeNova template
 * - text kept minimal to avoid "mixed" looking previews in some clients
 *
 * ✅ marketing: can optionally include a CTA button if data.url exists
 */
function buildEmailForType(type, { title, body, data }) {
  const safeTitle = title || "GeNova notification";
  const safeBody = body || "";

  if (type === "video") {
    const videoUrl = data?.videoUrl || "";
    return {
      subject: "🎬 Your GeNova video is ready",
      text: safeBody || "Your video is ready.",
      html: emailTemplate({
        title: safeTitle,
        message: safeBody,
        buttonText: "View video",
        buttonUrl: videoUrl || null,
      }),
    };
  }

  // NOTE: system email template exists, but SYSTEM emails are DISABLED by policy (see sendEmailIfAllowed)
  if (type === "system") {
    return {
      subject: "⚠️ GeNova: system message",
      text: safeBody || "System message.",
      html: emailTemplate({
        title: safeTitle,
        message: safeBody,
        buttonText: null,
        buttonUrl: null,
      }),
    };
  }

  if (type === "marketing") {
    const url = data?.url || null;
    const btnText = data?.buttonText || "Open";
    return {
      subject: safeTitle || "GeNova update",
      text: safeBody || "Update.",
      html: emailTemplate({
        title: safeTitle || "GeNova update",
        message: safeBody,
        buttonText: url ? btnText : null,
        buttonUrl: url,
      }),
    };
  }

  // generic
  const url = data?.url || null;
  const btnText = data?.buttonText || "Open";
  return {
    subject: safeTitle,
    text: safeBody || "Notification.",
    html: emailTemplate({
      title: safeTitle,
      message: safeBody,
      buttonText: url ? btnText : null,
      buttonUrl: url,
    }),
  };
}

async function sendEmailMailerSend({ to, subject, text, html }) {
  const apiKey = process.env.MAILERSEND_API_KEY;
  if (!apiKey) throw new Error("MAILERSEND_API_KEY missing");

  const fromEmail = process.env.MAIL_FROM_EMAIL;
  const fromName = process.env.MAIL_FROM_NAME || "GeNova";
  if (!fromEmail) throw new Error("MAIL_FROM_EMAIL missing");

  const res = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: { email: fromEmail, name: fromName },
      to: [{ email: to }],
      subject,
      text: text || "",
      html: html || "",
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.message || `MailerSend error (${res.status})`);
  }
  return json;
}

async function sendEmailSMTP({ to, subject, text, html }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false") === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  const fromEmail = process.env.MAIL_FROM_EMAIL || user;
  const fromName = process.env.MAIL_FROM_NAME || "GeNova";

  if (!host || !user || !pass) {
    throw new Error("SMTP env missing (SMTP_HOST/USER/PASS)");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text: text || "",
    html: html || "",
  });

  return { ok: true };
}

async function sendEmailWithFallback({ to, subject, text, html }) {
  try {
    const r = await sendEmailMailerSend({ to, subject, text, html });
    return { success: true, provider: "mailersend", resp: r };
  } catch (e) {
    console.log("⚠️ MailerSend failed, trying SMTP fallback:", e?.message || e);
  }

  const r2 = await sendEmailSMTP({ to, subject, text, html });
  return { success: true, provider: "smtp", resp: r2 };
}

async function sendEmailIfAllowed({ uid, userDoc, type, title, body, data }) {
  if (!userDoc) return { skipped: true, reason: "no_userdoc" };
  if (!canEmailByPrefs(userDoc)) return { skipped: true, reason: "prefs" };

  // ✅ POLICY: system messages MUST NOT be sent via email.
  // Only allow "video" (and you can later add "marketing" if you want).
  const allowedTypes = new Set(["video"]);
  if (!allowedTypes.has(type)) return { skipped: true, reason: "type_not_enabled" };

  const to = await resolveUserEmail(uid, userDoc);
  if (!to) return { skipped: true, reason: "no_email" };

  const built = buildEmailForType(type, { title, body, data });
  const result = await sendEmailWithFallback({ to, ...built });
  return result;
}

// ------------------------------------------------------------
// ✅ lastResult helpers (offline / push-missed safety net)
// ------------------------------------------------------------
async function setLastResult(uid, payload) {
  if (!uid) return;
  await db
    .collection("users")
    .doc(uid)
    .set(
      {
        lastResult: {
          id: payload?.id || String(Date.now()),
          status: payload?.status || "ready", // "ready" | "error"
          title: payload?.title || "",
          message: payload?.message || "",
          url: payload?.url || "",
          meta: payload?.meta || {},
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          seenAt: null,
        },
      },
      { merge: true }
    );
}

function normalizeLastResultMeta({ model, videoLength, resolution, fps } = {}) {
  return {
    model: model || "",
    length:
      typeof videoLength === "number" || typeof videoLength === "string"
        ? videoLength
        : "",
    resolution: resolution || "",
    fps:
      typeof fps === "number" || typeof fps === "string"
        ? fps
        : "",
  };
}

// ------------------------------------------------------------
// ✅ notifyUser (C1 + D) — single entrypoint for ALL notifications
//      ✅ NOW: localized by Firestore users/{uid}.notifPrefs.language
// ------------------------------------------------------------
async function notifyUser({ uid, type, title, body, data }) {
  if (!uid) return { skipped: true, reason: "no_uid" };
  if (!type) return { skipped: true, reason: "no_type" };

  const userDoc = await getUserDoc(uid);
  if (!userDoc) return { skipped: true, reason: "user_not_found" };

  // ✅ Localize push (and we pass same localized texts into email builder too)
  const lang = getUserLang(userDoc);
  const localized = localizeNotification({ lang, type, title, body, data });

  // 1) PUSH
  const pushResult = await sendPush(userDoc, {
    type,
    title: localized.title,
    body: localized.body,
    data: data || {},
  });

  // 2) EMAIL
  let emailResult = null;
  try {
    emailResult = await sendEmailIfAllowed({
      uid,
      userDoc,
      type,
      title: localized.title,
      body: localized.body,
      data,
    });
  } catch (e) {
    console.log("❌ email send error:", e?.message || e);
    emailResult = { success: false, error: e?.message || "email_error" };
  }

  return { pushResult, emailResult, lang };
}

// ------------------------------------------------------------
// ✅ /notify endpoint (B) — backend decides by Firestore prefs
// ------------------------------------------------------------
app.post("/notify", verifyFirebaseToken, async (req, res) => {
  try {
    const { type, title, body, data } = req.body || {};
    if (!type)
      return res.status(400).json({ success: false, error: "type required" });

    const result = await notifyUser({ uid: req.uid, type, title, body, data });
    return res.json({ success: true, result });
  } catch (e) {
    console.log("❌ /notify error:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "server_error" });
  }
});

// ------------------------------------------------------------
// ✅ OFFLINE EDGE-CASE ENDPOINTS
// ------------------------------------------------------------

/**
 * Returns the lastResult if it exists and has not been seen yet.
 * Client calls this on app start and on foreground to recover missed pushes.
 */
app.get("/my-latest-result", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;

    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists)
      return res
        .status(404)
        .json({ success: false, error: "User doc not found" });

    const userDoc = snap.data() || {};
    const lr = userDoc.lastResult || null;

    if (!lr) return res.json({ success: true, result: null });
    if (lr.seenAt) return res.json({ success: true, result: null });

    return res.json({ success: true,
      result: {
        id: lr.id || null,
        status: lr.status || null,
        title: lr.title || "",
        message: lr.message || "",
        url: lr.url || "",
        meta: lr.meta || {},
        createdAt: lr.createdAt || null,
      },
    });
  } catch (e) {
    console.log("❌ /my-latest-result error:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "server_error" });
  }
});

/**
 * Marks lastResult as seen (best-effort). Optionally checks id matches.
 */
app.post("/mark-result-seen", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { id } = req.body || {};

    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists)
      return res
        .status(404)
        .json({ success: false, error: "User doc not found" });

    const userDoc = snap.data() || {};
    const lr = userDoc.lastResult || null;
    if (!lr) return res.json({ success: true });

    if (id && lr.id && id !== lr.id) {
      // not the current lastResult anymore -> ignore
      return res.json({ success: true });
    }

    await userRef.set(
      { lastResult: { ...lr, seenAt: admin.firestore.FieldValue.serverTimestamp() } },
      { merge: true }
    );

    return res.json({ success: true });
  } catch (e) {
    console.log("❌ /mark-result-seen error:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "server_error" });
  }
});

// ------------------------------------------------------------
// Upload (multer)
// ------------------------------------------------------------
const upload = multer({ dest: "uploads/" });

// ------------------------------------------------------------
// GCS
// ------------------------------------------------------------
const storage = new Storage({
  projectId: "genova-27d76",
  keyFilename: "./google-cloud-key.json",
});
const bucket = storage.bucket("genova-27d76.firebasestorage.app");

// ------------------------------------------------------------
// Dummy generators (placeholder)
// ------------------------------------------------------------
const PLACEHOLDER_MP4_BASE64 =
  "AAAAHGZ0eXBpc29tAAAAAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAABXRtZGF0AAAAAA==";

async function genFromPrompt(out) {
  fs.writeFileSync(out, Buffer.from(PLACEHOLDER_MP4_BASE64, "base64"));
}
async function genFromImage(inp, out) {
  fs.copyFileSync(inp, out);
}


// ----------------------------------------------------
// Generation routes (video + prompt) — required by app
// ----------------------------------------------------

// Serve a tiny placeholder MP4 so the app always receives a playable URL
app.get("/placeholder.mp4", (req, res) => {
  try {
    const buf = Buffer.from(PLACEHOLDER_MP4_BASE64, "base64");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).send("placeholder_error");
  }
});

// Prompt-only (used by Prompt Builder / prompt enhancement flows)
app.post("/generate-prompt", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { prompt } = req.body || {};
    const p = String(prompt || "").trim();
    if (!p) return res.status(400).json({ success: false, error: "MISSING_PROMPT" });

    // For now we keep it deterministic and safe:
    // - normalize whitespace
    // - return as "enhanced" prompt (you can swap in an LLM later)
    const enhanced = p.replace(/\s+/g, " ").trim();

    return res.json({ success: true, prompt: enhanced, enhancedPrompt: enhanced, result: enhanced, uid });
  } catch (e) {
    console.error("❌ /generate-prompt error:", e);
    return res.status(500).json({ success: false, error: "PROMPT_FAILED" });
  }
});

// Backwards-compatible alias (if any older client calls it)
app.post("/prompt-only", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { prompt } = req.body || {};
    const p = String(prompt || "").trim();
    if (!p) return res.status(400).json({ success: false, error: "MISSING_PROMPT" });
    const enhanced = p.replace(/\s+/g, " ").trim();
    return res.json({ success: true, prompt: enhanced, enhancedPrompt: enhanced, result: enhanced, uid });
  } catch (e) {
    console.error("❌ /prompt-only error:", e);
    return res.status(500).json({ success: false, error: "PROMPT_FAILED" });
  }
});

// Main video generation route (HomeScreen uses multipart FormData with optional file)
app.post("/generate-video", verifyFirebaseToken, upload.single("file"), async (req, res) => {
  try {
    const uid = req.uid;
    const hasFile = !!req.file;

    // In multipart, fields arrive as strings
    const body = req.body || {};
    const prompt = String(body.prompt || body.text || "").trim();
    const model = String(body.model || "kling").trim();
    const lengthSec = Math.max(1, Math.min(60, Number(body.lengthSec ?? body.length ?? 5)));
    const fps = Math.max(1, Math.min(120, Number(body.fps ?? 30)));
    const resolution = String(body.resolution || body.res || "720p").trim();

    if (!prompt && !hasFile) {
      return res.status(400).json({ success: false, error: "MISSING_INPUT" });
    }

    // ✅ Billing + plan limits + credit debit (transaction)
    const billing = await ensureTrialValidateAndDebit(uid, {
      model,
      lengthSec,
      fps,
      resolution,
    });

    // Build result skeleton
    const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = admin.firestore.Timestamp.now();

    const meta = {
      model,
      lengthSec,
      fps,
      resolution,
      watermarkApplied: !!billing?.watermarkApplied,
      cost: billing?.cost ?? null,
      breakdown: billing?.breakdown ?? {},
      hasImage: !!req.file,
    };

    // Mark as processing first
    await setLastResult(uid, {
      id,
      status: "processing",
      title: "",
      message: "",
      url: "",
      meta,
      createdAt,
    });

    // --- Placeholder "generation" (replace with real provider call later) ---
    // We serve a static placeholder mp4 from this server.
    const baseUrl = `https://${req.get("host")}`;
    const url = `${baseUrl}/placeholder.mp4`;

    // Mark as ready
    await setLastResult(uid, {
      id,
      status: "ready",
      title: "",
      message: "",
      url,
      meta,
      createdAt,
    });

    // Send push/email if enabled
    try {
      await notifyUser({
        uid,
        type: "video",
        data: {
          url,
          model,
          lengthSec,
          fps,
          resolution,
        },
      });
    } catch (e) {
      console.warn("⚠️ notifyUser failed:", e?.message || e);
    }

    return res.json({ success: true,
      result: { id, status: "ready", url, meta, createdAt },
      billing,
    });
  } catch (e) {
    console.error("❌ /generate-video error:", e);
    const code = e?.code || e?.message || "GENERATE_FAILED";
    return res.status(400).json({ success: false, error: code, meta: e?.meta || null });
  }
});


// ------------------------------------------------------------
// 🎬 MAIN ROUTE — prompt + image support + notifyUser (C1 + D)
//          + lastResult write for offline recovery
// ------------------------------------------------------------


async function buyPack({ uid, packId }) {
  if (!uid) throw new Error("NO_UID");
  if (!packId || typeof packId !== "string") throw new Error("NO_PACK_ID");

  const cfg = PACK_CATALOG[String(packId).trim()];
  if (!cfg) {
    const err = new Error("UNKNOWN_PACK");
    err.code = "UNKNOWN_PACK";
    throw err;
  }

  const userRef = db.collection("users").doc(uid);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const d = snap.exists ? (snap.data() || {}) : {};
    const credits = typeof d?.credits === "number" ? d.credits : Number(d?.credits || 0) || 0;
    const ent = d?.entitlements || {};
    const owned = Array.isArray(ent?.packsOwned) ? ent.packsOwned : [];

    // If plan includes this tier, treat as owned
    const plan = normalizePlan(d?.plan);
    const planTier = plan === "studio" ? "studio" : (plan === "pro" ? "pro" : (plan === "basic" ? "basic" : "free"));
    const includedByPlan =
      (cfg.tier === "pro" && (planTier === "pro" || planTier === "studio")) ||
      (cfg.tier === "studio" && planTier === "studio");

    if (includedByPlan || owned.includes(packId)) {
      return { ok: true, alreadyOwned: true, credits, packsOwned: owned };
    }

    const cost = Number(cfg.cost || 0) || 0;
    if (credits < cost) {
      return { ok: false, error: "NO_CREDITS", credits, cost };
    }

    const newCredits = credits - cost;
    const newOwned = [...owned, packId];

    tx.set(
      userRef,
      {
        credits: newCredits,
        entitlements: { ...ent, packsOwned: newOwned },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true, credits: newCredits, cost, packsOwned: newOwned };
  });

  return result;
}

async function buyCredits(uid, pack) {
  const PACKS = {
    credits_20: 20,
    credits_60: 60,
    credits_150: 150,
	credits_400: 400,
  };

  const amount = PACKS[pack];
  if (!amount) {
    const err = new Error("UNKNOWN_PACK");
    err.code = "UNKNOWN_PACK";
    throw err;
  }

  const userRef = db.collection("users").doc(uid);

  let result = { pack, amount, creditsBefore: 0, creditsAfter: 0 };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);

    // Create user doc if missing (do NOT auto-grant trial here; trial is granted on first generation)
    if (!snap.exists) {
      tx.set(
        userRef,
        {
          credits: 0,
          plan: MONETIZATION.DEFAULT_PLAN,
          trialCreditsGranted: false,
          entitlements: {},
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    const data = snap.exists ? snap.data() : { credits: 0 };
    const before = Number(data?.credits || 0);
    const after = before + amount;

    result.creditsBefore = before;
    result.creditsAfter = after;

    tx.set(
      userRef,
      {
        credits: admin.firestore.FieldValue.increment(amount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return result;
}


app.post("/buy-addon", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const addon = String(req.body?.addon || "").trim();

    if (!addon) {
      return res.status(400).json({ success: false, error: "MISSING_ADDON" });
    }

    const result = await buyAddon(uid, addon);

    return res.json({ success: true,
      addon: result.addon,
      cost: result.cost,
      creditsBefore: result.creditsBefore,
      creditsAfter: result.creditsAfter,
      entitlementKey: result.entitlementKey,
      until: result.until, // Firestore Timestamp (client can render)
    });
  } catch (e) {
    const code = String(e?.code || e?.message || "BUY_ADDON_FAILED");

    if (code === "NO_CREDITS") {
      return res.status(402).json({ success: false, error: "NO_CREDITS" });
    }
    if (code === "UNKNOWN_ADDON") {
      return res.status(400).json({ success: false, error: "UNKNOWN_ADDON" });
    }
    if (code === "USER_NOT_FOUND") {
      return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
    }

    console.log("❌ /buy-addon error:", e);
    return res.status(500).json({ success: false, error: "BUY_ADDON_FAILED" });
  }
});


app.post("/buy-credits", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const pack = String(req.body?.pack || "").trim();


// ✅ Buy pack — debits credits and adds packId to entitlements.packsOwned
// Body: { packId: "product_pro" | ... }


    if (!pack) {
      return res.status(400).json({ success: false, error: "MISSING_PACK" });
    }

    const result = await buyCredits(uid, pack);

    return res.json({ success: true,
      pack: result.pack,
      amount: result.amount,
      creditsBefore: result.creditsBefore,
      creditsAfter: result.creditsAfter,
    });
  } catch (e) {
    const code = String(e?.code || e?.message || "BUY_CREDITS_FAILED");

    if (code === "UNKNOWN_PACK") {
      return res.status(400).json({ success: false, error: "UNKNOWN_PACK" });
    }

    console.log("❌ /buy-credits error:", e);
    return res.status(500).json({ success: false, error: "BUY_CREDITS_FAILED" });
  }
});


app.post("/buy-pack", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const { packId } = req.body || {};
    const r = await buyPack({ uid, packId });

    if (!r.ok) {
      if (r.error === "NO_CREDITS") {
        return res.status(402).json({ success: false, error: "NO_CREDITS", credits: r.credits, cost: r.cost || null });
      }
      return res.status(400).json({ success: false, error: r.error || "BUY_PACK_FAILED", credits: r.credits });
    }

    return res.json({ success: true,
      credits: r.credits,
      cost: r.cost || 0,
      alreadyOwned: !!r.alreadyOwned,
      packsOwned: r.packsOwned || null,
    });
  } catch (e) {
    const code = String(e?.code || e?.message || "BUY_PACK_ERROR");
    if (code === "UNKNOWN_PACK") {
      return res.status(400).json({ success: false, error: "UNKNOWN_PACK" });
    }
    return res.status(500).json({ success: false, error: "BUY_PACK_ERROR" });
  }
});

// -----------------------------------------
// BUY PLAN (time-based) — sets users/{uid}.plan + planUntil
// Also grants plan-included add-ons for 30 days (fixed): adFreeUntil + noWatermarkUntil
// -----------------------------------------
app.post("/buy-plan", verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.uid;
    const planId = String(req.body?.planId || "").toLowerCase().trim();
    const periodRaw = String(req.body?.period || "30").toLowerCase().trim();

    // Free cannot be purchased; it's the fallback when planUntil expires.
    const allowedPlans = ["basic", "pro", "studio"];
    if (!allowedPlans.includes(planId)) {
      return res.status(400).json({ success: false, error: "UNKNOWN_PLAN" });
    }

    // Period mapping (supports ids from the app)
    const periodToDays = (p) => {
      if (p === "90" || p === "d90") return 90;
      if (p === "180" || p === "d180") return 180;
      if (p === "365" || p === "annual" || p === "year" || p === "d365") return 365;
      return 30; // default
    };
    const days = periodToDays(periodRaw);

    // Credit prices — adjust as you want later
    const PLAN_PRICES = {
      basic:  { 30: 40, 90: 100, 180: 180, 365: 320 },
      pro:    { 30: 80, 90: 210, 180: 380, 365: 690 },
      studio: { 30: 140, 90: 390, 180: 720, 365: 1290 },
    };
    const cost = PLAN_PRICES?.[planId]?.[days];
    if (typeof cost !== "number") {
      return res.status(400).json({ success: false, error: "BAD_PERIOD" });
    }

    const userRef = db.collection("users").doc(uid);

    const r = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) return { ok: false, error: "USER_NOT_FOUND" };

      const user = snap.data() || {};
      const credits = Number(user.credits || 0);

      if (credits < cost) {
        return { ok: false, error: "NO_CREDITS", credits, cost };
      }

      
const nowMs = Date.now();

// ✅ Stack planUntil (extend from existing if still active)

      // ✅ Plan purchase rule (NO STACKING):
      // - Plan change: reset to now + days
      // - Same plan repurchase: reset to now + days
      const planUntilMs = nowMs + days * 24 * 60 * 60 * 1000;
// ✅ Plan-included add-ons:
// - BASIC: none (do NOT overwrite purchases)
// - PRO / STUDIO: ad-free + no-watermark + templates + pro prompt (each stacks 30 days)
const ent0 = (user.entitlements && typeof user.entitlements === "object") ? user.entitlements : {};
const isProOrStudio = planId === "pro" || planId === "studio";

const entUpdates = {};
if (isProOrStudio) {
  const existingAdFreeMs = toMsFromTimestampLike(ent0.adFreeUntil);
  const existingNoWmMs = toMsFromTimestampLike(ent0.noWatermarkUntil);
  const existingTplMs = toMsFromTimestampLike(ent0.templatesUntil);
  const existingProPromptMs = toMsFromTimestampLike(ent0.proPromptUntil);

  entUpdates.adFreeUntil = admin.firestore.Timestamp.fromMillis(addDaysToExpiry(existingAdFreeMs, 30));
  entUpdates.noWatermarkUntil = admin.firestore.Timestamp.fromMillis(addDaysToExpiry(existingNoWmMs, 30));
  entUpdates.templatesUntil = admin.firestore.Timestamp.fromMillis(addDaysToExpiry(existingTplMs, 30));
  entUpdates.proPromptUntil = admin.firestore.Timestamp.fromMillis(addDaysToExpiry(existingProPromptMs, 30));
}

// ✅ Prompt Builder: Studio-only AND duration must match Studio planUntil exactly
// - If buying Studio: set promptBuilderUntil = planUntil (no stacking)
// - If buying non-Studio: clear promptBuilderUntil immediately
if (planId === "studio") {
  entUpdates.promptBuilderUntil = admin.firestore.Timestamp.fromMillis(planUntilMs);
} else {
  entUpdates.promptBuilderUntil = null;
}

tx.set(
  userRef,
  {
    credits: credits - cost,
    plan: planId,
    planUntil: admin.firestore.Timestamp.fromMillis(planUntilMs),
    entitlements: {
      ...ent0,
      ...entUpdates,
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  },
  { merge: true }
);return {
        ok: true,
        credits: credits - cost,
        cost,
        plan: planId,
        planUntil: admin.firestore.Timestamp.fromMillis(planUntilMs),
        addonUntil: admin.firestore.Timestamp.fromMillis(planUntilMs),
      };
    });

    if (!r.ok) {
      if (r.error === "NO_CREDITS") {
        return res.status(402).json({ success: false, error: "NO_CREDITS", credits: r.credits, cost: r.cost });
      }
      if (r.error === "USER_NOT_FOUND") {
        return res.status(404).json({ success: false, error: "USER_NOT_FOUND" });
      }
      return res.status(400).json({ success: false, error: r.error || "BUY_PLAN_FAILED" });
    }

    return res.json({ success: true,
      credits: r.credits,
      cost: r.cost,
      plan: r.plan,
      planUntil: r.planUntil,
      });
  } catch (e) {
    console.error("❌ /buy-plan error:", e);
    return res.status(500).json({ success: false, error: "BUY_PLAN_FAILED" });
  }
});

// ------------------------------------------------------------
// START
// ------------------------------------------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`)
);
