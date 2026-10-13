const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { handler } = require("../netlify/functions/ask.js");

const TOK = "eyJhbGci.eyJzdWIi.signature";
const KEYS = [
  "STFD_SUPABASE_URL",
  "STFD_SUPABASE_ANON_KEY",
  "ASK_ALLOWED_EMAILS",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "ANTHROPIC_API_KEY",
];

function setEnv(extra) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, extra);
}

function configured(extra = {}) {
  setEnv({
    STFD_SUPABASE_URL: "https://qdfwovnhlaaocgawukto.supabase.co/",
    STFD_SUPABASE_ANON_KEY: "sb_publishable_test_key\n",
    ASK_ALLOWED_EMAILS: "",
    SUPABASE_URL: "https://stfs.example.test",
    SUPABASE_SERVICE_KEY: "service-role-secret",
    ANTHROPIC_API_KEY: "sk-ant-test",
    ...extra,
  });
}

function user(over = {}) {
  return {
    id: Object.prototype.hasOwnProperty.call(over, "id") ? over.id : "11111111-1111-1111-1111-111111111111",
    email: over.email === undefined ? "person@example.com" : over.email,
    app_metadata: over.app_metadata === undefined
      ? { apps: ["asklightspeed"], app_role: "staff" }
      : over.app_metadata,
  };
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function post(headers, body, extra = {}) {
  return handler({
    httpMethod: "POST",
    headers: headers || {},
    body: body === undefined ? JSON.stringify({ question: "how much post?" }) : body,
    ...extra,
  });
}

test("ask sign-in gate", async () => {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const origFetch = global.fetch;
  const origError = console.error;
  console.error = () => {};
  try {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const source = fs.readFileSync(path.join(__dirname, "../netlify/functions/ask.js"), "utf8");
    assert.match(html, /sb_publishable_/);
    assert.doesNotMatch(html, /sb_secret_/);
    assert.doesNotMatch(html, /service_role/);
    assert.match(html, /class="signin-msg"/);
    assert.doesNotMatch(source, /sb_secret_/);
    assert.doesNotMatch(source, /sb_publishable_[A-Za-z0-9_-]+/);

    // Missing configuration is 503 for every POST, with or without a token.
    setEnv({});
    let calls = [];
    global.fetch = async () => { calls.push("fetch"); return jsonRes(500, {}); };
    let res = await post({}, JSON.stringify({ question: "hi" }));
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);
    assert.match(JSON.parse(res.body).error, /unavailable/i);
    assert.equal(res.headers["cache-control"], "no-store");
    res = await post({ authorization: `Bearer ${TOK}` }, JSON.stringify({ question: "hi" }));
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);

    configured({ STFD_SUPABASE_URL: "http://qdfwovnhlaaocgawukto.supabase.co" });
    res = await post({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);

    configured({ STFD_SUPABASE_URL: "https://user:pass@qdfwovnhlaaocgawukto.supabase.co" });
    res = await post({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);

    configured({ STFD_SUPABASE_URL: "not a url" });
    res = await post({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);

    // No token, or a token we will not forward, is 401 and does not call Auth.
    configured();
    calls = [];
    res = await post({});
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, "Please sign in.");
    assert.equal(calls.length, 0);

    res = await post({ authorization: "Bearer not-a-jwt" });
    assert.equal(res.statusCode, 401);
    res = await post({ authorization: `Bearer ${TOK}\r\nX-Evil: 1` });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    // Auth rejects the token. A forged apps flag in the body does not help.
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonRes(401, { message: `bad ${TOK}` });
    };
    res = await post(
      { Authorization: `bearer ${TOK}` },
      JSON.stringify({ question: "hi", app_metadata: { apps: ["asklightspeed"] } })
    );
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://qdfwovnhlaaocgawukto.supabase.co/auth/v1/user");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers.apikey, "sb_publishable_test_key");
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOK}`);
    assert.doesNotMatch(JSON.stringify(calls[0].init), /service-role-secret/);
    assert.doesNotMatch(res.body, new RegExp(TOK));

    // Auth outage is 503, not a false "please sign in".
    for (const status of [302, 500, 503]) {
      calls = [];
      global.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonRes(status, { message: "down" });
      };
      res = await post({ authorization: `Bearer ${TOK}` });
      assert.equal(res.statusCode, 503, `auth status ${status}`);
    }
    global.fetch = async () => { throw Object.assign(new Error("socket hang up"), { name: "TypeError" }); };
    res = await post({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);
    global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error("nope"); }, text: async () => "<html>" });
    res = await post({ authorization: `Bearer ${TOK}` });
    assert.equal(res.statusCode, 503);

    // Header may arrive only as a multi-value header.
    calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonRes(200, user({ id: "multi-user", app_metadata: {} }));
    };
    res = await post({}, "{", { headers: {}, multiValueHeaders: { Authorization: [`Bearer ${TOK}`] } });
    assert.equal(res.statusCode, 403);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(res.body, /person@example.com/);

    async function asUser(u, body) {
      calls = [];
      global.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/auth/v1/user")) return jsonRes(200, u);
        throw new Error("Claude API 500: sk-ant-secret-should-not-leak");
      };
      return post({ authorization: `Bearer ${TOK}` }, body);
    }

    configured();
    res = await asUser(user({ app_metadata: { apps: ["other", " asklightspeed "] } }), "{");
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "no question");
    assert.equal(calls.length, 1);

    res = await asUser(user({ app_metadata: { apps: "AskLightspeed" } }), "not-json");
    assert.equal(res.statusCode, 400);

    res = await asUser(user({ app_metadata: { apps: "stfd, asklightspeed" } }), "not-json");
    assert.equal(res.statusCode, 400);

    res = await asUser(user({ app_metadata: { apps: ["asklightspeed-admin"] }, email: "nope@example.com" }), "not-json");
    assert.equal(res.statusCode, 403);

    res = await asUser(user({ id: "", app_metadata: { apps: ["asklightspeed"] } }), "not-json");
    assert.equal(res.statusCode, 401);

    configured({ ASK_ALLOWED_EMAILS: " Taylor@SouthTexasFAD.com \n phillip@southtexasfad.com; yvonne@southtexasfad.com " });
    res = await asUser(user({ email: "taylor@southtexasfad.com", app_metadata: {} }), "not-json");
    assert.equal(res.statusCode, 400);
    res = await asUser(user({ email: "PHILLIP@southtexasfad.com", app_metadata: { apps: [] } }), "not-json");
    assert.equal(res.statusCode, 400);
    res = await asUser(user({ email: "aylor@southtexasfad.com", app_metadata: {} }), "not-json");
    assert.equal(res.statusCode, 403);
    res = await asUser(user({ email: "", app_metadata: {} }), "not-json");
    assert.equal(res.statusCode, 403);

    configured({ ASK_ALLOWED_EMAILS: "*" });
    res = await asUser(user({ email: "a@b.com", app_metadata: {} }), "not-json");
    assert.equal(res.statusCode, 403);

    configured();
    res = await asUser(user({ id: "long-user" }), JSON.stringify({ question: "x".repeat(2001) }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "That question is too long.");
    assert.equal(calls.length, 1);

    // Allowed user, model error stays in the logs. The client gets a fixed sentence.
    res = await asUser(user({ id: "err-user" }), JSON.stringify({ question: "stock?" }));
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).error, "Sorry, something went wrong answering that. Please try again.");
    assert.doesNotMatch(res.body, /sk-ant-secret/);
    assert.doesNotMatch(res.body, /service-role/);

    // Happy path: user JWT is sent only to STFD Auth, never to Claude or the data API.
    calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes("/auth/v1/user")) return jsonRes(200, user({ id: "happy-user" }));
      if (u.includes("api.anthropic.com")) {
        const n = calls.filter(c => String(c.url).includes("anthropic")).length;
        if (n === 1) {
          return jsonRes(200, {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "tool-1", name: "inventory_value", input: {} }],
          });
        }
        return jsonRes(200, { stop_reason: "end_turn", content: [{ type: "text", text: "About $10." }] });
      }
      if (u.includes("/rest/v1/rpc/ask_inventory_value")) return jsonRes(200, { total: 10 });
      throw new Error("unexpected " + u);
    };
    res = await post({ authorization: `Bearer ${TOK}` }, JSON.stringify({ question: "  inventory worth?  " }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).answer, "About $10.");
    const authCall = calls.find(c => c.url.includes("/auth/v1/user"));
    const claudeCall = calls.find(c => c.url.includes("anthropic"));
    const rpcCall = calls.find(c => c.url.includes("/rest/v1/rpc/"));
    assert.equal(authCall.init.headers.Authorization, `Bearer ${TOK}`);
    assert.doesNotMatch(JSON.stringify(claudeCall.init.headers), new RegExp(TOK));
    assert.equal(rpcCall.init.headers.Authorization, "Bearer service-role-secret");
    assert.doesNotMatch(JSON.stringify(rpcCall.init.headers), new RegExp(TOK));

    // 20 questions per 5 minutes, then 429, and a different user is unaffected.
    calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("/auth/v1/user")) return jsonRes(200, user({ id: "rate-user" }));
      throw new Error("should not call Claude once rate limited or for a bad body");
    };
    for (let i = 0; i < 20; i++) {
      res = await post({ authorization: `Bearer ${TOK}` }, "{");
      assert.equal(res.statusCode, 400, `request ${i}`);
    }
    res = await post({ authorization: `Bearer ${TOK}` }, JSON.stringify({ question: "again" }));
    assert.equal(res.statusCode, 429);
    assert.match(JSON.parse(res.body).error, /few minutes/i);
    global.fetch = async (url) => {
      if (String(url).includes("/auth/v1/user")) return jsonRes(200, user({ id: "other-user" }));
      throw new Error("no claude");
    };
    res = await post({ authorization: `Bearer ${TOK}` }, "{");
    assert.equal(res.statusCode, 400);

    res = await handler({ httpMethod: "GET", headers: { authorization: `Bearer ${TOK}` }, body: "{}" });
    assert.equal(res.statusCode, 405);
  } finally {
    console.error = origError;
    global.fetch = origFetch;
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
