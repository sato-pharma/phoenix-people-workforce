// Applies a single generated .sql file to staging or production over the pooler connection.
// Companion to resolve-brick-pins.mjs, which deliberately writes SQL to a file and never touches
// the database itself: this is the separate, explicit apply step.
// Usage: node scripts/apply-sql-file.mjs <file.sql> <staging|production>
import { existsSync, readFileSync } from "node:fs";

import postgres from "postgres";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";
import { PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF, projectRefFromUrl } from "./lib/supabase-project-refs.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "apply-sql-file",
  entry: import.meta.url,
  known: [],
});

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

// The pooler REGION cannot be derived from the project ref — two projects in the same org can sit
// behind aws-0 and aws-1. This rewrite used to hardcode aws-0, so a direct `db.<ref>.supabase.co`
// URL for an aws-1 project was silently rewritten to the wrong pooler and failed with
// "Tenant or user not found" — an error that reads like a bad credential and sends you off
// resetting passwords. That cost a real session on 2026-08-12.
//
// A URL that is ALREADY in pooler form is passed through untouched (it carries the correct region
// and the `postgres.<ref>` username), which is the form the dashboard's "Session pooler" tab gives
// you and the form you should prefer.
const DEFAULT_POOLER_HOST = "aws-0-eu-central-1.pooler.supabase.com";
// The two projects' own poolers, measured: production answers only on aws-1 ("Tenant or user not
// found" on aws-0, every production apply since 2026-10-15 needed PHOENIX_POOLER_HOST for it);
// staging answers on aws-0. A direct URL for either now lands on the right one with no prefix.
const POOLER_HOST_BY_REF = {
  [PRODUCTION_PROJECT_REF]: "aws-1-eu-central-1.pooler.supabase.com",
  [STAGING_PROJECT_REF]: "aws-0-eu-central-1.pooler.supabase.com",
};

function poolerHostFor(ref) {
  return process.env.PHOENIX_POOLER_HOST?.trim() || POOLER_HOST_BY_REF[ref] || DEFAULT_POOLER_HOST;
}

function toPooler(raw) {
  const m = /^(\w+):\/\/([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/(.+)$/.exec(raw);
  if (!m) return raw; // already pooler form (or something else) — leave it alone
  const [, scheme, user, pass, ref, , db] = m;
  // PHOENIX_POOLER_HOST still wins, for a project on neither known pooler.
  return `${scheme}://${user}.${ref}:${pass}@${poolerHostFor(ref)}:5432/${db}`;
}

/**
 * Turn the pooler's least helpful error into an actionable one.
 *
 * "Tenant or user not found" from a pooler almost always means the REGION is wrong, not the
 * password — but it is indistinguishable from a credential failure unless you know that.
 */
function explainConnectionError(error, rawUrl) {
  const message = String(error?.message ?? "");
  if (!/tenant|not found/i.test(message)) return error;
  const rewritten = !/pooler\.supabase\.com/.test(rawUrl);
  return new Error(
    `${message}\n\n` +
      "This is USUALLY the wrong pooler REGION, not a bad password.\n" +
      (rewritten
        ? `The URL was the direct db.<ref>.supabase.co form, so it was rewritten to ` +
          `${poolerHostFor(projectRefFromUrl(rawUrl))}. If this project is on a ` +
          "different region, that host is wrong.\n\n"
        : "") +
      "FIX: use the Session pooler URI from Supabase (Project Settings -> Database -> Connection " +
      "pooling). It carries the correct region and the postgres.<ref> username, and this script " +
      "passes it through untouched. Alternatively set PHOENIX_POOLER_HOST for this project.",
  );
}

const file = process.argv[2];
const env = process.argv[3];
if (!file || !existsSync(file)) throw new Error("usage: apply-sql-file.mjs <file.sql> <staging|production>");
if (env !== "staging" && env !== "production") throw new Error("env must be staging or production");

const varName = env === "staging" ? "PHOENIX_STAGING_DATABASE_URL" : "PHOENIX_PRODUCTION_DATABASE_URL";
const rawUrl = envVar(varName);

// WHICH PROJECT, before a connection opens. This used to print `current_database()`, which answers
// "postgres" on staging and production alike, so a staging run with a production URL in the
// staging variable (or the reverse) applied with nothing to show for it. The ref is read out of
// the URL itself — the db.<ref> host or the postgres.<ref> pooler user — and must be the
// project the argument names.
const expectedRef = env === "staging" ? STAGING_PROJECT_REF : PRODUCTION_PROJECT_REF;
const urlRef = projectRefFromUrl(rawUrl);
if (urlRef !== expectedRef) {
  throw new Error(
    `${varName} names ${urlRef ? `project ${urlRef}` : "no Supabase project"}, but "${env}" is ${expectedRef}. ` +
      "Nothing was applied. Fix the variable rather than the argument.",
  );
}

const sql = postgres(toPooler(rawUrl), { max: 1, prepare: false, ssl: "require" });

try {
  try {
    await sql`select 1`;
  } catch (connectionError) {
    throw explainConnectionError(connectionError, rawUrl);
  }
  console.log(JSON.stringify({ env, projectRef: urlRef, file }));
  const text = readFileSync(file, "utf8");
  const result = await sql.unsafe(text);
  console.log(JSON.stringify({ applied: true, count: result.count ?? result.length ?? null }));
} finally {
  await sql.end({ timeout: 5 });
}
