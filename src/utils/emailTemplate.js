// src/utils/emailTemplate.js

const FONT_URL_BASE = "https://genova-27d76.web.app/fonts"; // Firebase Hosting

function escapeHtml(input) {
  const s = String(input ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(url) {
  if (!url) return "";
  const u = String(url).trim();
  // allow only http(s)
  if (!/^https?:\/\//i.test(u)) return "";
  return u;
}

const emailTemplate = ({ title, message, buttonText, buttonUrl }) => {
  const ACCENT = "#37ebec";
  const BTN_BG = "#24262e";

  const safeTitle = escapeHtml(title || "GeNova");
  const safeMsg = escapeHtml(message || "");
  const safeBtnText = escapeHtml(buttonText || "Open");
  const safeBtnUrl = safeUrl(buttonUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${safeTitle}</title>

  <style>
    /* Best-effort: self-hosted Barlow (many clients ignore <style>, but worth keeping) */
    @font-face { font-family: 'Barlow'; font-style: normal; font-weight: 300; src: url('${FONT_URL_BASE}/barlow-300.woff2') format('woff2'); }
    @font-face { font-family: 'Barlow'; font-style: normal; font-weight: 400; src: url('${FONT_URL_BASE}/barlow-400.woff2') format('woff2'); }
    @font-face { font-family: 'Barlow'; font-style: normal; font-weight: 500; src: url('${FONT_URL_BASE}/barlow-500.woff2') format('woff2'); }
    @font-face { font-family: 'Barlow'; font-style: normal; font-weight: 600; src: url('${FONT_URL_BASE}/barlow-600.woff2') format('woff2'); }
    @font-face { font-family: 'Barlow'; font-style: normal; font-weight: 700; src: url('${FONT_URL_BASE}/barlow-700.woff2') format('woff2'); }
  </style>
</head>

<body style="margin:0;padding:0;background:#05070D;">
  <div style="
    font-family:'Barlow',Arial,sans-serif;
    background:linear-gradient(180deg,#0B0F13,#05070D);
    color:#FFFFFF;
    padding:24px 14px;
  ">
    <div style="
      max-width:640px;
      margin:0 auto;
      background:rgba(15,15,22,0.88);
      border-radius:18px;
      padding:26px 18px;
      box-shadow:0 0 28px rgba(0,0,0,0.45);
      border:1px solid rgba(148,163,184,0.25);
    ">

      <!-- LOGO (mobile-safe) -->
      <div style="text-align:center;margin:0 0 12px;">
        <img
          src="https://assets.genova-labs.hu/email-logo.png"
          alt="GeNova Logo"
          width="120"
          style="display:inline-block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;width:100%;max-width:120px;height:auto;"
        />
      </div>

      <!-- TITLE -->
      <h2 style="
        font-family:'Barlow',Arial,sans-serif;
        color:${ACCENT};
        font-size:22px;
        font-weight:400;
        margin:14px 0 18px;
        text-align:center;
        line-height:1.25;
      ">${safeTitle}</h2>

      <!-- MESSAGE -->
      <p style="
        font-family:'Barlow',Arial,sans-serif;
        font-size:15px;
        color:#C9D1E6;
        line-height:1.65;
        margin:0 0 17px;
        text-align:center;
        font-weight:400;
      ">${safeMsg}</p>

      <!-- BUTTON -->
      ${
        safeBtnUrl
          ? `
      <div style="text-align:center;margin:18px 0 6px;">
        <a href="${safeBtnUrl}"
          style="
            font-family:'Barlow',Arial,sans-serif;
            display:inline-block;
            background:${BTN_BG};
            color:${ACCENT};
            border:1px solid ${ACCENT};
            text-decoration:none;
            padding:10px 18px;
            border-radius:999px;
            font-weight:600;
            font-size:14px;
            line-height:1;
          "
        >${safeBtnText}</a>
      </div>
      `
          : ""
      }

      <p style="
        font-family:'Barlow',Arial,sans-serif;
        font-size:12.5px;
        color:#8B93A7;
        text-align:center;
        margin:22px 0 0;
      ">
        If you didn’t request this, you can safely ignore this message.
      </p>

      <hr style="
        border:none;
        border-top:1px solid rgba(148,163,184,0.18);
        margin:22px 0;
      "/>

      <p style="
        font-family:'Barlow',Arial,sans-serif;
        font-size:12px;
        color:#6B7280;
        text-align:center;
        margin:0;
      ">
        © 2025 GeNova Labs
      </p>

    </div>
  </div>
</body>
</html>`;
};

module.exports = { emailTemplate };
