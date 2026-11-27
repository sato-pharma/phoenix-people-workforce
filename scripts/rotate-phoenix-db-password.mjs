// rotate-phoenix-db-password.mjs — carry a new Phoenix PRODUCTION database password into every local
// env file that holds one, without the password ever reaching a command line, a log or a chat.
//
// Owner decision 2026-09-17: replace the production database password (it had leaked into local chat
// transcripts). Inventory the same day: nothing off this laptop uses it — the app talks to Supabase over
// HTTPS with API keys, and neither GitHub nor Railway holds it — so a reset breaks only local scripts
// until this runs. Two keys hold it, in the primary checkout and in every worktree's copy:
//   .env.local                 SUPABASE_DB_URL                    (session pooler, port 5432)
//   .env.production.rls.local  PHOENIX_PRODUCTION_DATABASE_URL    (direct db.<ref> host)
// The reset itself is dashboard-only (AGENTS.md 2.3: never ALTER ROLE).
//
//   node rotate-phoenix-db-password.mjs --targets   list every file and key it would change (no DB)
//   node rotate-phoenix-db-password.mjs --probe     which saved URL connects today (select 1 only)
//   node rotate-phoenix-db-password.mjs --apply     read the new password from the input file, prove it
//                                                   connects, write every target, then empty the file
//
// Input file: ~/.claude/rotation/phoenix-db-password.txt — the password alone, nothing else.
// Output is names, paths, lengths and yes/no only.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const REF = "ozucdzovmcqvepbozvqf";
const PRIMARY = "F:/Phoenix Workforce/phoenix-workforce";
const TARGETS = [[".env.local", "SUPABASE_DB_URL"], [".env.production.rls.local", "PHOENIX_PRODUCTION_DATABASE_URL"]];
const DIR = path.join(os.homedir(), ".claude", "rotation");
const INPUT = path.join(DIR, "phoenix-db-password.txt");
const mode = process.argv[2];

const secrets = new Set();
const clean = (s) => { let t = String(s ?? ""); for (const v of secrets) if (v) t = t.split(v).join("***"); return t; };

function folders() {
  const set = new Set([PRIMARY]);
  try {
    const out = execSync(`git -C "${PRIMARY}" worktree list --porcelain`, { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) if (line.startsWith("worktree ")) set.add(line.slice(9).replace(/\\/g, "/"));
  } catch {}
  const parent = path.dirname(PRIMARY);
  for (const n of fs.readdirSync(parent)) if (n.startsWith("_wt-")) set.add(`${parent}/${n}`.replace(/\\/g, "/"));
  return [...set].filter((f) => fs.existsSync(f));
}

const URL_RE = /^(postgres(?:ql)?:\/\/[^:/@\s]+:)([^@\s]*)(@.+)$/;
function readTarget(file, key) {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/(\r?\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    const m = lines[i].match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(["']?)(.*?)\4(\s*)$/);
    if (!m || m[2] !== key) continue;
    const value = m[5];
    const u = value.match(URL_RE);
    if (!u) return { raw, lines, i, m, value, error: "not a postgres URL" };
    let parsed; try { parsed = new URL(value); } catch { return { raw, lines, i, m, value, error: "unparseable URL" }; }
    const prod = parsed.username.endsWith(`.${REF}`) || parsed.hostname === `db.${REF}.supabase.co`;
    let password = u[2];
    try { password = decodeURIComponent(u[2]); } catch {}
    secrets.add(password); secrets.add(u[2]);
    return { raw, lines, i, m, value, u, parsed, prod, password };
  }
  return null;
}

function listTargets() {
  const found = [];
  for (const folder of folders()) for (const [name, key] of TARGETS) {
    const file = `${folder}/${name}`;
    if (!fs.existsSync(file)) continue;
    const t = readTarget(file, key);
    if (t) found.push({ folder, file, name, key, t });
  }
  return found;
}

async function tryConnect(url) {
  const require = createRequire(`${PRIMARY}/package.json`);
  const postgres = require("postgres");
  const sql = postgres(url, { max: 1, connect_timeout: 15, idle_timeout: 1, prepare: false, onnotice: () => {} });
  try {
    await sql`select 1 as ok`;
    let fp = null;
    try { fp = (await sql`select left(md5(rolpassword), 12) as fp from pg_authid where rolname = 'postgres'`)[0]?.fp ?? null; } catch {}
    return { ok: true, fp };
  } catch (e) {
    return { ok: false, code: e.code || e.errno || "error", message: clean(e.message).slice(0, 120) };
  } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
}

const short = (f) => f.replace(`${path.dirname(PRIMARY)}/`, "");

if (mode === "--targets") {
  const found = listTargets();
  for (const x of found) console.log(`${x.t.error ? "SKIP " + x.t.error : x.t.prod ? "prod" : "SKIP not production"} | ${short(x.file)} | ${x.key} | password length ${x.t.password?.length ?? "-"}`);
  const distinct = new Set(found.filter((x) => x.t.password).map((x) => x.t.password)).size;
  console.log(`${found.filter((x) => x.t.prod).length} production target(s) in ${new Set(found.map((x) => x.folder)).size} folder(s); ${distinct} distinct saved password(s)`);
} else if (mode === "--probe") {
  fs.mkdirSync(DIR, { recursive: true });
  for (const [name, key] of TARGETS) {
    const t = readTarget(`${PRIMARY}/${name}`, key);
    if (!t?.prod) { console.log(`${key}: not found or not production`); continue; }
    const r = await tryConnect(t.value);
    console.log(`${key} (${name}, password length ${t.password.length}): ${r.ok ? "CONNECTS" : `fails ${r.code} ${r.message}`}${r.ok ? ` | role hash fingerprint ${r.fp ? "read" : "not readable"}` : ""}`);
    if (r.ok && r.fp) fs.writeFileSync(path.join(DIR, "phoenix-db-fingerprint-before.txt"), `${new Date().toISOString()} ${r.fp}\n`);
  }
} else if (mode === "--apply") {
  if (!fs.existsSync(INPUT)) { console.log(`No input file at ${INPUT}`); process.exit(2); }
  const next = fs.readFileSync(INPUT, "utf8").replace(/^\uFEFF/, "").trim();
  secrets.add(next); secrets.add(encodeURIComponent(next));
  if (!next || /\s/.test(next) || next.length < 12) { console.log(`The input file does not hold a single password (length ${next.length}, whitespace ${/\s/.test(next)}). Nothing changed.`); process.exit(2); }
  const found = listTargets().filter((x) => x.t.prod && !x.t.error);
  if (!found.length) { console.log("No production targets found. Nothing changed."); process.exit(2); }
  if (found.every((x) => x.t.password === next)) { console.log(`All ${found.length} targets already hold the new password.`); }
  // Prove the new password before touching a file. Supavisor keeps its own copy and can lag the reset.
  const pooler = found.find((x) => x.key === "SUPABASE_DB_URL") || found[0];
  const newUrl = (x) => x.t.u[1] + encodeURIComponent(next) + x.t.u[3];
  let proof = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    proof = await tryConnect(newUrl(pooler));
    if (proof.ok) break;
    console.log(`attempt ${attempt}: new password does not connect yet (${proof.code})`);
    if (attempt < 10) await new Promise((r) => setTimeout(r, 20000));
  }
  if (!proof.ok) { console.log("The new password never connected, so no file was changed. Check the reset saved in the dashboard."); process.exit(1); }
  const beforeFile = path.join(DIR, "phoenix-db-fingerprint-before.txt");
  const before = fs.existsSync(beforeFile) ? fs.readFileSync(beforeFile, "utf8").trim().split(" ")[1] : null;
  console.log(`new password connects | role hash ${before && proof.fp ? (before === proof.fp ? "UNCHANGED (unexpected)" : "changed since the probe") : "not compared"}`);
  let written = 0;
  for (const x of found) {
    const t = readTarget(x.file, x.key);
    if (t.password === next) continue;
    t.lines[t.i] = t.m[1] + t.m[2] + t.m[3] + t.m[4] + newUrl({ t }) + t.m[4] + t.m[6];
    const out = t.lines.join("");
    const tmp = `${x.file}.rotate-tmp`;
    fs.writeFileSync(tmp, out);
    try { fs.renameSync(tmp, x.file); } catch { fs.writeFileSync(x.file, out); try { fs.rmSync(tmp); } catch {} }
    const check = readTarget(x.file, x.key);
    const good = check?.password === next && fs.readFileSync(x.file, "utf8").split(/\r?\n/).length === t.raw.split(/\r?\n/).length;
    console.log(`${good ? "updated" : "FAILED "} | ${short(x.file)} | ${x.key}`);
    if (good) written++;
  }
  const pending = listTargets().filter((x) => x.t.prod && !x.t.error && x.t.password !== next).length;
  if (pending) { console.log(`${written} updated, ${pending} still hold the old password. The input file was kept so --apply can be run again.`); process.exit(1); }
  fs.writeFileSync(INPUT, "");
  fs.rmSync(INPUT);
  console.log(`${written} file entr${written === 1 ? "y" : "ies"} updated; all ${found.length} production targets now hold the new password; the input file was emptied and removed.`);
} else {
  console.log("usage: --targets | --probe | --apply");
}
