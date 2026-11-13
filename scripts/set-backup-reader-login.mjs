#!/usr/bin/env node
// Gives the nightly database backup its login, or replaces it (a rotation is the same three steps).
//
//   node scripts/set-backup-reader-login.mjs --confirm-production
//
// Run it from the main checkout, where `.env.local` and the Railway link are. It:
//   1. makes a new random password and, on this machine, the SCRAM string PostgreSQL stores for it, then runs
//      `alter role phoenix_backup_reader login password '<that string>'` on PRODUCTION. The plain password
//      never reaches the database or its logs. The old password stops working at that moment;
//   2. signs in as the role through the pooler and proves it reads and cannot write;
//   3. writes the connection URL into the Railway variable DB_BACKUP_DATABASE_URL on the service
//      `phoenix-code-backup`, through stdin. Railway redeploys that service; a redeploy starts no backup.
//
// 🔴 It prints no password, no URL and no stored string, and nothing here may ever log one. The URL reads
// every table in production: it lives on that one Railway service and nowhere else.
// 🔴 Not between 02:15 and 03:00 Cairo: the redeploy would replace the container while the night's run is on.
// If step 3 fails, the database holds the new password and Railway the old one, so the next night fails and
// its alarm fires. Run this again: it is safe to repeat.

import { spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";
import { scramVerifier } from "./lib/scram-verifier.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs). It has no
// dry run: the only way to see what it would do is to read it.
refuseUnknownFlags({
  name: "set-backup-reader-login",
  entry: import.meta.url,
  known: ["--confirm-production"],
  hints: ["there is no dry run: this sets a new password on production and writes one Railway variable"],
});

const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";
const ROLE = "phoenix_backup_reader";
const SERVICE = "phoenix-code-backup";
const VARIABLE = "DB_BACKUP_DATABASE_URL";

function stop(message) {
  console.error(`refused: ${message}`);
  process.exit(1);
}

if (!process.argv.includes("--confirm-production")) {
  stop("this changes a login on the PRODUCTION database. Pass --confirm-production.");
}

const envLine = /^SUPABASE_DB_URL=(.*)$/m.exec(readFileSync(".env.local", "utf8"));
if (!envLine) stop(".env.local has no SUPABASE_DB_URL. Run this from the main checkout.");
const admin = new URL(envLine[1].trim().replace(/^["']|["']$/g, ""));
if (!decodeURIComponent(admin.username).endsWith(`.${PRODUCTION_REF}`)) {
  stop("SUPABASE_DB_URL is not production's pooler login. This login exists on production only.");
}

/** psql with the connection in libpq's variables and the SQL on stdin: nothing secret is an argument. */
function psql(user, password, sql) {
  const result = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "--no-password"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PGAPPNAME: "set-backup-reader-login",
      PGCONNECT_TIMEOUT: "30",
      PGDATABASE: admin.pathname.slice(1) || "postgres",
      PGHOST: admin.hostname,
      PGPASSWORD: password,
      PGPORT: admin.port || "5432",
      PGSSLMODE: "require",
      PGUSER: user,
    },
    input: sql,
  });
  if (result.error) stop(`psql could not start: ${result.error.message}`);
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
// Letters and digits only: db-backup.sh refuses a password a URL would have to escape.
const password = Array.from({ length: 40 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
const stored = scramVerifier(password, randomBytes(16));

const adminUser = decodeURIComponent(admin.username);
const adminPassword = decodeURIComponent(admin.password);
const before = psql(adminUser, adminPassword, `select rolbypassrls::int || '/' || rolsuper::int || '/' || rolcreaterole::int from pg_roles where rolname = '${ROLE}';\n`);
if (!before.ok) stop(`production could not be read as the admin login. ${before.err.split("\n")[0]}`);
if (before.out !== "1/0/0") stop(`the role ${ROLE} is missing or is not the one the migration makes (read "${before.out}", wanted "1/0/0").`);

const set = psql(adminUser, adminPassword, `alter role ${ROLE} login password '${stored}';\n`);
if (!set.ok) stop("the login could not be set. Nothing changed. (The database's answer is not shown: it can quote the statement.)");
console.log(`1/3 production: ${ROLE} has a new password (stored as SCRAM-SHA-256; the plain password never left this machine).`);

// The pooler can take a few seconds to learn a new password.
const readerUser = `${ROLE}.${PRODUCTION_REF}`;
// Asked of the privilege tables, and then tried inside a transaction that is rolled back either way, so the
// proof can leave nothing on production whatever its answer.
const proof =
  "select current_user || ' reads ' || count(*) || ' public tables and may write to ' || " +
  "count(*) filter (where has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE') or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE')) " +
  "from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname = 'public';\n";
let read = { ok: false, out: "", err: "" };
for (let attempt = 1; attempt <= 6 && !read.ok; attempt += 1) {
  if (attempt > 1) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  read = psql(readerUser, password, proof);
}
if (!read.ok) stop(`the new login could not sign in through the pooler. The database HAS the new password; Railway was not changed. ${read.err.split("\n")[0]}`);
if (!/ reads [1-9]\d* public tables and may write to 0$/.test(read.out)) {
  stop(`🔴 the backup login does not read everything and write nothing (${read.out}). Railway was not changed; read the role's grants now.`);
}
const write = psql(readerUser, password, "begin read write;\ncreate table public.zz_backup_reader_must_not_write (id int);\nrollback;\n");
if (write.ok) stop("🔴 THE BACKUP LOGIN CAN CREATE A TABLE (the attempt was rolled back, so nothing was left). Railway was not changed; read the role's grants now.");
console.log(`2/3 signed in through the pooler: ${read.out}; making a table was refused.`);

const url = `postgresql://${readerUser}:${password}@${admin.hostname}:${admin.port || "5432"}/${admin.pathname.slice(1) || "postgres"}?sslmode=require`;
const railway = spawnSync("railway", ["variable", "set", VARIABLE, "--stdin", "--service", SERVICE, "--environment", "production"], {
  encoding: "utf8",
  input: url,
  shell: process.platform === "win32",
});
if (railway.error || railway.status !== 0) {
  stop(`Railway did not take the variable (exit ${railway.status ?? "none"}). The database HAS the new password and Railway does not: run this again.`);
}
console.log(`3/3 Railway: ${VARIABLE} is set on ${SERVICE} (production). Its value was sent through stdin and is shown nowhere.`);
