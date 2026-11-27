#!/usr/bin/env node
// Puts the CURRENT production database password into the spare laptop's .env.local, the first time the spare answers.
//
// Owner, 19 Nov 2026: "fix the spare laptop's database password". The production postgres password was replaced at
// ~02:20 Cairo that night (credentials audit, item 1). The shared .env.local on this laptop holds the new one; the
// spare's own copy (D:\Phoenix\phoenix-workforce\.env.local, a separate file) still held the old, now-refused one,
// and the spare was off the network (this laptop on a phone hotspot), so it could not be fixed then.
//
// Scheduled task "Phoenix Spare Database Password Refresh" runs this every 10 minutes through
// spare-db-password-refresh.ps1, and the wrapper removes the task once this exits 0.
//
// SECRETS: nothing is printed or logged but key names and sha256 prefixes ("pw#xxxxxxxx"). The password is read
// from this laptop's .env.local at run time and travels ONLY inside the script text that `node -` reads from SSH's
// stdin on the spare: never an argument (process lists), never a file on either machine.
//
// Exit 0: done and proven (the spare logged in to production over TLS with the new password).
// Exit 3: spare not reachable (retry later). Exit 4: refused to run (local file wrong). Exit 5: spare-side failure.
//   --local-test <envFile> <repoDir>: runs the spare-side half HERE against a copy, to prove the rewrite logic.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const LOG = path.join(HOME, ".claude", "logs", "spare-db-password-refresh.log");
const LOCAL_ENV = "F:/Phoenix Workforce/phoenix-workforce/.env.local";
const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";
const EXPECTED_NEW_FP = "7e100cf2"; // the password set on 19 Nov 2026; refuse to push anything else
const OLD_FP = "3a5f8159"; // the refused one, for bare password keys only
const SPARE_ENV = "/home/phoenix/phoenix/phoenix-workforce/.env.local";   // Ubuntu since 2026-11-20 (was D:/Phoenix/...)
const SPARE_REPO = "/home/phoenix/phoenix/phoenix-workforce";

const fp = (v) => crypto.createHash("sha256").update(v).digest("hex").slice(0, 8);
const cairo = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const log = (m) => {
  const line = `${cairo()} Cairo  ${m}`;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, line + "\n");
  console.log(line);
};

// ── the new password, from this laptop's shared .env.local ──────────────────────────────────────────────────
function newPassword() {
  const text = fs.readFileSync(LOCAL_ENV, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("SUPABASE_DB_URL="));
  if (!line) throw new Error("SUPABASE_DB_URL is not in the local .env.local");
  let raw = line.slice("SUPABASE_DB_URL=".length).trim();
  if (/^["']/.test(raw)) raw = raw.slice(1, raw.lastIndexOf(raw[0]));
  const u = new URL(raw);
  if (!u.hostname.includes(PRODUCTION_REF) && !decodeURIComponent(u.username).includes(PRODUCTION_REF)) {
    throw new Error("the local SUPABASE_DB_URL does not name the production project");
  }
  const pw = decodeURIComponent(u.password);
  if (fp(pw) !== EXPECTED_NEW_FP) throw new Error(`the local password is pw#${fp(pw)}, not the expected pw#${EXPECTED_NEW_FP}`);
  return pw;
}

// ── the half that runs ON THE SPARE (node --input-type=module -, script text on stdin) ──────────────────────
function spareScript({ password, envFile, repoDir }) {
  return `
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
const NEW = ${JSON.stringify(password)};
const REF = ${JSON.stringify(PRODUCTION_REF)};
const OLD_FP = ${JSON.stringify(OLD_FP)};
const FILE = ${JSON.stringify(envFile)};
const fp = (v) => crypto.createHash("sha256").update(v).digest("hex").slice(0, 8);
if (!fs.existsSync(FILE)) { console.log("RESULT no-file"); process.exit(5); }
const ino = fs.statSync(FILE).ino;
const before = fs.readFileSync(FILE, "utf8");
const eol = before.includes("\\r\\n") ? "\\r\\n" : "\\n";
const changed = [];
let dbUrl = null;
const unq = (raw) => /^["']/.test(raw) ? [raw[0], raw.slice(1, raw.lastIndexOf(raw[0]))] : ["", raw.trim()];
const after = before.split(eol).map((line) => {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
  if (!m) return line;
  const [, key, rawValue] = m;
  const [q, value] = unq(rawValue);
  const url = /^(postgres(?:ql)?:\\/\\/)([^:/@]+):([^@]*)(@.*)$/.exec(value);
  if (url) {
    const [, scheme, user, rawPw, rest] = url;
    if (!decodeURIComponent(user).startsWith("postgres") || !(user + rest).includes(REF)) return line;
    let cur; try { cur = decodeURIComponent(rawPw); } catch { cur = rawPw; }
    if (key === "SUPABASE_DB_URL" || !dbUrl) dbUrl = { key, value: scheme + user + ":" + encodeURIComponent(NEW) + rest };
    if (cur === NEW) return line;
    changed.push(key + " pw#" + fp(cur) + " -> pw#" + fp(NEW));
    return key + "=" + q + scheme + user + ":" + encodeURIComponent(NEW) + rest + q;
  }
  if (/^(PGPASSWORD|SUPABASE_DB_PASSWORD|POSTGRES_PASSWORD|DB_PASSWORD|DATABASE_PASSWORD)$/.test(key) && value && fp(value) === OLD_FP) {
    changed.push(key + " pw#" + fp(value) + " -> pw#" + fp(NEW));
    return key + "=" + q + NEW + q;
  }
  return line;
}).join(eol);
if (changed.length) {
  fs.writeFileSync(FILE, after);
  const others = (t) => t.split(eol).filter((l) => !changed.some((c) => l.startsWith(c.split(" ")[0] + "="))).join(eol);
  console.log("same-file " + (fs.statSync(FILE).ino === ino) + " | other-lines-unchanged " + (others(fs.readFileSync(FILE, "utf8")) === others(before)));
}
for (const c of changed) console.log("CHANGED " + c);
if (!dbUrl) { console.log("RESULT no-production-url"); process.exit(5); }
const require = createRequire(${JSON.stringify(repoDir + "/package.json")});
const postgres = require("postgres");
const sql = postgres(dbUrl.value, { ssl: "require", max: 1, connect_timeout: 20, idle_timeout: 1, onnotice: () => {} });
try {
  const [r] = await sql\`select current_user as who, coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false) as tls\`;
  console.log("RESULT connected via " + dbUrl.key + " as " + r.who + " tls=" + r.tls + " changed=" + changed.length);
  await sql.end({ timeout: 2 });
  process.exit(r.tls ? 0 : 5);
} catch (e) {
  console.log("RESULT connect-failed " + (e.code || e.name) + " " + String(e.message).replace(/postgres(ql)?:\\/\\/\\S+/g, "<url>").slice(0, 160));
  try { await sql.end({ timeout: 1 }); } catch {}
  process.exit(5);
}
`;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let password;
try { password = newPassword(); } catch (e) { log(`REFUSED: ${e.message}`); process.exit(4); }

if (args[0] === "--local-test") {
  const r = spawnSync(process.execPath, ["--input-type=module", "-"], { input: spareScript({ password, envFile: args[1], repoDir: args[2] }), encoding: "utf8", timeout: 60_000 });
  process.stdout.write(r.stdout || "");
  process.stderr.write((r.stderr || "").replace(/postgres(ql)?:\/\/\S+/g, "<url>"));
  process.exit(r.status ?? 5);
}

const finder = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(HOME, ".claude", "scripts", "spare-address.ps1")], { encoding: "utf8", timeout: 120_000 });
const addr = (finder.stdout || "").trim().split(/\r?\n/).pop()?.trim();
if (finder.status !== 0 || !addr) { log(`spare not reachable (last known ${addr || "?"}) - will retry`); process.exit(3); }

// The spare's user, written by spare-rebuild.ps1 after the 2026-11-20 reinstall; the old name when the file is absent.
function spareUser() {
  try { return fs.readFileSync(path.join(HOME, ".claude", "scripts", "spare-user.txt"), "utf8").trim() || "TransferUser"; } catch { return "TransferUser"; }
}
const ssh = spawnSync(
  path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe"),
  ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "LogLevel=ERROR", "-i", path.join(HOME, ".ssh", "phoenix_spare_ed25519"), `${spareUser()}@${addr}`, "node --input-type=module -"],
  { input: spareScript({ password, envFile: SPARE_ENV, repoDir: SPARE_REPO }), encoding: "utf8", timeout: 120_000 },
);
const out = `${ssh.stdout || ""}${ssh.stderr || ""}`.replace(/postgres(ql)?:\/\/\S+/g, "<url>").trim();
for (const line of out.split(/\r?\n/).filter(Boolean).slice(-8)) log(`spare ${addr}: ${line.slice(0, 220)}`);
if (ssh.status === 0 && /RESULT connected .* tls=true/.test(out)) { log("DONE: the spare's .env.local holds the current production password and logs in over TLS"); process.exit(0); }
log(`NOT DONE (exit ${ssh.status}) - will retry`);
process.exit(5);
