const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const { handleRedeem, INVALID, APP_KEY, BUSINESS, DEFAULT_CONSUME_URL } = require("../netlify/functions/hq-redeem.js");

const CODE = "a".repeat(43);
const KEYS = [
  "HQ_STFD_HANDOFF_SECRET",
  "PJCJ_ANON_KEY",
  "HQ_CONSUME_URL",
  "STFD_SUPABASE_URL",
  "STFD_SUPABASE_ANON_KEY",
  "STFD_SUPABASE_SERVICE_ROLE_KEY",
];

function env(extra) {
  const base = {
    HQ_STFD_HANDOFF_SECRET: "handoff-secret-value",
    PJCJ_ANON_KEY: "pjcj-publishable-test\n",
    HQ_CONSUME_URL: "",
    STFD_SUPABASE_URL: "https://qdfwovnhlaaocgawukto.supabase.co/rest/v1/",
    STFD_SUPABASE_ANON_KEY: "sb_publishable_test_key",
    STFD_SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  };
  return Object.assign(base, extra);
}

function deps(fetch, extraEnv, timeoutMs) {
  const values = env(extraEnv);
  return {
    getEnv: (name) => values[name] || "",
    fetch,
    timeoutMs: timeoutMs || 8000,
  };
}

function jsonRes(status, body) {
  return {
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function post(body, extra, fetch, extraEnv) {
  return handleRedeem({
    httpMethod: "POST",
    headers: { origin: "https://asklightspeed.netlify.app" },
    body: body === undefined ? JSON.stringify({ code: CODE }) : body,
    ...extra,
  }, deps(fetch, extraEnv));
}

function userList(users) {
  return jsonRes(200, { users });
}

test("hq redeem and the page handoff", async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const source = fs.readFileSync(path.join(__dirname, "../netlify/functions/hq-redeem.js"), "utf8");
    const ask = fs.readFileSync(path.join(__dirname, "../netlify/functions/ask.js"), "utf8");

    assert.equal(APP_KEY, "stfs_ask");
    assert.equal(BUSINESS, "STFS");
    assert.equal(DEFAULT_CONSUME_URL, "https://inmodrxuivjmypzvygzi.supabase.co/functions/v1/hq-handoff-consume");
    assert.match(html, /signInWithPassword/);
    assert.match(html, /detectSessionInUrl:\s*true/);
    assert.match(html, /params\.get\('handoff'\)/);
    assert.match(html, /history\.replaceState/);
    assert.match(html, /\/\.netlify\/functions\/hq-redeem/);
    assert.match(html, /setSession/);
    assert.match(html, /HANDOFF_CODE && !PASSWORD_SETUP/);
    assert.doesNotMatch(html, /params\.get\('access_token'\)/);
    assert.doesNotMatch(html, /params\.get\('code'\)/);
    assert.doesNotMatch(html, /sb_secret_/);
    assert.doesNotMatch(html, /service_role/);
    assert.doesNotMatch(html, /service-role-secret/);
    assert.ok(html.indexOf("params.get('handoff')") < html.indexOf("window.supabase.createClient"));
    assert.match(ask, /asklightspeed/);
    assert.match(ask, /ASK_ALLOWED_EMAILS/);
    assert.doesNotMatch(source, /sb_secret_/);
    assert.doesNotMatch(source, /service-role-secret/);
    assert.doesNotMatch(source, /handoff-secret-value/);

    const parser = html.slice(html.indexOf("const HANDOFF_CODE"), html.indexOf("let auth"));
    function runHash(hash, search) {
      const location = { hash, pathname: "/", search: search || "" };
      const history = {
        state: { kept: true },
        url: "",
        replaceState(state, _title, url) {
          this.url = url;
          const next = new URL(url, "https://asklightspeed.netlify.app");
          location.pathname = next.pathname;
          location.search = next.search;
          location.hash = next.hash;
        },
      };
      const sandbox = { location, history, URLSearchParams };
      vm.runInContext(
        parser + "\nthis.result = { code: HANDOFF_CODE, setup: PASSWORD_SETUP };",
        vm.createContext(sandbox)
      );
      return { result: sandbox.result, location, url: history.url };
    }

    const kept = runHash("#access_token=abc&type=recovery", "?next=1");
    assert.equal(kept.result.code, "");
    assert.equal(kept.result.setup, true);
    assert.equal(kept.url, "");
    assert.equal(kept.location.hash, "#access_token=abc&type=recovery");

    const only = runHash("#handoff=" + CODE, "?next=1");
    assert.equal(only.result.code, CODE);
    assert.equal(only.result.setup, false);
    assert.equal(only.url, "/?next=1");
    assert.equal(only.location.hash, "");
    assert.doesNotMatch(only.url, /handoff/);

    const both = runHash("#handoff=" + CODE + "&type=recovery");
    assert.equal(both.result.code, CODE);
    assert.equal(both.result.setup, true);
    assert.match(both.location.hash, /type=recovery/);
    assert.doesNotMatch(both.location.hash, /handoff/);

    const bad = runHash("#handoff=too-short");
    assert.equal(bad.result.code, "");
    assert.equal(bad.location.hash, "");

    const query = runHash("", "?code=" + CODE + "&handoff=" + CODE);
    assert.equal(query.result.code, "");
    assert.equal(query.location.search, "?code=" + CODE + "&handoff=" + CODE);

    let calls = [];
    const noFetch = async () => { calls.push("fetch"); return jsonRes(500, {}); };

    let res = await post(JSON.stringify({ code: "short" }), {}, noFetch);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, INVALID);
    assert.equal(calls.length, 0);
    assert.equal(res.headers["cache-control"], "no-store");

    res = await post(JSON.stringify({ code: CODE + "a" }), {}, noFetch);
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    res = await handleRedeem({ httpMethod: "GET", headers: {}, body: JSON.stringify({ code: CODE }) }, deps(noFetch));
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    res = await post(undefined, {}, noFetch, { HQ_STFD_HANDOFF_SECRET: "" });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    res = await post(undefined, {}, noFetch, { STFD_SUPABASE_URL: "http://qdfwovnhlaaocgawukto.supabase.co" });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    res = await post(undefined, {}, noFetch, { STFD_SUPABASE_URL: "https://user:pass@qdfwovnhlaaocgawukto.supabase.co" });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    res = await post(undefined, {}, noFetch, { STFD_SUPABASE_URL: "https://evil.supabase.co" });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    res = await post(undefined, {}, noFetch, {
      HQ_CONSUME_URL: "https://evil.example/functions/v1/hq-handoff-consume",
    });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    res = await post(undefined, {}, noFetch, {
      HQ_CONSUME_URL: "https://inmodrxuivjmypzvygzi.supabase.co/functions/v1/other",
    });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    res = await handleRedeem({
      httpMethod: "OPTIONS",
      headers: { Origin: "https://deploy-preview-3--asklightspeed.netlify.app" },
      body: "",
    }, deps(noFetch));
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["access-control-allow-origin"], "https://deploy-preview-3--asklightspeed.netlify.app");
    assert.equal(calls.length, 0);

    calls = [];
    globalThis.__calls = calls;
    res = await post(JSON.stringify({ code: CODE, business: "STFD", app_key: "stfd_dashboard" }), {}, async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonRes(401, { error: "no" });
    });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, DEFAULT_CONSUME_URL);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers["x-handoff-secret"], "handoff-secret-value");
    assert.equal(calls[0].init.headers.apikey, "pjcj-publishable-test");
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(calls[0].init.body, JSON.stringify({ code: CODE, business: "STFS" }));
    assert.doesNotMatch(JSON.stringify(calls[0].init.headers), /service-role-secret/);
    assert.doesNotMatch(res.body, new RegExp(CODE));

    async function routed(handler) {
      calls = [];
      return post(undefined, {}, async (url, init) => {
        calls.push({ url: String(url), init });
        return handler(String(url), init, calls);
      });
    }

    res = await routed(() => jsonRes(200, { email: "person@example.com", app_key: "stfs_reorder" }));
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 1);

    res = await routed(() => jsonRes(200, { email: "not-an-email", app_key: "stfs_ask" }));
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 1);

    res = await routed((url) => {
      if (url.includes("hq-handoff-consume")) return jsonRes(200, { email: "missing@example.com", app_key: "stfs_ask" });
      if (url.includes("/admin/users")) return userList([{ id: "other", email: "someone@example.com" }]);
      throw new Error("should not mint " + url);
    });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\/auth\/v1\/admin\/users\?/);
    assert.equal(calls[1].init.method, "GET");
    assert.equal(calls[1].init.headers.Authorization, "Bearer service-role-secret");

    const page = Array.from({ length: 200 }, (_, i) => ({ id: "id-" + i, email: "user" + i + "@example.com" }));
    calls = [];
    const fetchOk = async (url, init) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes("hq-handoff-consume")) {
        return jsonRes(200, { email: "Person@Example.com", app_key: "stfs_ask", business: "STFD" });
      }
      if (u.includes("/admin/users")) {
        const pageNo = new URL(u).searchParams.get("page");
        if (pageNo === "1") return userList(page);
        if (pageNo === "2") return userList([{ id: "user-1", email: "person@example.com" }]);
        throw new Error("page " + pageNo);
      }
      if (u.includes("/admin/generate_link")) {
        return jsonRes(200, {
          hashed_token: "hashed-token-value",
          action_link: "https://qdfwovnhlaaocgawukto.supabase.co/auth/v1/verify?token=raw-should-not-leak",
          email_otp: "999111",
          email: "person@example.com",
        });
      }
      if (u.endsWith("/auth/v1/verify")) {
        return jsonRes(200, {
          access_token: "minted-access-token",
          refresh_token: "minted-refresh-token",
          expires_at: 1800000000,
          user: {
            id: "user-1",
            email: "PERSON@example.com",
            app_metadata: { apps: ["asklightspeed"], app_role: "staff" },
            user_metadata: { forged: "should-not-copy" },
          },
        });
      }
      throw new Error("unexpected " + u);
    };
    res = await post(Buffer.from(JSON.stringify({ code: CODE })).toString("base64"), {
      isBase64Encoded: true,
      headers: {},
      multiValueHeaders: { origin: ["https://asklightspeed.netlify.app"] },
    }, fetchOk);
    assert.equal(res.statusCode, 200);
    const minted = JSON.parse(res.body);
    assert.equal(minted.access_token, "minted-access-token");
    assert.equal(minted.refresh_token, "minted-refresh-token");
    assert.equal(minted.expires_at, 1800000000);
    assert.equal(minted.user.id, "user-1");
    assert.equal(minted.user.email, "PERSON@example.com");
    assert.deepEqual(minted.user.app_metadata.apps, ["asklightspeed"]);
    assert.equal(minted.user.user_metadata, undefined);
    assert.equal(res.headers["access-control-allow-origin"], "https://asklightspeed.netlify.app");
    assert.doesNotMatch(res.body, /raw-should-not-leak|999111|hashed-token-value|service-role-secret|handoff-secret-value|should-not-copy/);
    const consume = calls.find(c => c.url.includes("hq-handoff-consume"));
    const link = calls.find(c => c.url.includes("generate_link"));
    const verify = calls.find(c => c.url.endsWith("/auth/v1/verify"));
    assert.equal(JSON.parse(link.init.body).type, "magiclink");
    assert.equal(JSON.parse(link.init.body).email, "person@example.com");
    assert.equal(JSON.parse(link.init.body).password, undefined);
    assert.equal(JSON.parse(link.init.body).data, undefined);
    assert.equal(link.init.headers.Authorization, "Bearer service-role-secret");
    assert.deepEqual(JSON.parse(verify.init.body), { type: "magiclink", token_hash: "hashed-token-value" });
    assert.equal(verify.init.headers.apikey, "sb_publishable_test_key");
    assert.equal(verify.init.headers.Authorization, undefined);
    assert.doesNotMatch(JSON.stringify(verify.init), /service-role-secret/);
    assert.doesNotMatch(JSON.stringify(consume.init), /service-role-secret/);
    assert.ok(calls.findIndex(c => c.url.includes("consume")) < calls.findIndex(c => c.url.includes("/admin/users")));
    assert.ok(calls.some(c => c.url.includes("page=2")));
    assert.equal(calls.filter(c => c.url.includes("page=3")).length, 0);
    assert.equal(calls.filter(c => c.init.method === "POST" && c.url.includes("/admin/users")).length, 0);

    res = await post(undefined, { headers: { origin: "https://evil.example" } }, async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("hq-handoff-consume")) return jsonRes(200, { email: "person@example.com", app_key: "stfd_dashboard" });
      throw new Error("no");
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["access-control-allow-origin"], undefined);

    res = await post(undefined, {}, async (url) => {
      if (String(url).includes("hq-handoff-consume")) {
        return jsonRes(200, { email: "person@example.com", app_key: "stfs_ask" });
      }
      if (String(url).includes("/admin/users")) return userList([{ id: "user-1", email: "person@example.com" }]);
      if (String(url).includes("generate_link")) return jsonRes(200, { properties: { hashed_token: "nested-hash" } });
      if (String(url).endsWith("/auth/v1/verify")) {
        return jsonRes(200, {
          access_token: "other-access",
          refresh_token: "other-refresh",
          user: { id: "user-2", email: "person@example.com" },
        });
      }
      throw new Error(String(url));
    });
    assert.equal(res.statusCode, 401);
    assert.doesNotMatch(res.body, /other-access/);

    res = await post(undefined, {}, async () => { throw Object.assign(new Error("abort"), { name: "AbortError" }); }, {});
    assert.equal(res.statusCode, 401);

    let aborted = false;
    res = await handleRedeem({
      httpMethod: "POST",
      headers: { origin: "http://localhost:8888" },
      body: JSON.stringify({ code: CODE }),
    }, deps((url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }), {}, 30));
    assert.equal(res.statusCode, 401);
    assert.equal(aborted, true);
    assert.equal(res.headers["access-control-allow-origin"], "http://localhost:8888");

    res = await post("x".repeat(2001), {}, noFetch);
    assert.equal(res.statusCode, 401);
  } finally {
    console.error = origError;
  }
});
