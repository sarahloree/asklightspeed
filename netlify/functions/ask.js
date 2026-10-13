// =====================================================================
// STFS "Ask the data" — Netlify serverless backend
// Path: netlify/functions/ask.js
//
// Holds both secrets server-side (never sent to the browser):
//   ANTHROPIC_API_KEY   from console.anthropic.com
//   SUPABASE_URL        https://zhgfzpztvmazueuxkipm.supabase.co
//   SUPABASE_SERVICE_KEY  the STFS service-role key (Settings > API)
//
// Set all three in Netlify: Site settings > Environment variables.
//
// Flow: browser question -> Claude picks a tool -> we run the matching
// Supabase RPC -> Claude phrases the answer -> back to the browser.
// Claude never sees the DB keys and never writes SQL; it can only call
// the eight fixed tools below.
// =====================================================================

const MODEL = "claude-sonnet-4-6";

// ---- sign-in check (STFD Supabase Auth, project qdfwovnhlaaocgawukto) ----
// Env: STFD_SUPABASE_URL, STFD_SUPABASE_ANON_KEY (publishable key),
//      ASK_ALLOWED_EMAILS (optional, comma-separated rollout fallback).
// Access = app_metadata.apps includes "asklightspeed" OR email in ASK_ALLOWED_EMAILS.
async function verifyUser(event) {
  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || "");
  if (!m) return { status: 401 };
  const base = process.env.STFD_SUPABASE_URL, key = process.env.STFD_SUPABASE_ANON_KEY;
  if (!base || !key) { console.error("ask: STFD auth env vars missing"); return { status: 500 }; }
  let r;
  try {
    r = await fetch(`${base}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${m[1]}` } });
  } catch (e) { console.error("ask: auth lookup failed", e); return { status: 502 }; }
  if (!r.ok) return { status: 401 };
  const user = await r.json();
  const email = String(user.email || "").toLowerCase();
  const apps = (user.app_metadata && user.app_metadata.apps) || [];
  const allow = (process.env.ASK_ALLOWED_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  const ok = (Array.isArray(apps) && apps.includes("asklightspeed")) || (email && allow.includes(email));
  if (!ok) return { status: 403, email };
  return { status: 200, user: { id: user.id, email, role: (user.app_metadata || {}).app_role || "" } };
}

// Light per-user limit: 20 questions per 5 minutes per warm function instance.
// Not a hard guarantee (instances don't share memory), but it stops runaway loops.
const HITS = new Map();
function rateLimited(uid) {
  const now = Date.now(), win = 5 * 60 * 1000;
  const h = (HITS.get(uid) || []).filter(t => now - t < win);
  if (h.length >= 20) return true;
  h.push(now); HITS.set(uid, h); return false;
}

const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const MAX_TURNS = 5;

// ---- tool catalog: mirrors the eight SQL functions exactly ----------
const TOOLS = [
  { name: "stock_on_hand",
    description: "Current stock on hand, cost and price for a product. Use for questions like 'how much X do we have', 'are we out of Y'. Pass a SKU or part of a product name.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "SKU or product name fragment, e.g. '8 foot HDG post' or '13604'" } }, required: ["query"] },
    rpc: "ask_stock_on_hand", args: b => ({ p_query: b.query }) },

  { name: "reorder_list",
    description: "Products that are below their reorder minimum and should be ordered. Optionally filter to one supplier. Use for 'what should we order', 'what's low', 'what do we need from <supplier>'.",
    input_schema: { type: "object", properties: { supplier: { type: "string", description: "optional supplier name fragment" } } },
    rpc: "ask_reorder_list", args: b => ({ p_supplier: b.supplier || null }) },

  { name: "restock_cost",
    description: "Summary of what a full restock would cost right now: how many products and total dollars, split into actionable vs review. Use for 'what would restocking cost', 'how much to reorder everything'.",
    input_schema: { type: "object", properties: {} },
    rpc: "ask_restock_cost", args: () => ({}) },

  { name: "dead_stock",
    description: "Inventory that is not selling and the cash tied up in it. Use for 'what isn't moving', 'what dead stock do we have', 'money sitting on the shelf'.",
    input_schema: { type: "object", properties: {} },
    rpc: "ask_dead_stock", args: () => ({}) },

  { name: "unreliable_counts",
    description: "Products with negative on-hand, meaning the stock count cannot be trusted (sold without a recorded receipt). Use for 'which counts are wrong', 'what needs a recount', 'negative stock'.",
    input_schema: { type: "object", properties: {} },
    rpc: "ask_unreliable_counts", args: () => ({}) },

  { name: "top_sales",
    description: "Top customers or top products by sales over a number of months. Use for 'top customers', 'best selling products', 'what makes us the most money'. by = 'customer' or 'product'.",
    input_schema: { type: "object", properties: {
      by: { type: "string", enum: ["customer", "product"] },
      months: { type: "integer", description: "lookback window in months, default 12" } } },
    rpc: "ask_top_sales", args: b => ({ p_by: b.by || "product", p_months: b.months || 12 }) },

  { name: "stfd_purchases",
    description: "What South Texas Fence & Deck (STFD) bought from the supply store over a period, with margin. Use for 'what did STFD buy', 'our margin on STFD', 'STFD sales last month'. months default 1.",
    input_schema: { type: "object", properties: { months: { type: "integer", description: "period length in months, default 1" } } },
    rpc: "ask_stfd_purchases", args: b => ({ p_months: b.months || 1 }) },

  { name: "sales_trend",
    description: "Total sales for a recent period compared with the period before it. Use for 'how were sales last month', 'sales vs last month', 'are we up or down'. months default 1.",
    input_schema: { type: "object", properties: { months: { type: "integer", description: "period length in months, default 1" } } },
    rpc: "ask_sales_trend", args: b => ({ p_months: b.months || 1 }) },

  { name: "inventory_value",
    description: "Total dollar value of stock on hand, at cost and at retail. Use for 'what's our inventory worth', 'total inventory value', 'how much stock do we have in dollars', 'banking' questions about stock value.",
    input_schema: { type: "object", properties: {} },
    rpc: "ask_inventory_value", args: () => ({}) },

  { name: "supplier_spend",
    description: "How much has been spent with a supplier over a period, from received orders. Use for 'how much have we spent with Binford this year', 'which suppliers do we spend most with', rebate-tracking questions. Pass a supplier name and optional months (default 12).",
    input_schema: { type: "object", properties: { supplier: { type: "string" }, months: { type: "integer" } } },
    rpc: "ask_supplier_spend", args: b => ({ p_supplier: b.supplier || null, p_months: b.months || 12 }) },

  { name: "inventory_turn",
    description: "For a product: how many sold in a recent period vs how many are on hand, and days of supply. Use for 'have we sold any of these T-posts lately', 'how fast is X moving', 'is this a clearance candidate', inventory-turn questions. Pass a SKU or name and optional months (default 3).",
    input_schema: { type: "object", properties: { query: { type: "string" }, months: { type: "integer" } }, required: ["query"] },
    rpc: "ask_inventory_turn", args: b => ({ p_query: b.query, p_months: b.months || 3 }) },

  { name: "customer_credit",
    description: "Customer store credit, account balances, or outstanding AR. Use for any question about how much credit a customer or STFD has, balances owed, or amounts on account. This data is not yet connected; the tool returns an honest explanation.",
    input_schema: { type: "object", properties: { query: { type: "string" } } },
    rpc: "ask_customer_credit", args: b => ({ p_query: b.query || null }) },
];

const SYSTEM = `You are the assistant for South Texas Fence Supply (STFS). You answer questions about the store's Lightspeed inventory and sales data by calling the provided tools. Rules:

- Only answer from tool results. Never invent numbers. If no tool fits the question, say plainly that you can't answer that one yet and name what you CAN help with (stock levels, reorder needs, restock cost, dead stock, unreliable counts, top customers or products, STFD purchases, sales trends).
- Keep answers short and concrete. Lead with the number, then a sentence of context. Format money as US dollars.
- The data is still being tuned: some supplier lead times are estimates and about a hundred products have unreliable counts. When a tool result carries a caveat, pass it on honestly rather than hiding it.
- Never mention SQL, tables, tools, or how you got the answer. Just answer like a knowledgeable colleague.
- Today's date is ${new Date().toISOString().slice(0,10)}.`;

async function rpc(name, args) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args || {}),
  });
  if (!r.ok) return { error: `data lookup failed (${r.status})` };
  return r.json();
}

async function callClaude(messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024, system: SYSTEM,
      tools: TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
      messages,
    }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0,300)}`);
  return r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "POST only" };

  const who = await verifyUser(event);
  if (who.status === 401) return json(401, { error: "Please sign in." });
  if (who.status === 403) return json(403, { error: "Your account doesn't have access to Ask Lightspeed yet. Ask Sarah to add you." });
  if (who.status !== 200) return json(503, { error: "Sign-in check is unavailable right now. Try again shortly." });
  if (rateLimited(who.user.id)) return json(429, { error: "That's a lot of questions at once. Wait a few minutes and try again." });

  let question;
  try { question = JSON.parse(event.body).question; } catch { question = null; }
  if (!question || typeof question !== "string" || question.length > 2000)
    return { statusCode: 400, body: JSON.stringify({ error: "no question" }) };

  const messages = [{ role: "user", content: question }];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const resp = await callClaude(messages);
      messages.push({ role: "assistant", content: resp.content });

      if (resp.stop_reason !== "tool_use") {
        const text = resp.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
        return { statusCode: 200, headers: { "content-type": "application/json" },
                 body: JSON.stringify({ answer: text || "I don't have an answer for that." }) };
      }

      // run every requested tool, feed results back
      const results = [];
      for (const block of resp.content.filter(c => c.type === "tool_use")) {
        const tool = TOOLS.find(t => t.name === block.name);
        const data = tool ? await rpc(tool.rpc, tool.args(block.input || {}))
                          : { error: "unknown tool" };
        results.push({ type: "tool_result", tool_use_id: block.id,
                       content: JSON.stringify(data).slice(0, 12000) });
      }
      messages.push({ role: "user", content: results });
    }
    return { statusCode: 200, headers: { "content-type": "application/json" },
             body: JSON.stringify({ answer: "That took more steps than expected \u2014 try rephrasing." }) };
  } catch (err) {
    console.error("ask: failed for", who.user.email, err);   // details stay in Netlify logs
    return json(500, { error: "Sorry, something went wrong answering that. Please try again." });
  }
};
