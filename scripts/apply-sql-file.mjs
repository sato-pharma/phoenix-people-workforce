// Applies a single generated .sql file to staging or production over the pooler connection.
// Companion to resolve-brick-pins.mjs, which deliberately writes SQL to a file and never touches
// the database itself: this is the separate, explicit apply step.
// Usage: node scripts/apply-sql-file.mjs <file.sql> <staging|production>
import { existsSync, readFileSync } from "node:fs";

import postgres from "postgres";

const ENV_FILES = [".env.staging.rls.local", ".env.production.rls.local", ".env.local"];

function envVar(name) {
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0 || line.slice(0, eq).trim() !== name) continue;
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  throw new Error("missing " + name);
}

function toPooler(raw) {
  const m = /^(\w+):\/\/([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/(.+)$/.exec(raw);
  if (!m) return raw;
  const [, scheme, user, pass, ref, , db] = m;
  return `${scheme}://${user}.${ref}:${pass}@aws-0-eu-central-1.pooler.supabase.com:5432/${db}`;
}

const file = process.argv[2];
const env = process.argv[3];
if (!file || !existsSync(file)) throw new Error("usage: apply-sql-file.mjs <file.sql> <staging|production>");
if (env !== "staging" && env !== "production") throw new Error("env must be staging or production");

const varName = env === "staging" ? "PHOENIX_STAGING_DATABASE_URL" : "PHOENIX_PRODUCTION_DATABASE_URL";
const sql = postgres(toPooler(envVar(varName)), { max: 1, prepare: false });

try {
  const [{ ref }] = await sql`select current_database() as ref`;
  console.log(JSON.stringify({ env, database: ref, file }));
  const text = readFileSync(file, "utf8");
  const result = await sql.unsafe(text);
  console.log(JSON.stringify({ applied: true, count: result.count ?? result.length ?? null }));
} finally {
  await sql.end({ timeout: 5 });
}
