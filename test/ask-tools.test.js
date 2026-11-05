const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const ask = fs.readFileSync(path.join(root, "netlify/functions/ask.js"), "utf8");
const jobSql = fs.readFileSync(path.join(root, "sql/ask_by_job_ref.sql"), "utf8");
const stfdSql = fs.readFileSync(path.join(root, "sql/ask_stfd_purchases.sql"), "utf8");
const pastSql = fs.readFileSync(path.join(root, "sql/ask_past_quote_template.sql"), "utf8");
const page = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("ask.js wires job-number and STFD purchase tools", () => {
  assert.match(ask, /name:\s*"by_job_ref"/);
  assert.match(ask, /rpc:\s*"ask_by_job_ref"/);
  assert.match(ask, /what went out for #2309/i);
  assert.match(ask, /open quote for C2219/i);
  assert.match(ask, /S2287/);
  assert.match(ask, /p_job_ref:\s*b\.job_ref/);

  assert.match(ask, /name:\s*"stfd_purchases"/);
  assert.match(ask, /rpc:\s*"ask_stfd_purchases"/);
  assert.match(ask, /p_months:\s*b\.months\s*\|\|\s*1/);
  assert.match(ask, /p_from/);
  assert.match(ask, /p_to/);
  assert.match(ask, /p_sku/);
  assert.match(ask, /p_detail/);
  assert.match(ask, /STFD bought SKU/i);

  assert.match(ask, /job number is not a SKU/i);
  assert.doesNotMatch(ask, /sb_secret_/);
  assert.doesNotMatch(ask, /service_role/);
});

test("past quote template is a draft pick list, locked down like the other ask_* functions", () => {
  assert.match(ask, /name:\s*"past_quote_template"/);
  assert.match(ask, /rpc:\s*"ask_past_quote_template"/);
  assert.match(ask, /p_job_ref:\s*b\.job_ref/);
  assert.match(ask, /p_quote/);
  assert.match(ask, /p_scale_from/);
  assert.match(ask, /p_scale_to/);
  assert.match(ask, /scale_from/);
  assert.match(ask, /scale_to/);
  assert.match(ask, /not the official pull list/i);
  assert.match(ask, /STFD calculator and job packet/);
  assert.match(ask, /150 ft/);
  assert.match(ask, /past-quote template/);
  assert.doesNotMatch(ask, /sb_secret_/);
  assert.doesNotMatch(ask, /service_role/);

  assert.match(pastSql, /function public\.ask_past_quote_template\(/);
  assert.match(pastSql, /p_job_ref text/);
  assert.match(pastSql, /p_quote text default null/);
  assert.match(pastSql, /p_scale_from numeric default null/);
  assert.match(pastSql, /p_scale_to numeric default null/);
  assert.match(pastSql, /ls_quote_lines/);
  assert.match(pastSql, /ls_inventory/);
  assert.match(pastSql, /'qty_template'/);
  assert.match(pastSql, /'qty_scaled'/);
  assert.match(pastSql, /'on_hand'/);
  assert.match(pastSql, /'shortfall'/);
  assert.match(pastSql, /'CREATED'/);
  assert.match(pastSql, /latest quote that is not void/i);
  assert.match(pastSql, /Draft only/);
  assert.match(pastSql, /not the official pull list/);
  assert.match(pastSql, /STFD calculator and job packet/);
  assert.match(pastSql, /stable/i);
  assert.match(pastSql, /security definer/i);
  assert.match(pastSql, /set search_path to 'public', 'pg_temp'/i);
  assert.match(pastSql, /returns jsonb/i);
  assert.match(pastSql, /revoke all on function/i);
  assert.match(pastSql, /from anon/i);
  assert.match(pastSql, /from authenticated/i);
  assert.match(pastSql, /grant execute on function/i);
  assert.match(pastSql, /to service_role/i);
  assert.doesNotMatch(pastSql, /\binsert\s+into\b/i);
  assert.doesNotMatch(pastSql, /\bupdate\s+[a-z_]+\s+set\b/i);
  assert.doesNotMatch(pastSql, /\bdelete\s+from\b/i);
  assert.doesNotMatch(pastSql, /service_role_key/i);
  assert.doesNotMatch(pastSql, /sb_secret_/);

  assert.match(page, /Draft a pick list from job #2309/);
  assert.match(page, /STFD calculator and job packet/);
  assert.match(page, /max-width:720px/);
});

test("SQL files are read-only and follow the ask_* lockdown", () => {
  for (const sql of [jobSql, stfdSql, pastSql]) {
    assert.match(sql, /stable/i);
    assert.match(sql, /security definer/i);
    assert.match(sql, /set search_path to 'public', 'pg_temp'/i);
    assert.match(sql, /returns jsonb/i);
    assert.match(sql, /revoke all on function/i);
    assert.match(sql, /from anon/i);
    assert.match(sql, /from authenticated/i);
    assert.match(sql, /grant execute on function/i);
    assert.match(sql, /to service_role/i);
    assert.doesNotMatch(sql, /\binsert\s+into\b/i);
    assert.doesNotMatch(sql, /\bupdate\s+[a-z_]+\s+set\b/i);
    assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
    assert.doesNotMatch(sql, /service_role_key/i);
    assert.doesNotMatch(sql, /sb_secret_/);
  }

  assert.match(jobSql, /function public\.ask_by_job_ref\(p_job_ref text\)/);
  assert.match(jobSql, /'sales'/);
  assert.match(jobSql, /'open_quotes'/);
  assert.match(jobSql, /'closed_quotes'/);
  assert.match(stfdSql, /drop function if exists public\.ask_stfd_purchases\(integer\)/);
  assert.match(stfdSql, /p_months integer default 1/);
  assert.match(stfdSql, /p_from date default null/);
  assert.match(stfdSql, /p_to date default null/);
  assert.match(stfdSql, /p_sku text default null/);
  assert.match(stfdSql, /p_detail boolean default false/);
  assert.match(stfdSql, /'period_months'/);
  assert.match(stfdSql, /'top_items'/);
  assert.match(stfdSql, /'lines'/);
});
