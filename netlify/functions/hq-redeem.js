// =====================================================================
// Johns Enterprises HQ → Ask Lightspeed handoff redeem.
// Path: netlify/functions/hq-redeem.js
//
// The browser reads #handoff=CODE (never ?code or #access_token, so this
// does not collide with supabase-js detectSessionInUrl), strips it, and
// posts {code} here. This function asks PJCJ hq-handoff-consume whether
// the code is live, then mints a session on the STFD Auth project
// (qdfwovnhlaaocgawukto) for an email that already has an account.
//
// It does not create users, send email, or grant Ask access. ask.js still
// requires app_metadata.apps to contain "asklightspeed", or the email to
// be in ASK_ALLOWED_EMAILS.
//
// Env (Netlify → Site settings → Environment variables):
//   HQ_HANDOFF_SECRET               sent as the x-handoff-secret header
//   PJCJ_ANON_KEY                   PJCJ publishable key, sent as apikey
//   HQ_CONSUME_URL                  optional; defaults to the PJCJ consume function
//   STFD_SUPABASE_URL               https://qdfwovnhlaaocgawukto.supabase.co
//   STFD_SUPABASE_ANON_KEY          STFD publishable key (verify only)
//   STFD_SUPABASE_SERVICE_ROLE_KEY  STFD service-role key (admin lookup + link)
//
// SUPABASE_URL / SUPABASE_SERVICE_KEY are the STFS data project. They are
// not used here. Every failure is the same 401.
// =====================================================================

const INVALID = "Invalid or expired.";
const DEFAULT_CONSUME_URL =
  "https://inmodrxuivjmypzvygzi.supabase.co/functions/v1/hq-handoff-consume";
const CONSUME_HOST = "inmodrxuivjmypzvygzi.supabase.co";
const CONSUME_PATH = "/functions/v1/hq-handoff-consume";
const STFD_HOST = "qdfwovnhlaaocgawukto.supabase.co";
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const APP_KEY = "stfs_ask";
const BUSINESS = "STFS";
const MAX_BODY = 2000;
const MAX_EMAIL = 320;
const USER_PAGE = 200;
const USER_PAGES = 25;

function isHandoffCode(code) {
  return typeof code === "string" && CODE_RE.test(code);
}

function normalizeEmail(email) {
  return String(email == null ? "" : email).trim().toLowerCase();
}

function header(event, name) {
  const want = name.toLowerCase();
  const bags = [event && event.headers, event && event.multiValueHeaders];
  for (const bag of bags) {
    if (!bag || typeof bag !== "object") continue;
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() !== want) continue;
      const value = Array.isArray(bag[key]) ? bag[key][0] : bag[key];
      if (value) return String(value).trim();
    }
  }
  return "";
}

function allowedOrigin(origin) {
  if (!origin || typeof origin !== "string") return "";
  let url;
  try { url = new URL(origin); }
  catch { return ""; }
  if (url.username || url.password || url.search || url.hash) return "";
  if (url.pathname !== "/" && url.pathname !== "") return "";
  const host = url.hostname;
  if (url.protocol === "https:" && !url.port &&
      (host === "asklightspeed.netlify.app" || host.endsWith("--asklightspeed.netlify.app"))) {
    return origin;
  }
  if (url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) {
    return origin;
  }
  return "";
}

function resolveConsumeUrl(raw) {
  const value = String(raw == null ? "" : raw).trim() || DEFAULT_CONSUME_URL;
  let url;
  try { url = new URL(value); }
  catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
  if (url.hostname !== CONSUME_HOST) return "";
  const path = url.pathname.replace(/\/$/, "");
  if (path !== CONSUME_PATH) return "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function stfdOrigin(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value) return "";
  let url;
  try { url = new URL(value); }
  catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
  if (url.hostname !== STFD_HOST) return "";
  return url.origin;
}

function stfdAuthUrl(origin, pathname, query) {
  const url = new URL(pathname, origin);
  if (query) {
    for (const key of Object.keys(query)) url.searchParams.set(key, query[key]);
  }
  return url.toString();
}

function corsHeaders(origin) {
  const headers = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "cache-control": "no-store",
    vary: "Origin",
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  return headers;
}

function json(statusCode, body, origin) {
  return {
    statusCode,
    headers: Object.assign({ "content-type": "application/json" }, corsHeaders(origin)),
    body: JSON.stringify(body),
  };
}

function invalid(origin) {
  return json(401, { error: INVALID }, origin);
}

function readBody(event) {
  if (!event || typeof event.body !== "string") return null;
  let text = event.body;
  if (event.isBase64Encoded) {
    try { text = Buffer.from(text, "base64").toString("utf8"); }
    catch { return null; }
  }
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

async function fetchJson(deps, url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await deps.fetch(url, Object.assign({}, init, {
      redirect: "manual",
      signal: ctrl.signal,
    }));
    if (!res || res.status < 200 || res.status >= 300) return null;
    try { return await res.json(); }
    catch { return null; }
  } finally {
    clearTimeout(timer);
  }
}

// listUsers is not an exact lookup. Compare the lowered email ourselves.
async function findUserByEmail(deps, origin, serviceKey, email, timeoutMs) {
  const want = normalizeEmail(email);
  if (!want) return null;
  for (let page = 1; page <= USER_PAGES; page++) {
    const body = await fetchJson(deps, stfdAuthUrl(origin, "/auth/v1/admin/users", {
      page: String(page),
      per_page: String(USER_PAGE),
    }), {
      method: "GET",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
    }, timeoutMs);
    if (!body || !Array.isArray(body.users)) return null;
    for (const user of body.users) {
      if (!user || typeof user.id !== "string" || !user.id.trim()) continue;
      if (normalizeEmail(user.email) === want) return user;
    }
    if (body.users.length < USER_PAGE) return null;
  }
  return null;
}

// generate_link does not send mail and is only called for an existing user.
async function generateMagicLink(deps, origin, serviceKey, email, timeoutMs) {
  const body = await fetchJson(deps, stfdAuthUrl(origin, "/auth/v1/admin/generate_link"), {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", email }),
  }, timeoutMs);
  if (!body || typeof body !== "object") return null;
  const top = typeof body.hashed_token === "string" ? body.hashed_token : "";
  const nested = body.properties && typeof body.properties.hashed_token === "string"
    ? body.properties.hashed_token
    : "";
  if (top && nested && top !== nested) return null;
  const hashed = top || nested;
  if (!hashed) return null;
  return { hashed_token: hashed };
}

async function verifyOtp(deps, origin, anonKey, tokenHash, timeoutMs) {
  const body = await fetchJson(deps, stfdAuthUrl(origin, "/auth/v1/verify"), {
    method: "POST",
    headers: {
      apikey: anonKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
  }, timeoutMs);
  if (!body || typeof body !== "object") return null;
  return body;
}

function publicSession(session) {
  const user = session.user || {};
  const meta = user.app_metadata;
  let expires = null;
  if (Number.isFinite(session.expires_at)) expires = session.expires_at;
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: expires,
    user: {
      id: user.id,
      email: user.email,
      app_metadata: meta && typeof meta === "object" ? meta : {},
    },
  };
}

async function handleRedeem(event, deps) {
  const origin = allowedOrigin(header(event, "origin"));
  const method = event && event.httpMethod;
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }
  try {
    if (method !== "POST") return invalid(origin);
    const body = readBody(event);
    const code = body && body.code;
    if (!isHandoffCode(code)) return invalid(origin);

    const secret = String(deps.getEnv("HQ_HANDOFF_SECRET") || "").trim();
    const pjcjAnon = String(deps.getEnv("PJCJ_ANON_KEY") || "").trim();
    const anonKey = String(deps.getEnv("STFD_SUPABASE_ANON_KEY") || "").trim();
    const serviceKey = String(deps.getEnv("STFD_SUPABASE_SERVICE_ROLE_KEY") || "").trim();
    const consumeUrl = resolveConsumeUrl(deps.getEnv("HQ_CONSUME_URL"));
    const stfd = stfdOrigin(deps.getEnv("STFD_SUPABASE_URL"));
    if (!secret || !pjcjAnon || !anonKey || !serviceKey || !consumeUrl || !stfd) {
      console.error("hq-redeem", "config");
      return invalid(origin);
    }

    const timeoutMs = deps.timeoutMs || 8000;
    let consumed;
    try {
      consumed = await fetchJson(deps, consumeUrl, {
        method: "POST",
        headers: {
          apikey: pjcjAnon,
          "x-handoff-secret": secret,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code, business: BUSINESS }),
      }, timeoutMs);
    } catch {
      console.error("hq-redeem", "consume");
      return invalid(origin);
    }
    if (!consumed || consumed.app_key !== APP_KEY) return invalid(origin);
    const email = normalizeEmail(consumed.email);
    if (!email || email.length > MAX_EMAIL || email.indexOf("@") < 1) return invalid(origin);

    const user = await findUserByEmail(deps, stfd, serviceKey, email, timeoutMs);
    if (!user || normalizeEmail(user.email) !== email || !user.id) return invalid(origin);

    const link = await generateMagicLink(deps, stfd, serviceKey, user.email, timeoutMs);
    if (!link || typeof link.hashed_token !== "string" || !link.hashed_token) return invalid(origin);

    const session = await verifyOtp(deps, stfd, anonKey, link.hashed_token, timeoutMs);
    if (!session || typeof session.access_token !== "string" || typeof session.refresh_token !== "string") {
      return invalid(origin);
    }
    if (!session.access_token || !session.refresh_token || !session.user) return invalid(origin);
    if (session.user.id !== user.id) return invalid(origin);
    if (normalizeEmail(session.user.email) !== email) return invalid(origin);
    if (session.access_token === serviceKey || session.refresh_token === serviceKey) return invalid(origin);

    return json(200, publicSession(session), origin);
  } catch {
    console.error("hq-redeem", "failed");
    return invalid(origin);
  }
}

exports.handler = (event) => handleRedeem(event, {
  getEnv: (name) => process.env[name] || "",
  fetch: globalThis.fetch,
  timeoutMs: 8000,
});

exports.handleRedeem = handleRedeem;
exports.INVALID = INVALID;
exports.DEFAULT_CONSUME_URL = DEFAULT_CONSUME_URL;
exports.APP_KEY = APP_KEY;
exports.BUSINESS = BUSINESS;
