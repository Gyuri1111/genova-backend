// server.js — PROMPT + IMAGE SUPPORT (FINAL) + /notify (PREFS) + PUSH UTIL (FINAL)
//          + notifyUser (C1) + EMAIL (D) + GeNova HTML TEMPLATE (uses src/utils/emailTemplate.js)
//          + OFFLINE EDGE-CASE SUPPORT: lastResult + /my-latest-result + /mark-result-seen

const admin = require("firebase-admin");

const BUILD_ID = '20260124-140507-pwreset-v1';
const { Expo } = require("expo-server-sdk");
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// Thumbnail extraction (first frame)
let ffmpeg;
let ffmpegPath;
try {
  ffmpeg = require("fluent-ffmpeg");
  ffmpegPath = require("ffmpeg-static");
  if (ffmpeg && ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

// 🔎 ffmpeg availability log (Render debug)
try {
  console.log("✅ ffmpeg available:", ffmpegPath);
} catch (e) {
  console.log("⚠️ ffmpeg path log failed:", e?.message || e);
}

} catch (e) {
  console.warn("⚠️ ffmpeg not available (install fluent-ffmpeg + ffmpeg-static)");
}


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
  "WATERMARK_THUMB_STORAGE_UPLOAD_2026-01-22_v5_local_placeholder_and_mp4_validation";


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

// ------------------------------------------------------------
// ✅ Share host + OG image configuration
// ------------------------------------------------------------
const SHARE_HOST = process.env.SHARE_HOST || "https://genova-labs.hu";
const OG_FALLBACK_IMAGE = process.env.OG_FALLBACK_IMAGE || "https://genova-labs.hu/assets/og/genova-og.png";


function isCrawlerUserAgent(uaRaw) {
  const ua = String(uaRaw || "").toLowerCase();
  // Common social crawlers
  return (
    ua.includes("facebookexternalhit") ||
    ua.includes("facebot") ||
    ua.includes("twitterbot") ||
    ua.includes("whatsapp") ||
    ua.includes("telegrambot") ||
    ua.includes("discordbot") ||
    ua.includes("slackbot") ||
    ua.includes("linkedinbot") ||
    ua.includes("pinterest") ||
    ua.includes("vkshare") ||
    ua.includes("embedly")
  );
}

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
app.get('/version', (req, res) => {
  res.json({ ok: true, version: 'genova-backend', build: BUILD_ID });
});


// ------------------------------------------------------------
// 🔐 PASSWORD RESET (verified users only) — BUILD_ID included
// ------------------------------------------------------------
app.post('/send-password-reset', async (req, res) => {
  res.setHeader('X-GeNova-Build', BUILD_ID);
  try {
    const rawEmail = String(req.body?.email || '');
    const email = rawEmail.trim().toLowerCase();
    console.log('📩 /send-password-reset', { email, build: BUILD_ID });

    if (!email) return res.status(400).json({ ok: false, code: 'MISSING_EMAIL', build: BUILD_ID });

    let user;
    try {
      user = await admin.auth().getUserByEmail(email);
    } catch (e) {
      console.log('🚫 reset: NOT_REGISTERED', { email, build: BUILD_ID });
      return res.status(404).json({ ok: false, code: 'NOT_REGISTERED', build: BUILD_ID });
    }

    if (!user?.emailVerified) {
      console.log('🚫 reset: NOT_VERIFIED', { email, uid: user?.uid, build: BUILD_ID });
      return res.status(403).json({ ok: false, code: 'NOT_VERIFIED', build: BUILD_ID });
    }

    const continueUrl = String(req.body?.continueUrl || 'https://genova-labs.hu/reset.html');
    const link = await admin.auth().generatePasswordResetLink(email, { url: continueUrl });

    const built = {
      subject: 'Reset your GeNova password',
      text: `Use this link to reset your password:\n${link}`,
      html: emailTemplate({
        title: 'Reset your password',
        message: 'Click the button below to reset your GeNova password.',
        buttonText: 'Reset password',
        buttonUrl: link,
      }),
    };

    await sendEmailWithFallback({ to: email, ...built });

    console.log('✅ reset email sent', { email, build: BUILD_ID });
    return res.json({ ok: true, build: BUILD_ID });
  } catch (e) {
    console.log('❌ /send-password-reset error:', e, { build: BUILD_ID });
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', build: BUILD_ID });
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
// ✅ Video finalization helpers: watermark + thumbnail + upload
// ------------------------------------------------------------

function safeEncodePath(p) {
  return encodeURIComponent(String(p).replace(/^\//, "")).replace(/%2F/g, "%2F");
}

function buildStorageDownloadUrl(bucketName, objectPath, token) {
  const encoded = encodeURIComponent(objectPath).replace(/%2F/g, "%2F");
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}

function isProbablyMp4Header(buf) {
  try {
    const slice = buf.slice(0, 1024);
    return slice.includes("ftyp") || slice.includes("isom") || slice.includes("mp42");
  } catch (_) {
    return false;
  }
}

function validateLocalMp4(filePath, label) {
  try {
    const st = fs.statSync(filePath);
    const size = st.size || 0;
    const head = fs.readFileSync(filePath, { encoding: "latin1", flag: "r" }).slice(0, 1024);
    const ok = size > 50 * 1024 && isProbablyMp4Header(head);
    console.log("🎞️ mp4 validation:", { label, filePath, size, ok });
    return ok;
  } catch (e) {
    console.log("⚠️ mp4 validation failed:", { label, filePath, err: e?.message || e });
    return false;
  }
}

function tryCopyLocalPlaceholder(outPath) {
  const candidates = [
    path.join(process.cwd(), "placeholder.mp4"),
    path.join(process.cwd(), "public", "placeholder.mp4"),
    path.join(__dirname, "placeholder.mp4"),
    path.join(__dirname, "public", "placeholder.mp4"),
    path.join(process.cwd(), "assets", "placeholder.mp4"),
  ];

  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand)) {
        fs.copyFileSync(cand, outPath);
        console.log("🎬 using local placeholder.mp4:", cand);
        return true;
      }
    } catch (_) {}
  }
  console.log("⚠️ local placeholder.mp4 not found in candidates");
  return false;
}

async function downloadToFile(url, outPath) {
  const https = require("https");
  const http = require("http");
  const proto = String(url).startsWith("https") ? https : http;

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    const req = proto.get(url, (res) => {
      // follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(() => fs.unlink(outPath, () => resolve(downloadToFile(res.headers.location, outPath))));
        return;
      }
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(outPath, () => reject(new Error(`DOWNLOAD_FAILED_${res.statusCode}`))));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    req.on("error", (e) => {
      try { file.close(() => fs.unlink(outPath, () => reject(e))); } catch (_) { reject(e); }
    });
  });
}

async function uploadFileToFirebaseStorage(localPath, destPath, contentType) {
  const token = uuidv4();
  const buf = fs.readFileSync(localPath);

  await bucket.file(destPath).save(buf, {
    resumable: false,
    contentType: contentType || "application/octet-stream",
    metadata: {
      metadata: {
        firebaseStorageDownloadTokens: token,
      },
      cacheControl: "public, max-age=31536000",
    },
  });

  return {
    bucket: bucket.name,
    path: destPath,
    token,
    url: buildStorageDownloadUrl(bucket.name, destPath, token),
  };
}

/**
 * Finalize a generated video URL:
 * - downloads source (or uses local file if already local)
 * - applies watermark conditionally
 * - extracts thumbnail
 * - uploads both to Firebase Storage
 * - returns { videoUrl, thumbUrl, storage: {videoPath, thumbPath} }
 */
async function finalizeGeneratedVideo({
  uid,
  creationId,
  sourceUrl,
  fileName,
  watermarkApplied,
}) {
  const tmpDir = os.tmpdir();
  const safeUid = String(uid || "anon").replace(/[^a-zA-Z0-9_-]/g, "");
  const safeId = String(creationId || uuidv4()).replace(/[^a-zA-Z0-9_-]/g, "");

  const baseName = (fileName && String(fileName).endsWith(".mp4"))
    ? String(fileName)
    : `${safeId}.mp4`;

  const localSrc = path.join(tmpDir, `genova_src_${safeId}.mp4`);
  const localFinal = localSrc;

  // Acquire source
  const isPlaceholder = String(sourceUrl || "").includes("/placeholder.mp4");
  if (isPlaceholder) {
    const copied = tryCopyLocalPlaceholder(localSrc);
    if (!copied) {
      await downloadToFile(sourceUrl, localSrc);
    }
  } else {
    await downloadToFile(sourceUrl, localSrc);
  }

  // Validate we really got an mp4 (prevents saving HTML/redirect pages)
  const validMp4 = validateLocalMp4(localSrc, isPlaceholder ? "placeholder" : "sourceUrl");
  if (!validMp4) {
    const err = new Error("SOURCE_NOT_MP4");
    err.code = "SOURCE_NOT_MP4";
    throw err;
  }
  // Upload
  const videoDest = `videos/${safeUid}/${safeId}.mp4`;
  console.log("⬆️ uploading video to Storage:", { videoDest });
  const videoUp = await uploadFileToFirebaseStorage(localFinal, videoDest, "video/mp4");
  console.log("✅ video uploaded:", { url: videoUp.url, path: videoUp.path });

  let thumbUp = null;
  if (thumbOk) {
    const thumbDest = `thumbs/${safeUid}/${safeId}.jpg`;
    console.log("⬆️ uploading thumb to Storage:", { thumbDest });
    thumbUp = await uploadFileToFirebaseStorage(localThumb, thumbDest, "image/jpeg");
    console.log("✅ thumb uploaded:", { url: thumbUp.url, path: thumbUp.path });
  }

  // Cleanup best-effort
  for (const f of [localSrc, localWm, localThumb]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }

  return {
    videoUrl: videoUp.url,
    thumbUrl: thumbUp?.url || null,
    storage: {
      videoPath: videoUp.path,
      thumbPath: thumbUp?.path || null,
      bucket: videoUp.bucket,
    },
  };
}

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

// 🔎 Try to find an existing "pending" creation doc created by the client, so we don't create duplicates.
// We avoid Firestore composite-index requirements by only ordering by createdAt and filtering in-memory.
async function findRecentPendingCreationId(db, uid, { model, lengthSec, resolution, fps, fileName } = {}, windowMs = 5 * 60 * 1000) {
  try {
    const sinceMs = Date.now() - windowMs;
    const col = db.collection("users").doc(uid).collection("creations");
    // NOTE: we only order+limit, no where(), to avoid composite index needs.
    const snap = await col.orderBy("createdAt", "desc").limit(25).get();
    if (snap.empty) return null;

    const wantModel = (model || "").trim();
    const wantRes = (resolution || "").trim();
    const wantFps = Number(fps) || 0;
    const wantLen = Number(lengthSec) || 0;
    const wantFile = (fileName || "").trim();

    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const createdAt = (() => {
      const v = d.createdAt ?? d.updatedAt ?? null;
      if (!v) return 0;
      if (typeof v === "number") return v;
      if (v instanceof Date) return v.getTime();
      if (typeof v.toMillis === "function") return v.toMillis(); // Firestore Timestamp
      if (typeof v.seconds === "number") return v.seconds * 1000; // Timestamp-like
      return 0;
    })();
      if (createdAt && createdAt < sinceMs) continue;

      const status = String(d.status || "").toLowerCase();
      // pending-ish statuses (client often creates doc before backend finishes)
      if (!["queued", "processing", "generating", "pending", "created", "init"].includes(status)) continue;

      // If the doc is already finalized, skip
      if (d.videoUrl || (d.storage && d.storage.videoPath)) continue;

      // Soft match by metadata (only check if we have the fields)
      if (wantModel && String(d.model || "").trim() && String(d.model || "").trim() !== wantModel) continue;
      if (wantRes && String(d.resolution || "").trim() && String(d.resolution || "").trim() !== wantRes) continue;
      if (wantFps && Number(d.fps) && Number(d.fps) !== wantFps) continue;
      if (wantLen && Number(d.length) && Number(d.length) !== wantLen) continue;

      // If client already wrote fileName and we also have one, match it.
      if (wantFile && String(d.fileName || "").trim() && String(d.fileName || "").trim() !== wantFile) continue;

      return doc.id;
    }
    return null;
  } catch (e) {
    console.warn("⚠️ findRecentPendingCreationId failed:", e?.message || e);
    return null;
  }
}

app.post("/generate-video", verifyFirebaseToken, upload.single("file"), async (req, res) => {
  try {
    const uid = req.uid;

    // In multipart, fields arrive as strings
    const body = req.body || {};
    const prompt = String(body.prompt || body.text || "").trim();
    const model = String(body.model || "kling").trim();
    const lengthSec = Math.max(1, Math.min(60, Number(body.lengthSec ?? body.length ?? 5)));
    const fps = Math.max(1, Math.min(120, Number(body.fps ?? 30)));
    const resolution = String(body.resolution || body.res || "720p").trim();
    const hasFile = !!req.file;

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
    // ✅ Finalization pipeline already runs (watermark + thumbnail + Storage upload).
    const baseUrl = getPublicBaseUrl(req);
    const sourceUrl = `${baseUrl}/placeholder.mp4`;

    let fileName = String(body.fileName || "").trim() || "";
    const watermarkApplied = !!billing?.watermarkApplied;
    // ✅ If client did not send fileName, generate a stable one (needed for Firestore + share)
    if (!fileName) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
      fileName = `GeNova_${model}_${lengthSec}s_${resolution}_${fps}fps_${stamp}.mp4`;
    }


    // Client may send creationId + fileName (recommended)
    const clientCreationId = String(body.creationId || body.creationDocId || body.docId || "").trim();
    let creationId = clientCreationId || "";
    if (!creationId) {
      const pendingId = await findRecentPendingCreationId(db, uid, { model, lengthSec, resolution, fps, fileName });
      if (pendingId) {
        creationId = pendingId;
        console.log("🧩 using existing pending creation docId (dedupe):", creationId);
      }
    }
    if (!creationId) creationId = id;
    const finalized = await finalizeGeneratedVideo({
      uid,
      creationId,
      sourceUrl,
      fileName,
      watermarkApplied,
    });

    const url = finalized.videoUrl;// Mark as ready
    await setLastResult(uid, {
      id,
      status: "ready",
      title: "",
      message: "",
      url,
      meta,
      createdAt,
    });

    

    // ✅ Update the user's creation doc if it exists (preferred direct path)
    // users/{uid}/creations/{creationId}
    try {
      if (creationId) {
        const creationRef = db.collection("users").doc(uid).collection("creations").doc(creationId);
        // ✅ Always create/update the creation doc (client might not pre-create it)
        await creationRef.set(
          {
            uid,
            createdAt: admin.firestore.Timestamp.now(),
            model,
            prompt: String(prompt || ""),
            length: Number(lengthSec),
            fps: Number(fps),
            resolution: String(resolution),
            hasImage: !!req.file,
            fileName: String(fileName || ""),
            status: "ready",
            videoUrl: finalized?.videoUrl || null,
            thumbUrl: finalized?.thumbUrl || null,
            thumbnailUrl: finalized?.thumbUrl || null,
            storage: finalized?.storage || null,
            watermarkApplied: !!watermarkApplied,
            updatedAt: admin.firestore.Timestamp.now(),
          },
          { merge: true }
        );
        console.log("✅ Firestore creation updated:", `users/${uid}/creations/${creationId}`);

        // ✅ Backfill duplicates (if client pre-created a different docId)
        // Some clients may create a "processing" doc with a different docId before calling /generate-video.
        // If we detect other docs with the same fileName, we update them too so thumbnails/OG never miss.
        try {
          if (fileName) {
            const dupSnap = await db
              .collection("users")
              .doc(uid)
              .collection("creations")
              .where("fileName", "==", String(fileName))
              .limit(10)
              .get();

            const updates = []; // store DocumentSnapshots
            dupSnap.forEach((docSnap) => {
              if (docSnap.id !== creationId) updates.push(docSnap);
            });

            if (updates.length) {
              const batch = db.batch();
              const nowTs = admin.firestore.Timestamp.now();
              updates.forEach((docSnap) => {
                const d = docSnap.data() || {};
                const ref = docSnap.ref;
                const hasThumb = !!(d.thumbUrl || d.thumbnailUrl || (d.storage && (d.storage.thumbUrl || d.storage.thumbPath)));
                const hasVideo = !!(d.videoUrl || (d.storage && d.storage.videoPath));
                // If it's clearly an extra placeholder row (no video + no thumb), delete it to avoid duplicates.
                if (!hasVideo || !hasThumb || ["queued","processing","generating","pending","created","init"].includes(String(d.status||"").toLowerCase())) {
                  batch.delete(ref);
                  return;
                }
                // Otherwise, keep it but backfill fields and mark as duplicate-of the canonical doc.
                batch.set(
                  ref,
                  {
                    uid,
                    status: "ready",
                    videoUrl: finalized?.videoUrl || d.videoUrl || null,
                    thumbUrl: finalized?.thumbUrl || d.thumbUrl || null,
                    thumbnailUrl: finalized?.thumbUrl || d.thumbnailUrl || null,
                    storage: finalized?.storage || d.storage || null,
                    watermarkApplied: !!watermarkApplied,
                    updatedAt: nowTs,
                    duplicateOf: creationId,
                  },
                  { merge: true }
                );
              });
              await batch.commit();
              console.log("✅ Firestore duplicates backfilled:", updates.length);
            }
          }
        } catch (e2) {
          console.warn("⚠️ duplicate backfill failed:", e2?.message || e2);
        }
      }
    } catch (e) {
      console.warn("⚠️ creation doc update failed:", e?.message || e);
    }
// Send push/email if enabled
    try {
      await notifyUser({
        uid,
        type: "video",
        data: {
          url,
          thumbUrl: finalized?.thumbUrl || null,
          shareUrl: fileName ? `${SHARE_HOST}/d/${encodeURIComponent(fileName)}` : null,
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
      videoUrl: url,
      resultId: id,
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
// ------------------------------------------------------------
// ✅ Public share links (pretty URLs for Messenger/WhatsApp previews)
// - /s/:id  -> HTML page with OG tags + button (best for sharing)
// - /v/:id  -> 302 redirect to the real Firebase Storage URL (direct download/play)
// Works without uid by using collectionGroup('creations') where field 'id' == :id
// ------------------------------------------------------------
app.get("/v/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).send("Missing id");

    const q = await db.collectionGroup("creations").where("id", "==", id).limit(1).get();
    if (q.empty) return res.status(404).send("Not found");

    const data = q.docs[0].data() || {};
    const url = String(data.url || "").trim();
    if (!url) return res.status(404).send("No URL");

    res.set("Cache-Control", "public, max-age=300");
    return res.redirect(302, url);
  } catch (e) {
    console.error("❌ share redirect error:", e);
    return res.status(500).send("Error");
  }
});

app.get("/s/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).send("Missing id");

    const q = await db.collectionGroup("creations").where("id", "==", id).limit(1).get();
    if (q.empty) return res.status(404).send("Not found");

    const data = q.docs[0].data() || {};
    const meta = data.meta || {};
    const model = String(meta.model || data.model || "GeNova");
    const lengthSec = String(meta.lengthSec || data.lengthSec || data.length || data.videoLength || "");
    const resolution = String(meta.resolution || data.resolution || "");
    const fps = String(meta.fps || data.fps || "");
    const title = `GeNova AI Video (${model}${lengthSec ? ` • ${lengthSec}s` : ""})`;

    // Use a stable image for previews (you can replace with your own OG image later)
    const ogImage = String(data.thumbUrl || meta.thumbUrl || OG_FALLBACK_IMAGE);

    const directUrl = `${SHARE_HOST}/v/${encodeURIComponent(id)}`;

    const descParts = [];
    if (resolution) descParts.push(`Resolution: ${resolution}`);
    if (fps) descParts.push(`FPS: ${fps}`);
    const desc = descParts.length ? descParts.join(" • ") : "Generated with GeNova";

    const htmlDoc = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(desc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta property="og:url" content="${escapeHtml(`${SHARE_HOST}/s/${encodeURIComponent(id)}`)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="robots" content="noindex" />
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#05070D;color:#E5E7EB}
    .wrap{max-width:740px;margin:0 auto;padding:28px}
    .card{background:rgba(255,255,255,0.06);border:1px solid rgba(51,230,255,0.25);border-radius:18px;padding:18px}
    .h{font-weight:700;font-size:18px;margin:0 0 10px}
    .p{opacity:.82;margin:0 0 16px}
    a.btn{display:inline-block;background:rgba(51,230,255,0.18);border:1px solid rgba(51,230,255,0.6);color:#E5E7EB;text-decoration:none;padding:10px 14px;border-radius:12px;font-weight:600}
    .small{opacity:.7;font-size:12px;margin-top:10px;word-break:break-all}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <p class="h">${escapeHtml(title)}</p>
      <p class="p">${escapeHtml(desc)}</p>
      <a class="btn" href="${escapeHtml(directUrl)}">Download / Open</a>
      <div class="small">${escapeHtml(directUrl)}</div>
    </div>
  </div>
</body>
</html>`;
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    return res.status(200).send(htmlDoc);
  } catch (e) {
    console.error("❌ share page error:", e);
    return res.status(500).send("Error");
  }
});

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

app.get("/d/:filename", async (req, res) => {
  try {
    const filenameRaw = String(req.params.filename || "");
    const fileName = decodeURIComponent(filenameRaw).trim();
    if (!fileName) return res.status(400).send("Missing filename");

    // Find creation doc by fileName across users
    const q = await db.collectionGroup("creations").where("fileName", "==", fileName).limit(1).get();
    if (q.empty) return res.status(404).send("Not found");

    const docSnap = q.docs[0];
    const data = docSnap.data() || {};
    const meta = data.meta || {};

    // Prefer shareId if you store it; otherwise doc id works
    const idForDownload = String(data.shareId || docSnap.id);

    const model = String(meta.model || data.model || "GeNova");
    const lengthSec = meta.lengthSec ?? data.lengthSec ?? data.length ?? "";
    const resolution = String(meta.resolution || data.resolution || "");
    const fps = meta.fps ?? data.fps ?? "";

    const ogImage = String(
      data.thumbUrl ||
      meta.thumbUrl ||
      data.thumbnailUrl ||
      meta.thumbnailUrl ||
      data.sourceImageUrl ||
      data.imageUrl ||
      data.inputImageUrl ||
      OG_FALLBACK_IMAGE
    );

    const shareUrl = `${SHARE_HOST}/d/${encodeURIComponent(fileName)}`;
    const downloadUrl = `${SHARE_HOST}/v/${encodeURIComponent(idForDownload)}`;

    const descParts = [];
    if (model) descParts.push(`Model: ${model}`);
    if (lengthSec !== "" && lengthSec != null) descParts.push(`Length: ${lengthSec}s`);
    if (resolution) descParts.push(`Res: ${resolution}`);
    if (fps !== "" && fps != null) descParts.push(`FPS: ${fps}`);
    const desc = descParts.length ? descParts.join(" • ") : "GeNova AI video";

    // ✅ Important: humans should go straight to the video, crawlers should see OG HTML
    if (!isCrawlerUserAgent(req.headers["user-agent"])) {
      return res.redirect(302, downloadUrl);
    }

    res.set("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta property="og:type" content="video.other" />
<meta property="og:title" content="${String(fileName).replace(/"/g, "&quot;")}" />
<meta property="og:description" content="${String(desc).replace(/"/g, "&quot;")}" />
<meta property="og:image" content="${String(ogImage).replace(/"/g, "&quot;")}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="GeNova preview" />
<meta property="og:url" content="${String(shareUrl).replace(/"/g, "&quot;")}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${String(fileName).replace(/"/g, "&quot;")}" />
<meta name="twitter:description" content="${String(desc).replace(/"/g, "&quot;")}" />
<meta name="twitter:image" content="${String(ogImage).replace(/"/g, "&quot;")}" />
<title>${String(fileName).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>
</head>
<body style="margin:0;background:#0b0f16;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;">
  <div style="max-width:900px;margin:0 auto;padding:24px;">
    <h2 style="margin:0 0 12px 0;">${String(fileName).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</h2>
    <p style="margin:0 0 16px 0;opacity:.85;">${String(desc).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
    <a href="${downloadUrl}" style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:12px 16px;border-radius:999px;font-weight:600;">Download</a>
  </div>
</body>
</html>`);
  } catch (e) {
    console.error("❌ /d/:filename error:", e);
    return res.status(500).send("Error");
  }
});


app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`)
);
