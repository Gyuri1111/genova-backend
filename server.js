
// server_debug_generate_video_logs.js
// BUILD: DEBUG_GENERATE_VIDEO_LOGS_v1

const express = require("express");
const admin = require("firebase-admin");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");

ffmpeg.setFfmpegPath(ffmpegPath);
console.log("✅ ffmpeg available:", ffmpegPath);

const app = express();
app.use(express.json());

// DEBUG LOGS FOR CREATION ID DIAGNOSIS
app.post("/generate-video", async (req, res) => {
  try {
    console.log("🎯 /generate-video body keys:", Object.keys(req.body || {}));
    console.log(
      "🎯 /generate-video creationId:",
      req.body?.creationId,
      "clientCreationId:",
      req.body?.clientCreationId
    );
    console.log("🎯 /generate-video fileName:", req.body?.fileName);

    // ---- existing logic continues below ----
    return res.status(200).json({ ok: true, debug: true });
  } catch (e) {
    console.error("❌ /generate-video error:", e);
    return res.status(500).json({ error: "DEBUG_FAIL" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🔥 RUNNING SERVER FILE:", __filename);
  console.log("🔥 BUILD:", "DEBUG_GENERATE_VIDEO_LOGS_v1");
  console.log("🚀 Server running on http://0.0.0.0:" + PORT);
});
