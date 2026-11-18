// EVERY SCRIPT THAT OPENS ITS OWN DATABASE CONNECTION ASKS FOR TLS — credentials audit of 18 Nov 2026, finding 2,
// fixed on the owner's word ("fix those", 19 Nov 2026).
//
// WHY. The production database accepts unencrypted connections until SSL enforcement is switched on, and postgres.js
// (3.4.9) connects WITHOUT TLS unless the call says `ssl` — it has no PGSSLMODE support, and none of the database URLs
// the scripts read carries `sslmode`. So before 19 Nov about 17 script connections sent the database password and
// every row in clear over the network, and once enforcement is switched on each of them would simply be refused.
// psql and pg_dump (the release gate, the code backup) use libpq, whose default `prefer` already negotiates TLS; the
// app itself reaches the database over HTTPS and opens no Postgres connection.
//
// What this file pins: every `postgres(...)` call in a tracked file under scripts/ or tests/scripts/ names
// `ssl: "require"` (or "verify-full", true, or an options object) in its own arguments, or passes an object declared in
// the same file that does. A missing `ssl` or `ssl: false`/"prefer"/"allow"/"disable" fails it.
// infra/phoenix-mcp is outside it: that server verifies the certificate chain itself and has its own tests.

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = ["scripts", path.join("tests", "scripts")];
const SOURCE = /\.(?:mjs|cjs|js|ts|mts)$/;
const IMPORTS_POSTGRES = /(?:from\s*["']postgres["']|require\(\s*["']postgres["']\s*\)|import\(\s*["']postgres["']\s*\))/;
const ACCEPTED_SSL = /\bssl\s*:\s*(?:["'](?:require|verify-full)["']|true\b|\{)/;
const ANY_SSL = /\bssl\s*:/;

export type PostgresCall = { file: string; line: number; args: string; verdict: "tls" | "missing" | "weak" };

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE.test(name)) out.push(full);
  }
}

/** The text between the bracket at `open` and its matching close, or null when it never closes. */
function balanced(src: string, open: number, pair: "()" | "{}"): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === pair[0]) depth++;
    else if (c === pair[1]) {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** The body of `const|let|var <name> = { … }` in the same file, when there is one. */
function objectDeclaration(src: string, name: string): string | null {
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b[^=]*=\\s*\\{`).exec(src);
  if (!decl) return null;
  return balanced(src, decl.index + decl[0].length - 1, "{}");
}

function judge(src: string, args: string): PostgresCall["verdict"] {
  const own = [args];
  for (const id of args.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    const body = objectDeclaration(src, id);
    if (body !== null) own.push(body);
  }
  if (own.some((text) => ACCEPTED_SSL.test(text))) return "tls";
  return own.some((text) => ANY_SSL.test(text)) ? "weak" : "missing";
}

/** Every `postgres(...)` call in one source text. A regex such as /postgres(?:ql)?:/ is not a call. */
export function postgresCalls(file: string, src: string): PostgresCall[] {
  const calls: PostgresCall[] = [];
  const re = /(?<![\w$.])postgres\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = m.index + "postgres".length;
    if (src.startsWith("(?", open)) continue;
    const args = balanced(src, open, "()");
    if (args === null) continue;
    const line = src.slice(0, m.index).split("\n").length;
    calls.push({ file, line, args: args.replace(/\s+/g, " ").trim(), verdict: judge(src, args) });
  }
  return calls;
}

export function scriptPostgresCalls(root = process.cwd()): PostgresCall[] {
  const files: string[] = [];
  for (const dir of ROOTS) walk(path.join(root, dir), files);
  const calls: PostgresCall[] = [];
  for (const full of files) {
    const src = readFileSync(full, "utf8");
    if (!IMPORTS_POSTGRES.test(src)) continue;
    calls.push(...postgresCalls(path.relative(root, full).split(path.sep).join("/"), src));
  }
  return calls;
}

export async function runPostgresConnectionsUseTlsTests(): Promise<void> {
  // 1. The judge itself, on fixtures, so a scan that finds nothing can never pass by accident.
  const fixture = (body: string) => postgresCalls("fixture.ts", `import postgres from "postgres";\n${body}`);
  assert.equal(fixture(`const sql = postgres(url, { max: 1, ssl: "require" });`)[0]?.verdict, "tls");
  assert.equal(fixture(`const sql = postgres(url, { ssl: 'verify-full' });`)[0]?.verdict, "tls");
  assert.equal(fixture(`const sql = postgres(url, { max: 1, prepare: false });`)[0]?.verdict, "missing");
  assert.equal(fixture(`const sql = postgres(url);`)[0]?.verdict, "missing");
  assert.equal(fixture(`const sql = postgres(url, { ssl: false });`)[0]?.verdict, "weak");
  assert.equal(fixture(`const sql = postgres(url, { ssl: "prefer" });`)[0]?.verdict, "weak");
  assert.equal(
    fixture(`const options = { max: 1, ssl: "require" as const };\nconst a = postgres(raw, options);\nconst b = postgres({ ...options, host });`)
      .map((c) => c.verdict)
      .join(","),
    "tls,tls",
    "an options object declared in the same file carries its ssl into every call that passes it",
  );
  assert.equal(
    fixture(`const options = { max: 1 };\nconst a = postgres(raw, options);`)[0]?.verdict,
    "missing",
    "an options object without ssl is still a plain-text connection",
  );
  assert.equal(fixture(`const m = /^(postgres(?:ql)?:\\/\\/)/.exec(url);`).length, 0, "a URL regex is not a call");

  // 2. The real tree.
  const calls = scriptPostgresCalls();
  assert.ok(
    calls.length >= 35,
    `expected at least 35 postgres() calls under scripts/ and tests/scripts/ (39 on 19 Nov 2026), found ${calls.length} — the scan has stopped seeing them`,
  );
  const bad = calls.filter((c) => c.verdict !== "tls");
  assert.deepEqual(
    bad.map((c) => `${c.file}:${c.line} (${c.verdict === "weak" ? "ssl is not require" : "no ssl"}) postgres(${c.args.slice(0, 80)})`),
    [],
    'every script connection must ask for TLS — add ssl: "require" to the call or to the options object it passes ' +
      "(postgres.js connects in plain text otherwise, and the database will refuse it once SSL enforcement is on)",
  );
}
