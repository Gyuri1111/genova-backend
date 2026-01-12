// src/screens/StoreScreen.js
import React, { useCallback, useEffect, useMemo, useState , useRef} from "react";
import {
View,
  ScrollView,
  Text,
  Pressable,
  Dimensions,
  Platform,
  StatusBar,
  StyleSheet,
  Modal,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

// ✅ Settings
import { useSettings } from "../contexts/SettingsContext";
import i18n from "../i18n";
import { useToast } from "native-base";
import { showSuccessToast, showErrorToast } from "../utils/toasts";
import { auth, db } from "../firebaseConfig";
import { doc, updateDoc, Timestamp} from "firebase/firestore";

// --- helper: format plan period for current pill ---
const formatPlanPeriod = (period) => {
  if (!period) return "";
  // Normalize to string for matching
  const p = String(period).toLowerCase();

  // Yearly / annual
  if (p === "annual" || p === "year" || p === "yearly" || p === "y1" || p === "1y" || p === "p1y" || p === "365" || p === "365d" || p === "d365") {
    return "Éves";
  }

  // Monthly-ish
  if (p === "d30" || p === "30d" || p === "30") return "30 nap";
  // Quarterly-ish
  if (p === "d90" || p === "90d" || p === "90") return "90 nap";

  // Fallback: extract number of days if present
  const mm = p.match(/\d+/);
  return mm ? `${mm[0]} nap` : "";
};


// --- helper: normalize Firestore Timestamp / seconds / ms / Date -> ms ---
function toMsFromTimestampLike(v) {
  if (!v) return null;
  // Firestore Timestamp
  if (typeof v.toMillis === "function") return v.toMillis();
  // Serialized Timestamp-like: { seconds, nanoseconds } or { _seconds, _nanoseconds }
  const sec = (typeof v.seconds === "number" ? v.seconds : (typeof v._seconds === "number" ? v._seconds : null));
  const nsec = (typeof v.nanoseconds === "number" ? v.nanoseconds : (typeof v._nanoseconds === "number" ? v._nanoseconds : 0));
  if (sec != null) return sec * 1000 + Math.floor(nsec / 1e6);
  // Numeric ms or seconds
  if (typeof v === "number") {
    // Heuristic: < 10^12 treat as seconds, else ms
    return v < 1e12 ? v * 1000 : v;
  }
  // ISO/date string
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  // JS Date
  if (v instanceof Date) return v.getTime();
  return null;
}



const { height: SCREEN_H } = Dimensions.get("window");

// ✅ If EXPO_PUBLIC_API_BASE is not set, we fall back to the Render backend URL.
//    (You can still override with .env / EAS envs.)
const DEFAULT_API_BASE = "https://genova-backend-45yb.onrender.com";

const API_BASE = String(
  process.env.EXPO_PUBLIC_API_BASE ||
    process.env.EXPO_PUBLIC_API_URL ||
    process.env.EXPO_PUBLIC_BACKEND_URL ||
    process.env.EXPO_PUBLIC_SERVER_URL ||
    ""
)
  .trim()
  .replace(/\/+$/, "");

const EFFECTIVE_API_BASE = (API_BASE || DEFAULT_API_BASE).trim().replace(/\/+$/, "");



/**
 * StoreScreen — FINAL
 * ✅ Pure React Native UI (no NativeBase) — avoids "$$typeof" crashes.
 * ✅ Uses SettingsContext as source of truth: darkMode, language, plan, credits, entitlements.
 * ✅ Local dictionary i18n (src/locales/*.json) — no missing "hu.store..." issues.
 * ✅ No FlatList inside ScrollView.
 *
 * Design target:
 * - Keep the "v4" look you liked (teal light / dark dark).
 * - Owned tab matches the "Owned" UI from your older file (current plan + active add-ons + purchased packs list).
 */

const { width: SCREEN_W } = Dimensions.get("window");
const PILL_RADIUS = 999;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const CREDIT_PACKS = [
  { id: "credits_20", amount: 20, icon: "flash-outline" },
  { id: "credits_60", amount: 60, icon: "sparkles-outline" },
  { id: "credits_150", amount: 150, icon: "rocket-outline" },
  { id: "credits_400", amount: 400, icon: "planet-outline" },
];

const PLAN_DEFS = [
  {
    id: "free",
    titleKey: "store.plans.free",
    accent: { light: ["#F5F7FA", "#E7ECF3"], dark: ["#1A2029", "#12161D"] },
    includesKeys: ["store.perks.maxLen5", "store.perks.maxFps30", "store.perks.max720p"],
    // ❗ Free: negatives should be real (no "no 4K" etc.)
    excludesKeys: ["store.perks.adsFree", "store.perks.promptBuilder", "store.perks.proPacksAndTemplates", "store.perks.noWatermark"],
  },
  {
    id: "basic",
    titleKey: "store.plans.basic",
    accent: { light: ["#0F5C8E", "#0B3E61"], dark: ["#13344A", "#0B1F2D"] },
    includesKeys: ["store.perks.maxLen5", "store.perks.maxFps30", "store.perks.max1080p"],
    excludesKeys: ["store.perks.adsFree", "store.perks.promptBuilder", "store.perks.proPacksAndTemplates", "store.perks.noWatermark"],
  },
  {
    id: "pro",
    titleKey: "store.plans.pro",
    accent: { light: ["#0F766E", "#0A4D49"], dark: ["#0B4A45", "#061F1D"] },
    // PRO: positives
    includesKeys: [
      "store.perks.maxLen10",
      "store.perks.maxFps60",
      "store.perks.max4k",
      "store.perks.proPacksAndTemplates",
      "store.perks.adsFree",
      "store.perks.noWatermark",
    ],
    // PRO: negatives
    excludesKeys: ["store.perks.promptBuilder", "store.perks.seedMode"],
  },
  {
    id: "studio",
    titleKey: "store.plans.studio",
    accent: { light: ["#C9A227", "#8A6B10"], dark: ["#6D560F", "#2D2407"] },
    // STUDIO: list all positives, no negatives
    includesKeys: [
      "store.perks.maxLen20",
      "store.perks.maxFps60",
      "store.perks.max4k",
      "store.perks.allPacks",
      "store.perks.proPacksAndTemplates",
      "store.perks.promptBuilder",
      "store.perks.adsFree",
      "store.perks.noWatermark",
      "store.perks.seedMode",
    ],
    excludesKeys: [],
  },
];

// Add-ons + Packs (missing ones added: Templates + PRO pack)
const ADDON_GROUPS = [
  {
    id: "no_watermark",
    titleKey: "store.addons.noWatermark.title",
    titleFallback: "No Watermark",
    icon: "image-outline",
    type: "addon",
    items: [
      { id: "no_watermark_7d", labelKey: "store.addons.days7", labelFallback: "7 days" },
      { id: "no_watermark_30d", labelKey: "store.addons.days30", labelFallback: "30 days" },
    ],
  },
  {
    id: "ads_free",
    titleKey: "store.addons.adsFree.title",
    titleFallback: "Ads-free",
    icon: "close-circle-outline",
    type: "addon",
    items: [
      { id: "ad_free_7d", labelKey: "store.addons.days7", labelFallback: "7 days" },
      { id: "ad_free_30d", labelKey: "store.addons.days30", labelFallback: "30 days" },
    ],
  },
  {
    id: "templates_addon",
    titleKey: "store.owned.items.templates",
    titleFallback: "Templates",
    icon: "albums-outline",
    type: "addon",
    items: [
      { id: "templates_7d", labelKey: "store.addons.days7", labelFallback: "7 days" },
      { id: "templates_30d", labelKey: "store.addons.days30", labelFallback: "30 days" },
    ],
  },
  {
    id: "pro_prompt_addon",
    titleKey: "store.owned.items.proPromptPack",
    titleFallback: "PRO Prompt Pack",
    icon: "lock-closed-outline",
    type: "addon",
    items: [
      { id: "pro_prompt_7d", labelKey: "store.addons.days7", labelFallback: "7 days" },
      { id: "pro_prompt_30d", labelKey: "store.addons.days30", labelFallback: "30 days" },
    ],
  },
];


export default function StoreScreen({ navigation }) {
  const ctx = useSettings();
  const settings = ctx?.settings;

  // ✅ Dark mode source of truth
  const isDark = !!settings?.darkMode;


  const toast = useToast();


  // ---- Plans horizontal scroll (keep position; prevent jumps) ----
  const planScrollRef = useRef(null);
  const planScrollXRef = useRef(0);
  // Prevent horizontal plan carousel from jumping on state/snapshot updates
  const holdPlansXRef = useRef(0);
  const holdPlansJumpRef = useRef(false);
  const restorePlansScroll = useCallback((x) => {
    try {
      const v = Number.isFinite(x) ? x : 0;
      const run = () => { try { planScrollRef.current?.scrollTo?.({ x: v, animated: false }); } catch (e) {} };
      // immediate + next frames (RN sometimes resets scroll on re-render/content change)
      run();
      try { requestAnimationFrame(run); } catch (e) {}
      setTimeout(run, 80);
      setTimeout(run, 180);
      setTimeout(run, 320);
    } catch (e) {}
  }, []);

  const savedPlanScrollXRef = useRef(0);
  const suppressPlanAutoScrollRef = useRef(false);
  const suppressTimerRef = useRef(null);


  // ✅ i18n only (do not hardcode text)
  const TT = useCallback((k) => i18n.t(k), []);

// Period -> days helper (UI duration picker uses these ids)
const periodToDays = (per) => {
  const p = String(per || "").toLowerCase();
  if (p === "90" || p === "d90") return 90;
  if (p === "180" || p === "d180") return 180;
  if (p === "365" || p === "annual" || p === "year") return 365;
  return 30;
};

  const TT_SAFE = useCallback((k, fallbackKey) => {
    const v = i18n.t(k);
    if (typeof v === "string" && v === k && fallbackKey) return i18n.t(fallbackKey);
    return v;
  }, []);

  // ✅ simple "in-flight" guard for purchases (no UI changes, only disables buttons)
  const [buyingKey, setBuyingKey] = useState(null);
  // Plan purchase periods (picked via popup)
  const PLAN_PERIOD_OPTIONS = useMemo(
    () => [
      { id: "d30", labelKey: "store.plans.period.30d", fallback: "30 days" },
      { id: "d90", labelKey: "store.plans.period.90d", fallback: "90 days" },
      { id: "d180", labelKey: "store.plans.period.180d", fallback: "180 days" },
      { id: "annual", labelKey: "store.plans.period.annual", fallback: "Annual" },
    ],
    []
  );
  const [periodPicker, setPeriodPicker] = useState({ visible: false, planId: null, savedX: 0 });

  // Optimistic plan override (prevents UI jump while SettingsContext/Firestore snapshot updates)
  const [optimisticPlan, setOptimisticPlan] = useState(null);
  const [optimisticPlanUntil, setOptimisticPlanUntil] = useState(null);
  const [optimisticPlanPeriod, setOptimisticPlanPeriod] = useState(null);

  // Owned-tab immediate sync (without leaving Store)
  const [ownedOverridePlan, setOwnedOverridePlan] = useState(null);
  const [ownedOverridePlanUntil, setOwnedOverridePlanUntil] = useState(null);
  const [ownedOverridePlanPeriod, setOwnedOverridePlanPeriod] = useState(null);
  const purchaseScrollLockRef = useRef(null);
  
  // (dedup) plans scroll refs declared earlier
const openPeriodPicker = useCallback((planId) => {
    // ✅ UI only: open picker (do NOT touch horizontal scroll)
    const savedX = holdPlansXRef.current || planScrollXRef.current || 0;
    setPeriodPicker({ visible: true, planId: String(planId || ""), savedX });
  }, []);

  const closePeriodPicker = useCallback(() => {
    const savedX = periodPicker?.savedX || planScrollXRef.current || 0;
    // ✅ UI only: close picker (do NOT touch horizontal scroll)
    setPeriodPicker({ visible: false, planId: null, savedX });
  }, [periodPicker?.savedX]);
  const lastPlanRef = useRef(String(settings?.plan || "free").toLowerCase());
  const [packsOwnedLocal, setPacksOwnedLocal] = useState(null);
  const [addonsOwnedLocal, setAddonsOwnedLocal] = useState(null);

  // Local optimistic updates (logic only)
  const [creditsLocal, setCreditsLocal] = useState(null);
  const [entLocal, setEntLocal] = useState(null);

  const apiPost = useCallback(async (path, body) => {
  if (!EFFECTIVE_API_BASE) {
    showErrorToast(toast, TT("store.toast.missingApiBase"));
    throw new Error("MISSING_API_BASE");
  }

  const user = auth.currentUser;
  if (!user) {
    showErrorToast(toast, TT("store.toast.notLoggedIn"));
    throw new Error("UNAUTHENTICATED");
  }

  const token = await user.getIdToken();

  console.log('🧾 API_BASE', EFFECTIVE_API_BASE);

  const urls = [
    `${EFFECTIVE_API_BASE}${path}`,
  ];

  let lastErr = null;

  for (const url of urls) {
    console.log('🧾 apiPost try', { url });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body || {}),
      });

      
      console.log('🧾 apiPost status', { url, status: res.status });
if (res.status === 404) {
        lastErr = { code: "HTTP_404", httpStatus: 404 };
        continue;
      }

      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        const errCode = json?.error || `HTTP_${res.status}`;
        const e = new Error(String(errCode));
        e.code = errCode;
        e.httpStatus = res.status;
        throw e;
      }

      return json;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("HTTP_404");
}, [toast, TT]);

  const credits = Number(creditsLocal ?? settings?.credits ?? settings?.entitlements?.credits ?? 0) || 0;
  const currentPlan = String(optimisticPlan || ownedOverridePlan || settings.plan || "free").toLowerCase();
  const currentPlanPeriod = optimisticPlanPeriod || ownedOverridePlanPeriod || settings.planPeriod || null;
  const currentPlanUntil = optimisticPlanUntil || ownedOverridePlanUntil || settings.planUntil || null;

  // Owned tab should refresh immediately after purchase inside Store,
  // but must still converge to Firestore truth once SettingsContext updates.
  const ownedPlan = String(ownedOverridePlan || settings.plan || "free").toLowerCase();
  const ownedPlanPeriod = ownedOverridePlanPeriod || settings.planPeriod || null;
  const ownedPlanUntil = ownedOverridePlanUntil || settings.planUntil || null;
  const ownedPlanUntilMs = toMsFromTimestampLike(ownedPlanUntil);

  useEffect(() => {
    // Clear optimistic override once SettingsContext snapshot catches up
    const sp = String(settings?.plan || "free").toLowerCase();
    const op = optimisticPlan ? String(optimisticPlan).toLowerCase() : null;
    if (!op) return;
    if (sp !== op) return;

    // planUntil may be Timestamp or number; normalize to ms
    const toMs = (v) => {
      if (!v) return null;
      if (typeof v === "number") return v;
      if (typeof v?.toMillis === "function") return v.toMillis();
      if (typeof v?.seconds === "number") return v.seconds * 1000;
      return null;
    };
    const sm = toMsFromTimestampLike(settings?.planUntil);
    const om = toMsFromTimestampLike(optimisticPlanUntil);
    if (om && sm && Math.abs(sm - om) > 30 * 1000) return; // still different

    setOptimisticPlan(null);
    setOptimisticPlanUntil(null);
    setOptimisticPlanPeriod(null);

    // Owned override can be cleared once SettingsContext catches up
    setOwnedOverridePlan(null);
    setOwnedOverridePlanUntil(null);
    setOwnedOverridePlanPeriod(null);
  }, [settings?.plan, settings?.planUntil, optimisticPlan, optimisticPlanUntil, ownedOverridePlan, ownedOverridePlanUntil]);


  useEffect(() => {
    const x = purchaseScrollLockRef.current;
    if (typeof x === "number" && x >= 0) {
      
      // clear after next tick
      setTimeout(() => {
        purchaseScrollLockRef.current = null;
      }, 120);
    }
  }, [settings?.plan, settings?.planUntil, restorePlansScroll]);


  
// ✅ Normalize entitlements so UI always sees the timestamp fields even if SettingsContext
// flattens them to the root (e.g. settings.proPromptUntil) instead of settings.entitlements.proPromptUntil.
const entFromSettings = (settings?.entitlements && typeof settings.entitlements === "object") ? settings.entitlements : {};
const entNormalized = {
  ...entFromSettings,
  adFreeUntil: settings?.adFreeUntil ?? entFromSettings.adFreeUntil,
  noWatermarkUntil: settings?.noWatermarkUntil ?? entFromSettings.noWatermarkUntil,
  templatesUntil: settings?.templatesUntil ?? entFromSettings.templatesUntil,
  proPromptUntil: settings?.proPromptUntil ?? entFromSettings.proPromptUntil,
  // planUntil can also be mirrored (used only as fallback for plan-granted display)
  planUntil: settings?.planUntil ?? entFromSettings.planUntil,
};
const ent = entLocal || entNormalized;
  const packsOwnedBase = Array.isArray(ent?.packsOwned) ? ent.packsOwned : [];
  const packsOwned = packsOwnedLocal || packsOwnedBase;
  const templatesOwned = Array.isArray(ent?.templatesOwned) ? ent.templatesOwned : [];
  const addonsOwnedBase = ent?.addons && typeof ent.addons === "object" ? ent.addons : {};
  const addonsOwned = addonsOwnedLocal || addonsOwnedBase; // legacy shape (optional)

  // ---------------- Entitlement helpers (logic-only, UI unchanged) ----------------
  // Distinguish plan-based entitlements vs purchased entitlements (optionally with expiry).
  const localeForDates = String(settings?.language || i18n?.locale || "en");

  const coerceDate = useCallback((v) => {
    if (!v) return null;
    try {
      if (typeof v === "object" && typeof v.toDate === "function") {
        const d = v.toDate();
        return d instanceof Date && !isNaN(d.getTime()) ? d : null;
      }
      

// Firestore Timestamp-like (from snapshot or backend JSON): { seconds, nanoseconds } or { _seconds, _nanoseconds }
if (typeof v === "object") {
  const sec = Number(v.seconds ?? v._seconds);
  const nsec = Number(v.nanoseconds ?? v._nanoseconds);
  if (Number.isFinite(sec) && sec > 0) {
    const ms = sec * 1000 + (Number.isFinite(nsec) && nsec > 0 ? Math.floor(nsec / 1e6) : 0);
    const d = new Date(ms);
    return !isNaN(d.getTime()) ? d : null;
  }
}
// Support plain Firestore Timestamp-like objects { seconds, nanoseconds }
      if (typeof v === "object" && v && ("seconds" in v)) {
        const sec = Number(v?.seconds);
        const ns = Number(v?.nanoseconds || 0);
        if (Number.isFinite(sec) && sec > 0) {
          const ms = sec * 1000 + (Number.isFinite(ns) ? Math.floor(ns / 1e6) : 0);
          const d = new Date(ms);
          return !isNaN(d.getTime()) ? d : null;
        }
      }

      if (v instanceof Date) return !isNaN(v.getTime()) ? v : null;
      if (typeof v === "number") {
        const ms = v < 1e12 ? v * 1000 : v;
        const d = new Date(ms);
        return !isNaN(d.getTime()) ? d : null;
      }
      if (typeof v === "string") {
        const d = new Date(v);
        return !isNaN(d.getTime()) ? d : null;
      }
    } catch (e) {}
    return null;
  }, []);

// Normalize Firestore Timestamp-like values to milliseconds 
  const formatDate = useCallback((d) => {
    if (!d) return "";
    try {
      return new Intl.DateTimeFormat(localeForDates, { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }, [localeForDates]);

  const getMaybeExpiry = useCallback((val) => {
    if (!val || typeof val !== "object") return null;
    const cand = val.expiresAt ?? val.expiry ?? val.expires ?? val.expires_on ?? val.until ?? null;
    return coerceDate(cand);
  }, [coerceDate]);

  const isPlanPro = ownedPlan === "pro";
  const isPlanStudio = ownedPlan === "studio";

  // Plan-granted features based on your rules
  const planGrantsAdsFree = isPlanPro || isPlanStudio;
  const planGrantsNoWatermark = isPlanPro || isPlanStudio;
  const planGrantsProPacksAndTemplates = isPlanPro || isPlanStudio;
  const planGrantsAllPacks = isPlanStudio;
  const planGrantsProPromptEditor = isPlanStudio; // PRO does NOT include Prompt Editor

  const planUntil = coerceDate(currentPlanUntil || settings?.planUntil || settings?.planExpiresAt || ent?.planUntil || ent?.planExpiresAt || null);

  const resolveAddon = useCallback((addonId, planGranted) => {
    // 🧾 DEBUG: expiry source tracing
    try {
      const _pid = String(addonId || "");
      const _ek =
        _pid.startsWith("no_watermark") ? "noWatermarkUntil" :
        _pid.startsWith("ad_free") ? "adFreeUntil" :
        _pid.startsWith("templates_") ? "templatesUntil" :
        _pid.startsWith("pro_prompt_") ? "proPromptUntil" :
        null;

      console.log("🧾 resolveAddon()", {
        addonId: _pid,
        planGranted: !!planGranted,
        plan: String(currentPlan || ""),
        planUntil: settings?.planUntil || ent?.planUntil || null,
        entitlementKey: _ek,
        entitlementVal: _ek ? (ent?.[_ek] ?? null) : null,
        entSnapshot: {
          adFreeUntil: ent?.adFreeUntil ?? null,
          noWatermarkUntil: ent?.noWatermarkUntil ?? null,
          templatesUntil: ent?.templatesUntil ?? null,
          proPromptUntil: ent?.proPromptUntil ?? null,
        },
      });
    } catch (e) {}
    // ✅ For plan-granted add-ons in your monetization model, PRO/STUDIO purchase writes
    // dedicated entitlements (adFreeUntil/noWatermarkUntil/templatesUntil/proPromptUntil) for a fixed 30 days.
    // So if those exist, ALWAYS display and use that expiry (not planUntil), even if planGranted=true.
    const id0 = String(addonId || "");
    const entitlementKey0 =
      id0.startsWith("no_watermark") ? "noWatermarkUntil" :
      id0.startsWith("ad_free") ? "adFreeUntil" :
      id0.startsWith("templates_") ? "templatesUntil" :
      id0.startsWith("pro_prompt_") ? "proPromptUntil" :
      null;

    if (planGranted) {
      // Plan-granted add-ons should be ACTIVE even if the entitlement timestamp hasn't arrived yet.
      // However, planUntil has previously been unreliable (1970 / far future), so only use it when it looks sane.
      const now = Date.now();
      const planUntilSafe =
        planUntil &&
        typeof planUntil.getTime === "function" &&
        planUntil.getTime() > now - 24 * 60 * 60 * 1000 &&
        planUntil.getTime() < now + 400 * 24 * 60 * 60 * 1000
          ? planUntil
          : null;

      if (entitlementKey0) {
        const exp0 = coerceDate(ent?.[entitlementKey0]);
        if (exp0) return { active: true, source: "purchase", expiresAt: exp0 };
        // Entitlement missing -> still active by plan, but avoid showing a bogus date.
        return { active: true, source: "plan", expiresAt: planUntilSafe };
      }
      return { active: true, source: "plan", expiresAt: planUntilSafe };
    }

    // ✅ Backend source of truth (Render server.js):
    // entitlements.noWatermarkUntil / entitlements.adFreeUntil are Firestore Timestamps.
    const id = String(addonId || "");
    const entitlementKey =
      id.startsWith("no_watermark") ? "noWatermarkUntil" :
      id.startsWith("ad_free") ? "adFreeUntil" :
      id.startsWith("templates_") ? "templatesUntil" :
      id.startsWith("pro_prompt_") ? "proPromptUntil" :
      null;

    if (entitlementKey) {
      const exp = coerceDate(ent?.[entitlementKey]);
      return exp ? { active: true, source: "purchase", expiresAt: exp } : { active: false, source: null, expiresAt: null };
    }

    // Legacy/future shape support (object map with per-addon expiry)
    const raw = addonsOwned?.[id];
    if (!raw) return { active: false, source: null, expiresAt: null };
    const exp2 = getMaybeExpiry(raw);
    return { active: true, source: "purchase", expiresAt: exp2 };
  }, [addonsOwned, getMaybeExpiry, coerceDate, ent, planUntil]);

  const resolvePack = useCallback((packId, planGranted) => {
    if (planGranted) return { active: true, source: "plan", expiresAt: planUntil || null };

    const has = Array.isArray(packsOwned) ? packsOwned.includes(packId) : false;
    if (!has) return { active: false, source: null, expiresAt: null };

    const meta =
      (ent?.packsMeta && ent.packsMeta[packId]) ||
      (ent?.packExpiries && ent.packExpiries[packId]) ||
      (ent?.packsExpiries && ent.packsExpiries[packId]) ||
      (ent?.expiries && ent.expiries[packId]) ||
      null;

    const exp = coerceDate(meta?.expiresAt ?? meta?.expiry ?? meta ?? null);
    return { active: true, source: "purchase", expiresAt: exp };
  }, [packsOwned, ent, coerceDate]);

  const resolveTemplatesPack = useCallback((planGranted) => {
    if (planGranted) return { active: true, source: "plan", expiresAt: planUntil || null };

    const has = Array.isArray(templatesOwned) ? templatesOwned.length > 0 : false;
    if (!has) return { active: false, source: null, expiresAt: null };

    const meta = (ent?.templatesMeta) || (ent?.templatesExpiries) || (ent?.expiries) || null;

    let exp = null;
    if (meta && typeof meta === "object") {
      const first = Object.values(meta)[0];
      exp = coerceDate(first?.expiresAt ?? first?.expiry ?? first ?? null);
    }
    return { active: true, source: "purchase", expiresAt: exp };
  }, [templatesOwned, ent, coerceDate]);

  const buildOwnedValue = useCallback((resolved) => {
    if (!resolved?.active) return TT("store.owned.inactive");
    const base = TT("store.owned.active");

    // If we have an expiry, show it. If it's plan-granted (no expiry), show only "Active".
    const d = resolved.expiresAt ? formatDate(resolved.expiresAt) : "";
    return d ? `${base} • ${d}` : base;
  }, [TT, formatDate]);

  const displayNameForOwnedItem = useCallback((id) => {
    const sid = String(id || "");

    // Prefer existing store keys already used elsewhere in this file
    if (sid === "templates_pack") return TT("store.owned.items.templates");
    if (sid === "product_pro") return TT("store.owned.items.proPromptPack");
    if (sid === "prompt_builder") return TT("store.owned.items.promptBuilder");

    // Try optional pack/template title keys (if you add them to locale later)
    const kPack = `store.packs.${sid}.title`;
    const vPack = i18n.t(kPack);
    if (typeof vPack === "string" && vPack !== kPack) return vPack;

    const kTpl = `store.templates.${sid}.title`;
    const vTpl = i18n.t(kTpl);
    if (typeof vTpl === "string" && vTpl !== kTpl) return vTpl;

    return sid;
  }, [TT]);

  const [tab, setTab] = useState("credits");
  const [planPeriod, setPlanPeriod] = useState("d30"); // default: 30 days // credits | plans | addons | owned

  const THEME = useMemo(() => {
    if (isDark) {
      return {
        bg: "#0B0F13",
        card: "#12161D",
        text: "#E7EEF5",
        sub: "#9FB0C2",
        border: "rgba(255,255,255,0.10)",
        headerBg: "#0B0F13",
        headerText: "#E7EEF5",
        teal: "#0F766E",
        tealSoft: "rgba(15,118,110,0.26)",
        pillOff: "rgba(255,255,255,0.06)",
        danger: "#EF4444",
        barStyle: "light-content",
      };
    }
    // light = teal vibe
    return {
      bg: "#F3F5F8",
      card: "#FFFFFF",
      text: "#0B0F13",
      sub: "#4B5563",
      border: "rgba(0,0,0,0.10)",
      headerBg: "#0F766E",
      headerText: "#FFFFFF",
      teal: "#0F766E",
      tealSoft: "rgba(15,118,110,0.12)",
      pillOff: "rgba(0,0,0,0.06)",
      danger: "#DC2626",
      barStyle: "light-content",
    };
  }, [isDark]);

  const styles = useMemo(() => makeStyles(THEME), [THEME]);

  // helper: apply alpha to hex colors (e.g. #0F766E -> rgba(...))
  const withAlpha = useCallback((hex, a) => {
    if (!hex || typeof hex !== "string") return hex;
    const h = hex.replace("#", "").trim();
    if (h.length !== 6) return hex;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return hex;
    const alpha = Math.max(0, Math.min(1, Number(a)));
    return `rgba(${r},${g},${b},${alpha})`;
  }, []);


  // keep Plans scroll after plan update (avoid snapping back to current plan)
  useEffect(() => {
    const prev = lastPlanRef.current;
    if (prev !== currentPlan) {
      lastPlanRef.current = currentPlan;
      try {
        const x = planScrollXRef.current || 0;
        planScrollRef.current?.scrollTo?.({ x, animated: false });
      } catch (e) {}
    }
  }, [currentPlan]);

  // 🔎 Debug: verify plan title fonts (run once)
  useEffect(() => {
    console.log("🧾 StoreScreen planTitle style:", styles?.planTitle);
    console.log("🧾 StoreScreen planKind style:", styles?.planKind);
    console.log("🧾 StoreScreen planPillText style:", styles?.planPillText);
  }, []);

  // --- actions (dev placeholders, you will wire backend endpoints next) ---
  const onBuyCredits = useCallback(async (packId) => {
    const key = `credits:${packId}`;
    if (buyingKey) return;
    setBuyingKey(key);

    try {
      const out = await apiPost("/buy-credits", { pack: packId, packId });
      showSuccessToast(toast, TT("store.toast.purchaseSuccess"));
      return out;
    } catch (e) {
      console.log('🧾 BUY_CREDITS failed', { code: e?.code, httpStatus: e?.httpStatus, message: e?.message });
      const code = String(e?.code || e?.message || "");
      if (code === "NO_CREDITS") {
        showErrorToast(toast, TT("store.toast.insufficientCredits"));
      } else {
        showErrorToast(toast, TT("store.toast.purchaseFailed"));
      }
      return null;
    } finally {
      setBuyingKey(null);
    }
  }, [apiPost, buyingKey, toast, TT, ent]);

  const onBuyAddon = useCallback(async (addonId) => {
    const key = `addon:${addonId}`;
    if (buyingKey) return;
    setBuyingKey(key);

    try {
      const out = await apiPost("/buy-addon", { addon: addonId });
      // Optimistic local update (SettingsContext may update later via Firestore)
      if (out?.success) {
        if (typeof out.creditsAfter === "number") setCreditsLocal(out.creditsAfter);
        if (out.entitlementKey && out.until) {
          setEntLocal((prev) => ({ ...(prev || ent), [String(out.entitlementKey)]: out.until }));
        }
      }
      showSuccessToast(toast, TT("store.toast.addonBought"));
      return out;
    } catch (e) {
      const code = String(e?.code || e?.message || "");
      if (code === "NO_CREDITS") {
        showErrorToast(toast, TT("store.toast.insufficientCredits"));
      } else {
        showErrorToast(toast, TT("store.toast.purchaseFailed"));
      }
      return null;
    } finally {
      setBuyingKey(null);
    }
  }, [apiPost, buyingKey, toast, TT, ent]);

  const onBuyPack = useCallback(async (packId) => {
    const key = `pack:${packId}`;
    if (buyingKey) return;
    setBuyingKey(key);

    try {
      const out = await apiPost("/buy-pack", { packId });
      if (out?.success) {
        if (typeof out.credits === "number") setCreditsLocal(out.credits);
        if (Array.isArray(out.packsOwned)) {
          setEntLocal((prev) => ({ ...(prev || ent), packsOwned: out.packsOwned }));
        } else if (Array.isArray(out?.result?.packsOwned)) {
          setEntLocal((prev) => ({ ...(prev || ent), packsOwned: out.result.packsOwned }));
        }
      }
      showSuccessToast(toast, TT("store.toast.packBought"));
      return out;
    } catch (e) {
      const code = String(e?.code || e?.message || "");
      if (code === "NO_CREDITS") {
        showErrorToast(toast, TT("store.toast.insufficientCredits"));
      } else {
        showErrorToast(toast, TT("store.toast.purchaseFailed"));
      }
      return null;
    } finally {
      setBuyingKey(null);
    }
  }, [apiPost, buyingKey, toast, TT, ent]);

  const onUpgradePlan = useCallback(
    async (planId, periodId, keepScrollX) => {
      const period = String(periodId || "d30");
      const keepX = Number(keepScrollX ?? planScrollXRef.current ?? 0) || 0;
      // ✅ Remember last stable X only (no programmatic scroll)
      holdPlansXRef.current = keepX;
      const key = `plan:${planId}:${period}`;
      if (buyingKey) return;
      setBuyingKey(key);

      try {
        const uid = auth?.currentUser?.uid;
        if (!uid) {
          showErrorToast(toast, TT("store.toast.notLoggedIn"));
          return;
        }

        const nextPlan = String(planId || "").toLowerCase();
        if (!nextPlan) return;

        // Prefer backend time-based plan purchase, but ALWAYS update Firestore as client-side source of truth
// (SettingsContext listens to users/{uid}.plan, .planPeriod, .planUntil)
let planUntilMs = null;

try {
  const out = await apiPost("/buy-plan", { planId: nextPlan, period: period });

  if (out?.success) {
    const serverUntil =
      out?.planUntil ?? out?.until ?? out?.expiresAt ?? out?.planExpiresAt ?? null;


planUntilMs = toMsFromTimestampLike(serverUntil);

// Fallback: if backend returns an un-serializable Timestamp, compute from period
if (!Number.isFinite(planUntilMs) || planUntilMs <= 0) {
  const dd = periodToDays(periodId);
  planUntilMs = Date.now() + dd * 24 * 60 * 60 * 1000;
}
  } else {
    // ❌ Do NOT activate plan on non-success
    const errCode = String(out?.error || out?.code || "");
    if (errCode === "NO_CREDITS") {
      showErrorToast(toast, TT("store.toast.insufficientCredits"));
      return;
    }
    showErrorToast(toast, TT("store.toast.purchaseFailed"));
    return;
}
} catch (e) {
  // ❌ Do NOT fall back to local activation on error
  console.log("⚠️ /buy-plan failed:", e?.message || String(e));
  showErrorToast(toast, TT("store.toast.insufficientCredits"));
  return;
}
// ✅ Write to Firestore so the plan activates immediately across the app

if (!Number.isFinite(planUntilMs) || planUntilMs <= 0) {
  showErrorToast(toast, TT("store.toast.purchaseFailed"));
  return;
}

await updateDoc(doc(db, "users", uid), {
  plan: nextPlan,
  planPeriod: periodId,
  planUntil: Timestamp.fromMillis(planUntilMs),
});

// Optimistic UI update (keeps UI stable while Firestore snapshot catches up)
setOptimisticPlan(nextPlan);
setOptimisticPlanUntil(Timestamp.fromMillis(planUntilMs));
setOptimisticPlanPeriod(periodId);

        // ✅ Owned tab instant refresh (without exiting Store)
        setOwnedOverridePlan(planKey);
        setOwnedOverridePlanUntil(planUntilMs);
        setOwnedOverridePlanPeriod(periodId);
        setOwnedOverrideSetAt(Date.now());
purchaseScrollLockRef.current = keepX;

showSuccessToast(
  toast,
  TT_SAFE("store.toast.planBought", "store.toast.planUpdated")
);

// ✅ Do NOT programmatically scroll after purchase
      } catch (e) {
        console.log("❌ BUY_PLAN failed:", e);
        showErrorToast(toast, TT("store.toast.purchaseFailed"));
      } finally {
        setBuyingKey(null);
      }
    },
    [toast, TT, TT_SAFE, apiPost, buyingKey, restorePlansScroll]
  );

  const onPickPeriodAndBuy = useCallback(
    (periodId) => {
      const planId = periodPicker?.planId;
      const savedX = periodPicker?.savedX || planScrollXRef.current || 0;
      setPeriodPicker({ visible: false, planId: null, savedX });
      if (!planId) return;
      onUpgradePlan(planId, periodId, savedX);
    },
    [periodPicker, onUpgradePlan]
  );

  // ---------- UI bits ----------
  const Header = () => (
    <View style={styles.header}>
      <StatusBar barStyle={THEME.barStyle} />
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => navigation?.goBack?.()}
          style={({ pressed }) => [styles.headerBack, pressed && { opacity: 0.8 }]}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={THEME.headerText} />
        </Pressable>

        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{TT("store.title")}</Text>
          <Text style={styles.headerSub}>{TT("store.subtitle")}</Text>
        </View>

        <View style={styles.headerCreditsPill}>
          <Text style={styles.headerCreditsText}>
            {TT("store.header.credits")}: {credits}
          </Text>
        </View>
      </View>
    </View>
  );

  
  const TabBtn = ({ id, icon, labelKey, fallback }) => {
    const active = tab === id;
    return (
      <Pressable
        onPress={() => setTab(id)}
        style={({ pressed }) => [
          styles.tabBtn,
          active ? styles.tabBtnActive : styles.tabBtnInactive,
          pressed && { opacity: 0.88 },
        ]}
      >
        <Ionicons
          name={icon}
          size={16}
          color={active ? (isDark ? "#7CF0E4" : THEME.teal) : THEME.sub}
        />
        <Text style={[styles.tabText, { color: active ? THEME.text : THEME.sub }]} numberOfLines={1}>
          {TT(labelKey)}
        </Text>
      </Pressable>
    );
  };

  const Tabs = () => (
    <View style={styles.tabsWrap}>
      <View style={styles.tabsRow}>
        <TabBtn id="credits" icon="cash-outline" labelKey="store.tabs.credits" fallback="Credits" />
        <TabBtn id="plans" icon="layers-outline" labelKey="store.tabs.plans" fallback="Plans" />
        <TabBtn id="addons" icon="sparkles-outline" labelKey="store.tabs.addons" fallback="Add-ons" />
        <TabBtn id="owned" icon="checkmark-circle-outline" labelKey="store.tabs.owned" fallback="Owned" />
      </View>
    </View>
  );

  const Card = ({ children, style }) => <View style={[styles.card, style]}>{children}</View>;

  const PrimaryBtn = ({ onPress, disabled, label }) => (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.primaryBtn,
        disabled && { opacity: 0.45 },
        pressed && !disabled && { opacity: 0.86 },
      ]}
    >
      <Text style={styles.primaryBtnText}>{label}</Text>
    </Pressable>
  );

  const SecondaryBtn = ({ onPress, disabled, label }) => (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.secondaryBtn,
        { borderColor: "#14B8A6" }, // teal outline
        disabled && { opacity: 0.45 },
        pressed && !disabled && { opacity: 0.86 },
      ]}
    >
      <Text style={styles.secondaryBtnText}>{label}</Text>
    </Pressable>
  );

  // ---------- Tabs ----------

  const CreditsTab = () => {
    const cols = 2;
    const gap = 12;
    const cardW = Math.floor((SCREEN_W - 16 * 2 - gap) / cols);

    return (
      <View style={styles.sectionWrap}>
        <Text style={styles.sectionTitle}>{TT("store.credits.title")}</Text>
        <Text style={[styles.smallMuted, { marginBottom: 12 }]}>
          {TT("store.credits.devNote")}
        </Text>

        <View style={styles.gridWrap}>
          {CREDIT_PACKS.map((p) => (
            <View key={p.id} style={{ width: cardW, marginBottom: gap }}>
              <LinearGradient
                colors={isDark ? ["#0F766E", "#063A36"] : ["#0F766E", "#14B8A6"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[styles.creditCard, styles.cardRound]}
              >
                <View style={styles.creditIcon}>
                  <Ionicons name={p.icon} size={18} color="#FFFFFF" />
                </View>

                <Text style={styles.creditAmount}>+{p.amount}</Text>
                <Text style={styles.creditSub}>{TT("store.credits.pack")}</Text>

                <View style={{ height: 12 }} />
                <PrimaryBtn
                  onPress={() => onBuyCredits(p.id)}
                    disabled={false || buyingKey === `credits:${p.id}`}
                  label={TT("store.common.buy")}
                />
              </LinearGradient>
            </View>
          ))}
        </View>
      </View>
    );
  };

  const PlansTab = () => {
    const gap = 14;
    // ✅ slightly smaller cards (as you asked)
    const cardW = Math.round(SCREEN_W * 0.72);
    const snap = cardW + gap;

    return (
      <View style={[styles.sectionWrap, { paddingHorizontal: 0 }]}>
        <View style={{ paddingHorizontal: 16 }}>
          <Text style={styles.sectionTitle}>{TT("store.plans.title")}</Text>
          <Text style={styles.smallMuted}>{TT("store.plans.subtitle")}</Text>
        </View>
      <ScrollView
          ref={planScrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12 }}
          snapToInterval={snap}
          decelerationRate="fast"
          snapToAlignment="center"
          onScroll={(e) => {
            const x = e?.nativeEvent?.contentOffset?.x || 0;
            planScrollXRef.current = x;
            holdPlansXRef.current = x;
          }}
          scrollEventThrottle={16}
        >
          {PLAN_DEFS.map((p, idx) => {
            const isCurrent = currentPlan === p.id;

            const gradA = p.accent.light[0];
            const gradB = p.accent.light[1];

            // FREE top tweak: prevent "FREE" melting into white
            const freeTextColor = p.id === "free" ? "#0B0F13" : "#FFFFFF";
            const freeSubColor = p.id === "free" ? "rgba(11,15,19,0.70)" : "rgba(255,255,255,0.82)";
            const pillBg = p.id === "free" && !isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.18)";
            const pillBorder = p.id === "free" && !isDark ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.20)";
            const pillText = p.id === "free" && !isDark ? "#0B0F13" : "#FFFFFF";

            const includeKeys = Array.isArray(p.includesKeys) ? p.includesKeys : [];
            const lenKey = includeKeys.find((k) => String(k).startsWith("store.perks.maxLen"));
            const fpsKey = includeKeys.find((k) => String(k).startsWith("store.perks.maxFps"));
            const resKey = includeKeys.find((k) =>
              ["store.perks.max720p", "store.perks.max1080p", "store.perks.max4k"].includes(String(k))
            );

            const limitsLine = [lenKey, fpsKey, resKey].filter(Boolean).map((k) => TT(k)).join(" • ");

            const includes = includeKeys
              .filter((k) => k !== lenKey && k !== fpsKey && k !== resKey)
              .map((k) => TT(k));

            const excludes = Array.isArray(p.excludesKeys) ? p.excludesKeys.map((k) => TT(k)) : [];

            return (
              <View
                key={p.id}
                style={[
                  styles.planCardOuter,
                  { width: cardW, marginRight: idx === PLAN_DEFS.length - 1 ? 0 : gap },
                   { borderColor: withAlpha((p?.accent?.light?.[0] || THEME.border), isCurrent ? 0.85 : 0.55) },
                ]}
              >
                <View style={[styles.planTop, { backgroundColor: gradA }]}>
                  <View style={[StyleSheet.absoluteFillObject, { backgroundColor: gradB, opacity: 0.55 }]} />
                  <View style={styles.planTopInner}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.planTitle, { color: freeTextColor, fontFamily: "Barlow_800ExtraBold", fontStyle: "normal" }]}>
                        {TT(p.titleKey)}
                      </Text>
                      <Text style={[styles.planKind, { color: freeSubColor, fontFamily: "Barlow_500Medium", fontStyle: "normal" }]}>
                        {TT("store.plans.kind")}
                      </Text>
                    </View>

                    {p.id === "free" && !isCurrent ? null : (
                      <View style={[styles.planPill, { backgroundColor: pillBg, borderColor: pillBorder }]}>
                        <Text style={[styles.planPillText, { color: pillText, fontFamily: "Barlow_700Bold", fontStyle: "normal" }]}>
                          {isCurrent ? (TT("store.plans.current") + (currentPlanPeriod ? ` · ${formatPlanPeriod(currentPlanPeriod)}` : "")) : TT("store.plans.available")}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>

                <View style={styles.planBody}>
                  <View style={{ flex: 1 }}>
                  <Text style={styles.planIncludes}>{TT("store.plans.includes")}</Text>

                  {limitsLine ? (
				  <View style={styles.bulletRow}>
					<Ionicons
					  name="checkmark-circle"
					  size={16}
					  color={isDark ? "#7CF0E4" : THEME.teal}
					/>
					<Text style={styles.bulletText}>{limitsLine}</Text>
				  </View>
				) : null}

                  {includes.map((b, i) => (
                    <View key={`${p.id}_inc_${i}`} style={styles.bulletRow}>
                      <Ionicons name="checkmark-circle" size={16} color={isDark ? "#7CF0E4" : THEME.teal} />
                      <Text style={styles.bulletText}>{b}</Text>
                    </View>
                  ))}

                  {excludes.length > 0 && (
                    <>
                      <View style={{ height: 6 }} />
                      <Text style={styles.planIncludes}>{TT("store.plans.notIncluded")}</Text>

                      {excludes.map((b, i) => (
                        <View key={`${p.id}_exc_${i}`} style={styles.bulletRow}>
                          <Ionicons name="close-circle" size={16} color={THEME.danger} />
                          <Text style={styles.bulletText}>{b}</Text>
                        </View>
                      ))}
                    </>
                  )}
                  </View>

                  {p.id === "free" ? null : (
                    <>
                      <View style={{ height: 10 }} />
                      <SecondaryBtn
                        disabled={isCurrent || (typeof buyingKey === "string" && buyingKey.startsWith(`plan:${p.id}:`))}
                        onPress={() => (isCurrent ? null : openPeriodPicker(p.id))}
                        label={isCurrent ? TT("store.plans.currentPlan") : TT("store.plans.upgrade")}
                        color={p?.accent?.light?.[0]}
                      />
                    </>
                  )}
                </View>
              </View>
            );
          })}
        </ScrollView>
      </View>
    );
  };

  const AddonsTab = () => {
    const cols = 2;
    const gap = 12;
    const cardW = Math.floor((SCREEN_W - 16 * 2 - gap) / cols);

    const isPackOwned = (packId) => {
      if (!packId) return false;
      // STUDIO unlocks everything
      if (planGrantsAllPacks) return true;
      // PRO/STUDIO includes PRO packs + templates
      if (planGrantsProPacksAndTemplates) {
        if (packId === "product_pro" || packId === "templates_pack") return true;
      }
      return Array.isArray(packsOwned) ? packsOwned.includes(packId) : false;
    };

    return (
      <View style={styles.sectionWrap}>
        <Text style={styles.sectionTitle}>{TT("store.addons.title")}</Text>

        {ADDON_GROUPS.map((g) => {
          const isPack = g.type === "pack";
          const ownedPack = isPack ? isPackOwned(g.pack?.id) : false;

          return (
            <View key={g.id} style={{ marginBottom: 18 }}>
              <View style={styles.groupHeader}>
                <View style={styles.groupIcon}>
                  <Ionicons name={g.icon} size={16} color={THEME.text} />
                </View>
                <Text style={styles.groupTitle}>{TT(g.titleKey)}</Text>
              </View>

              {isPack ? (
                <Card style={[styles.cardRound, styles.addonCardTall]}>
                  <Text style={styles.addonLabel}>{TT(g.titleKey)}</Text>
                  <Text style={styles.smallMuted}>
                    {ownedPack ? TT_SAFE("store.common.active", "store.common.owned") : TT("store.common.available")}
                  </Text>

                  <View style={{ flex: 1 }} />

                  <PrimaryBtn
                    onPress={() => onBuyPack(g.pack.id)}
                    disabled={ownedPack || buyingKey === `pack:${g.pack.id}`}
                    label={ownedPack ? TT_SAFE("store.common.active", "store.common.owned") : TT("store.common.buy")}
                  />
                </Card>
              ) : (
                <View style={styles.gridWrap}>
                  {g.items.map((it) => {
                    const planGranted =
                      (String(it.id).startsWith("ad_free") && planGrantsAdsFree) ||
                      (String(it.id).startsWith("no_watermark") && planGrantsNoWatermark) ||
                      (String(it.id).startsWith("templates_") && (planGrantsProPacksAndTemplates)) ||
                      (String(it.id).startsWith("pro_prompt_") && (planGrantsProPromptEditor));

                    const resolved = resolveAddon(it.id, planGranted);
                    const owned = !!resolved?.active;
                    return (
                      <View key={it.id} style={{ width: cardW, marginBottom: gap }}>
                        <Card style={[styles.cardRound, styles.addonCardTall]}>
                          <Text style={styles.addonLabel}>{TT(it.labelKey)}</Text>
                          <Text style={styles.smallMuted}>
                            {owned ? TT_SAFE("store.common.active", "store.common.owned") : TT("store.common.available")}
                          </Text>

                          <View style={{ flex: 1 }} />

                          <PrimaryBtn
                            onPress={() => onBuyAddon(it.id)}
                            disabled={buyingKey === `addon:${it.id}`}
                            label={TT("store.common.buy")}
                          />
                        </Card>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}
      </View>
    );
  };

  const OwnedTab = () => {
    // 🧾 DEBUG: what Owned tab sees right now
    try {
      console.log("🧾 OWNED_TAB_SNAPSHOT", {
        plan: String(currentPlan || ""),
        planPeriod: settings?.planPeriod || null,
        planUntil: settings?.planUntil || null,
        entitlements: {
          adFreeUntil: ent?.adFreeUntil ?? null,
          noWatermarkUntil: ent?.noWatermarkUntil ?? null,
          templatesUntil: ent?.templatesUntil ?? null,
          proPromptUntil: ent?.proPromptUntil ?? null,
        },
      });
    } catch (e) {}
    // Owned tab must match the style you referenced (current plan + active add-ons + purchased packs list)
    const noWatermark7 = resolveAddon("no_watermark_7d", planGrantsNoWatermark);
    const noWatermark30 = resolveAddon("no_watermark_30d", planGrantsNoWatermark);

    const activeNoWatermark =
      (noWatermark7.active || noWatermark30.active)
        ? ({
            active: true,
            source: (noWatermark7.source === "plan" || noWatermark30.source === "plan") ? "plan" : "purchase",
            expiresAt:
              (noWatermark7.expiresAt && noWatermark30.expiresAt)
                ? (noWatermark7.expiresAt > noWatermark30.expiresAt ? noWatermark7.expiresAt : noWatermark30.expiresAt)
                : (noWatermark30.expiresAt || noWatermark7.expiresAt || null),
          })
        : ({ active: false, source: null, expiresAt: null });

    const ads7 = resolveAddon("ad_free_7d", planGrantsAdsFree);
    const ads30 = resolveAddon("ad_free_30d", planGrantsAdsFree);

    const activeAdsFree =
      (ads7.active || ads30.active)
        ? ({
            active: true,
            source: (ads7.source === "plan" || ads30.source === "plan") ? "plan" : "purchase",
            expiresAt:
              (ads7.expiresAt && ads30.expiresAt)
                ? (ads7.expiresAt > ads30.expiresAt ? ads7.expiresAt : ads30.expiresAt)
                : (ads30.expiresAt || ads7.expiresAt || null),
          })
        : ({ active: false, source: null, expiresAt: null });

    return (
      <View style={styles.sectionWrap}>
        <Text style={styles.sectionTitle}>{TT("store.owned.title")}</Text>

        <Card style={[styles.cardRound, styles.ownedCard]}>
          <View style={styles.ownedRow}>
            <Text style={styles.ownedTitle}>{TT("store.owned.currentPlan")}</Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{String(currentPlan || "free").toUpperCase()}</Text>
            </View>
          </View>

          <View style={{ height: 12 }} />

          <Text style={styles.ownedTitle}>{TT("store.owned.activeAddons")}</Text>
          <View style={{ height: 10 }} />

          <OwnedLine
            label={TT("store.addons.noWatermark.title")}
            value={buildOwnedValue(activeNoWatermark)}
            isActive={!!activeNoWatermark?.active}
            THEME={THEME}
            styles={styles}
          />
          <OwnedLine
            label={TT("store.addons.adsFree.title")}
            value={buildOwnedValue(activeAdsFree)}
            isActive={!!activeAdsFree?.active}
            THEME={THEME}
            styles={styles}
          />

          <View style={[styles.hr, { backgroundColor: THEME.border }]} />

          
<Text style={styles.ownedTitle}>{TT_SAFE("store.owned.additionalContent", "store.owned.packsOwned")}</Text>
          <View style={{ height: 10 }} />

          {(() => {
            const planStudio = String(currentPlan) === "studio";
            const planProOrStudio = String(currentPlan) === "pro" || planStudio;

            const currentPlanUntilMs = toMsFromTimestampLike((currentPlanUntil ?? settings?.planUntil));
            const pro7 = resolveAddon("pro_prompt_7d", planProOrStudio);
            const pro30 = resolveAddon("pro_prompt_30d", planProOrStudio);
            const activeProPrompt =
              (pro7.active || pro30.active)
                ? ({
                    active: true,
                    expiresAt:
                      (pro7.expiresAt && pro30.expiresAt)
                        ? (pro7.expiresAt > pro30.expiresAt ? pro7.expiresAt : pro30.expiresAt)
                        : (pro30.expiresAt || pro7.expiresAt || null),
                  })
                : ({ active: false, expiresAt: null });

            const t7 = resolveAddon("templates_7d", planProOrStudio);
            const t30 = resolveAddon("templates_30d", planProOrStudio);
            const activeTemplates =
              (t7.active || t30.active)
                ? ({
                    active: true,
                    expiresAt:
                      (t7.expiresAt && t30.expiresAt)
                        ? (t7.expiresAt > t30.expiresAt ? t7.expiresAt : t30.expiresAt)
                        : (t30.expiresAt || t7.expiresAt || null),
                  })
                : ({ active: false, expiresAt: null });

            // Prompt Builder: Studio includes it by default (as in your file)
            const promptBuilderActive = planProOrStudio;

            
const rows = [
  {
    key: "proPromptPack",
    active: activeProPrompt.active,
    label: TT("store.owned.items.proPromptPack"),
    value: buildOwnedValue({ active: activeProPrompt.active, source: activeProPrompt.active ? "purchase" : null, expiresAt: activeProPrompt.expiresAt || null }),
  },
  {
    key: "templates",
    active: activeTemplates.active,
    label: TT("store.owned.items.templates"),
    value: buildOwnedValue({ active: activeTemplates.active, source: activeTemplates.active ? "purchase" : null, expiresAt: activeTemplates.expiresAt || null }),
  },
  {
    key: "promptBuilder",
    active: promptBuilderActive,
    label: TT("store.owned.items.promptBuilder"),
    value: buildOwnedValue({ active: promptBuilderActive, source: promptBuilderActive ? "plan" : null, expiresAt: planUntil || null }),
  },
];

            return (
              <>
                
{rows.map((r) => (
  <View key={r.key} style={styles.ownedRowLine}>
    <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
      <Ionicons
        name={r.active ? "checkmark-circle" : "close-circle"}
        size={16}
        color={r.active ? (isDark ? "#7CF0E4" : THEME.teal) : THEME.danger}
        style={{ marginRight: 8 }}
      />
      <Text style={styles.ownedLineText} numberOfLines={1}>
        {r.label}
      </Text>
    </View>

    <Text
      style={[
        styles.ownedLineValue,
        { color: r.active ? (THEME.teal || "#0F766E") : THEME.sub },
      ]}
      numberOfLines={1}
    >
      {r.value}
    </Text>
  </View>
))}
</>
            );
          })()}
        </Card>
      </View>
    );
  };

  const renderBody = () => {
    if (tab === "credits") return CreditsTab();
    if (tab === "plans") return PlansTab();
    if (tab === "addons") return AddonsTab();
    return OwnedTab();
  };

  return (
    <View style={styles.root}>
      <Header />
      <Tabs />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 26 }} showsVerticalScrollIndicator={false}>
        {renderBody()}
      </ScrollView>
      <Modal
      transparent
      animationType="fade"
      visible={!!periodPicker?.visible}
      onRequestClose={() => setPeriodPicker({ visible: false, planId: null })}
    >
      <Pressable
        style={styles.periodBackdrop}
        onPress={() => setPeriodPicker({ visible: false, planId: null })}
      >
        <View
          style={styles.periodModalWrap}
          onStartShouldSetResponder={() => true}
          onResponderStart={() => {}}
        >
          <View style={styles.periodCard}>
            <Text style={styles.periodTitle}>{TT("store.plans.periodTitle")}</Text>

            <Pressable
              onPress={() => setPeriodPicker({ visible: false, planId: null })}
              hitSlop={10}
              style={({ pressed }) => [styles.periodClose, pressed && { opacity: 0.75 }]}
            >
              <Ionicons name="close" size={18} color={THEME.text} />
            </Pressable>

            <View style={styles.periodDivider} />

            {["d30", "d90", "d180", "annual"].map((per) => {
              const isActive = planPeriod === per;
              return (
                <Pressable
                  key={per}
                  onPress={() => {
                    // preserve current horizontal position
                    savedPlanScrollXRef.current = planScrollXRef.current || savedPlanScrollXRef.current || 0;
                    suppressPlanAutoScrollRef.current = true;
                    if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);

                    setPlanPeriod(per);
                    // Close the picker UI
                    setPeriodPicker({ visible: false, planId: null });
                    // ✅ Immediately purchase the selected period for the chosen plan
                    const chosenPlanId = String(periodPicker?.planId || "");
                    const keepX = Number(savedPlanScrollXRef.current || periodPicker?.savedX || planScrollXRef.current || 0) || 0;
                    if (chosenPlanId) {
                      // slight microtask delay to allow Modal close without triggering a snap
                      Promise.resolve().then(() => onUpgradePlan(chosenPlanId, per, keepX));
                    }
// lock the scroll in place after selection (prevents snap to first card)
                    
                    if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
                    suppressTimerRef.current = setTimeout(() => {
                      suppressPlanAutoScrollRef.current = false;
                    }, 1200);
                  }}
                  
                >
                  {({ pressed }) => (
                    <View
                      style={[
                        styles.periodBtn,
                        pressed && styles.periodBtnPressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.periodBtnText,
                          pressed && { color: "#FFFFFF" },
                        ]}
                      >
                        {TT(`store.plans.period.${per}`)}
                      </Text>
                    </View>
                  )}
                </Pressable>
              );
            })}

          </View>
        </View>
      </Pressable>
    </Modal>

    </View>
  );
}

function OwnedLine({ label, value, isActive, THEME, styles }) {
  return (
    <View style={styles.ownedLine}>
      <Text style={styles.ownedLineLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[
          styles.ownedLineValue,
          { color: isActive ? (THEME.teal || "#0F766E") : THEME.sub },
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

// ---------- Styles ----------
function makeStyles(THEME) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: THEME.bg },

    header: {
      backgroundColor: THEME.headerBg,
      paddingTop: Platform.OS === "android" ? 34 : 40, // ✅ moved lower (as requested)
      paddingBottom: 16,
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: THEME.border,
    },
    headerRow: { flexDirection: "row", alignItems: "center" },
    headerBack: { padding: 6, borderRadius: PILL_RADIUS, marginRight: 6 },
    headerTitle: { color: THEME.headerText, fontFamily: "Barlow_700Bold", fontSize: 18 },
    headerSub: {
      marginTop: 2,
      color: THEME.headerText === "#FFFFFF" ? "rgba(255,255,255,0.78)" : THEME.sub,
      fontFamily: "Barlow_400Regular",
      fontSize: 12,
    },
    headerCreditsPill: {
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: PILL_RADIUS,
      backgroundColor: THEME.headerText === "#FFFFFF" ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)",
      borderWidth: 1,
      borderColor: THEME.headerText === "#FFFFFF" ? "rgba(255,255,255,0.22)" : THEME.border,
    },
    headerCreditsText: { color: THEME.headerText, fontFamily: "Barlow_700Bold", fontSize: 12 },

    tabsWrap: { paddingHorizontal: 16, paddingTop: 14 },
    tabsRow: { flexDirection: "row" },
    tabBtn: {
      flex: 1,
      paddingVertical: 10,
      paddingHorizontal: 10,
      borderRadius: 18,
      borderWidth: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      marginRight: 10,
    },
    tabBtnActive: { backgroundColor: THEME.tealSoft, borderColor: "rgba(15,118,110,0.55)" },
    tabBtnInactive: { backgroundColor: THEME.pillOff, borderColor: THEME.border },
    tabText: { marginLeft: 6, fontFamily: "Barlow_600SemiBold", fontSize: 12 },


    // Plan duration pills
    periodPill: {
      borderRadius: PILL_RADIUS,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderWidth: 1,
      marginRight: 8,
      marginBottom: 8,
    },
    periodPillActive: { backgroundColor: THEME.tealSoft, borderColor: "rgba(15,118,110,0.55)" },
    periodPillInactive: { backgroundColor: THEME.pillOff, borderColor: THEME.border },
    periodPillText: { fontFamily: "Barlow_700Bold", fontSize: 12 },
    periodPillTextActive: { color: THEME.text },
    periodPillTextInactive: { color: THEME.sub },

    card: {
      backgroundColor: THEME.card,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: THEME.teal,
      padding: 14,
    },
    cardRound: { borderRadius: 22 },

    sectionWrap: { paddingHorizontal: 16, paddingTop: 14 },
    sectionTitle: { color: THEME.text, fontFamily: "Barlow_700Bold", fontSize: 16, marginBottom: 10 },
    smallMuted: { color: THEME.sub, fontFamily: "Barlow_400Regular", fontSize: 12 },
    gridWrap: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },

    primaryBtn: { backgroundColor: THEME.teal, borderRadius: PILL_RADIUS, paddingVertical: 12, alignItems: "center" },
    primaryBtnText: { color: "#fff", fontFamily: "Barlow_700Bold", fontSize: 13 },
    secondaryBtn: {
      borderRadius: PILL_RADIUS,
      paddingVertical: 11,
      alignItems: "center",
      borderWidth: 1,
      borderColor: THEME.border,
      backgroundColor: "transparent",
    },
    secondaryBtnText: { color: THEME.teal, fontFamily: "Barlow_700Bold", fontSize: 13 },

    // Credits
    creditCard: {
      minHeight: 190, // ✅ a bit taller
      padding: 14,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.16)",
    },
    creditIcon: {
      width: 34,
      height: 34,
      borderRadius: 999,
      backgroundColor: "rgba(255,255,255,0.18)",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.20)",
    },
    creditAmount: { marginTop: 10, color: "#fff", fontFamily: "Barlow_800ExtraBold", fontSize: 20 },
    creditSub: { marginTop: 2, color: "rgba(255,255,255,0.82)", fontFamily: "Barlow_500Medium", fontSize: 12 },

    groupHeader: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
    groupIcon: {
      width: 28,
      height: 28,
      borderRadius: 999,
      backgroundColor: THEME.pillOff,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: THEME.border,
      marginRight: 8,
    },
    groupTitle: { color: THEME.sub, fontFamily: "Barlow_700Bold", fontSize: 13 },

    addonLabel: { color: THEME.text, fontFamily: "Barlow_800ExtraBold", fontSize: 14 },
    addonCardTall: { minHeight: 170 }, // ✅ taller / nicer

    // Plans
    planCardOuter: {
      borderRadius: 22,
      borderWidth: 1,
      borderColor: THEME.border,
      overflow: "hidden",
      minHeight: Math.round(SCREEN_H * 0.6), // vagy pl. SCREEN_H - 260
    },
    planTop: { height: 124 },
    planTopInner: { padding: 14, flexDirection: "row", alignItems: "center" },
    planTitle: { fontFamily: "Barlow_800ExtraBold", fontSize: 18, letterSpacing: 0.8 , fontStyle: "normal",
      includeFontPadding: false},
    planKind: { fontFamily: "Barlow_500Medium", fontSize: 12, marginTop: 2 , fontStyle: "normal",
      includeFontPadding: false},
    planPill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: PILL_RADIUS, borderWidth: 1 },
    planPillText: { fontFamily: "Barlow_700Bold", fontSize: 11 , fontStyle: "normal",
      includeFontPadding: false},
    planBody: { backgroundColor: THEME.card, padding: 14, flex: 1 },
    planLimitsLine: { color: THEME.sub, fontFamily: "Barlow_500Medium", fontSize: 12, marginBottom: 10 },
    planIncludes: { color: THEME.text, fontFamily: "Barlow_700Bold", fontSize: 13, marginBottom: 6 },
    bulletRow: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
    bulletText: { color: THEME.sub, fontFamily: "Barlow_400Regular", fontSize: 12, marginLeft: 8, flex: 1 },

    // Owned (match the referenced style)
    ownedCard: { padding: 16 },
    ownedRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    ownedRowLine: { flexDirection: "row", alignItems: "center", marginTop: 10 },
    ownedTitle: { color: THEME.text, fontFamily: "Barlow_700Bold", fontSize: 16 },
    badge: {
      paddingHorizontal: 12,
      height: 30,
      borderRadius: 15,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: THEME.tealSoft,
      borderWidth: 1,
      borderColor: "rgba(15,118,110,0.35)",
    },
    badgeText: { color: THEME.teal, fontFamily: "Barlow_700Bold", fontSize: 12 },
    badgeSmall: {
      paddingHorizontal: 12,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: THEME.tealSoft,
      borderWidth: 1,
      borderColor: "rgba(15,118,110,0.35)",
      marginLeft: 10,
    },
    badgeSmallText: { color: THEME.teal, fontFamily: "Barlow_700Bold", fontSize: 12 },
    hr: { height: 1, marginVertical: 14 },
    ownedLine: { flexDirection: "row", alignItems: "center", marginTop: 8 },
    ownedLineLabel: { color: THEME.sub, fontFamily: "Barlow_400Regular", fontSize: 14, flex: 1 },
    ownedLineValue: { fontFamily: "Barlow_700Bold", fontSize: 13 },
    ownedLineText: { color: THEME.sub, fontFamily: "Barlow_400Regular", fontSize: 14, flex: 1 },

    // --- Plan period picker modal (Store style) ---
    periodModalOverlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0,0,0,0.55)",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 18,
    },
    periodModalCard: {
      width: "100%",
      maxWidth: 420,
      backgroundColor: THEME.card,
      borderRadius: 22,
      padding: 16,
      borderWidth: 1,
      borderColor: THEME.border,
    },
    periodModalHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 8,
    },
    periodModalTitle: {
      fontFamily: "Barlow_700Bold",
      fontSize: 16,
      color: THEME.text,
      flex: 1,
      paddingRight: 10,
    },
    periodModalCloseBtn: {
      width: 34,
      height: 34,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: THEME.card2,
      borderWidth: 1,
      borderColor: THEME.border,
    },
    periodModalDivider: {
      height: 1,
      backgroundColor: THEME.border,
      opacity: 0.6,
      marginBottom: 12,
    },
    periodModalOption: {
      borderRadius: 18,
      paddingVertical: 12,
      paddingHorizontal: 14,
      backgroundColor: THEME.card2,
      borderWidth: 1,
      borderColor: THEME.border,
      marginBottom: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    periodModalOptionPressed: {
      opacity: 0.9,
      backgroundColor: THEME.tealSoft || THEME.card2,
      borderColor: THEME.teal || THEME.border,
    },
    periodModalOptionText: {
      fontFamily: "Barlow_600SemiBold",
      fontSize: 14,
      color: THEME.text,
      textAlign: "center",
    },


    // ---- Period picker (Plans) modal (Store style) ----
    periodBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.60)",
      alignItems: "center",
      justifyContent: "center",
      padding: 18,
    },
    periodModalWrap: {
      width: "100%",
      maxWidth: 420,
    },
    periodCard: {
      backgroundColor: THEME.card,
      borderRadius: 22,
      padding: 18,
      borderWidth: 1,
      borderColor: THEME.border,
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 10 },
      elevation: 10,
    },
    periodTitle: {
      fontFamily: "Barlow_700Bold",
      fontSize: 16,
      color: THEME.text,
      textAlign: "center",
      paddingHorizontal: 36,
    },
    periodClose: {
      position: "absolute",
      top: 8,
      right: 8,
      padding: 10,
    },
    periodDivider: {
      height: 1,
      backgroundColor: THEME.border,
      opacity: 0.7,
      marginTop: 14,
      marginBottom: 14,
    },
    periodBtn: { borderRadius: 999, paddingVertical: 12, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", backgroundColor: "transparent", borderWidth: 1.5, borderColor: THEME.teal, marginBottom: 12 },
    periodBtnPressed: { backgroundColor: THEME.teal },
    periodBtnActive: { },

    periodBtnText: {
      fontFamily: "Barlow_600SemiBold",
      fontSize: 15,
      color: THEME.text,
      textAlign: "center",
    },
    periodBtnTextActive: {
      color: "#FFFFFF",
    },

  });
}
