import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
  projectRefFromUrl,
  requireStagingSupabase,
} from "../scripts/lib/supabase-project-refs.mjs";
import { PRODUCTION_REF, STAGING_REF } from "../scripts/repo-doctor-supabase-link.mjs";

/**
 * WHICH PROJECT a script is about to write to, read out of the URL — never out of a variable's name.
 *
 * Supabase audit, 18 Nov 2026: every `.env.local` on the owner's laptop points at PRODUCTION. The
 * three disposable-fixture smoke runners took their URL from it and create employees, payroll
 * batches and sales batches with nothing asking which project that URL names; the SQL apply step
 * printed `current_database()`, which answers "postgres" on staging and production alike, so a
 * production URL sitting in the staging variable applied with nothing on screen to say so.
 */
export async function runSupabaseWriteTargetGuardTests() {
  // 0. One source for the two refs: the doctor's pair, which tests/supabase-project-refs.test.ts
  //    holds against AGENTS.md section 3. A second hardcoded copy here could go stale unnoticed.
  assert.equal(PRODUCTION_PROJECT_REF, PRODUCTION_REF);
  assert.equal(STAGING_PROJECT_REF, STAGING_REF);
  assert.notEqual(PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF);

  // 1. The three URL shapes this repo uses all name their project.
  assert.equal(projectRefFromUrl(`https://${PRODUCTION_PROJECT_REF}.supabase.co`), PRODUCTION_PROJECT_REF);
  assert.equal(projectRefFromUrl(`https://${STAGING_PROJECT_REF}.supabase.co/`), STAGING_PROJECT_REF);
  assert.equal(
    projectRefFromUrl(`postgres://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`),
    STAGING_PROJECT_REF,
    "the direct database URL names its project in the db.<ref> host",
  );
  assert.equal(
    projectRefFromUrl(`postgresql://postgres.${PRODUCTION_PROJECT_REF}:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`),
    PRODUCTION_PROJECT_REF,
    "the pooler URL names its project in the postgres.<ref> user",
  );
  for (const nothing of ["", "   ", "https://example.com", "postgres://postgres:pw@localhost:54322/postgres", null, undefined]) {
    assert.equal(projectRefFromUrl(nothing), null, `${String(nothing)} names no project — never a guessed one`);
  }

  // 2. The staging-only guard passes staging and refuses EVERYTHING else, production by name.
  assert.equal(
    requireStagingSupabase("t", { NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_PROJECT_REF}.supabase.co` }),
    STAGING_PROJECT_REF,
  );
  assert.equal(
    requireStagingSupabase("t", { SUPABASE_URL: `https://${STAGING_PROJECT_REF}.supabase.co` }),
    STAGING_PROJECT_REF,
    "SUPABASE_URL is read when NEXT_PUBLIC_SUPABASE_URL is absent, as getSupabaseAdmin reads it",
  );
  assert.throws(
    () => requireStagingSupabase("t", { NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co` }),
    /names PRODUCTION/,
    "a production URL is refused and named as production",
  );
  assert.throws(() => requireStagingSupabase("t", {}), /names no Supabase project/, "no URL at all is refused");
  assert.throws(
    () =>
      requireStagingSupabase("t", {
        NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
        SUPABASE_URL: `https://${STAGING_PROJECT_REF}.supabase.co`,
      }),
    /names PRODUCTION/,
    "NEXT_PUBLIC_SUPABASE_URL wins, exactly as the client reads it, so a staging SUPABASE_URL cannot vouch for it",
  );

  // 3. Each fixture runner asks BEFORE its first client exists. Pinned against the source because
  //    the order is the whole guarantee: a call placed after getSupabaseAdmin() still passes every
  //    behavioural test of the guard and protects nothing.
  for (const phase of [15, 16, 17]) {
    const source = await readFile(new URL(`../scripts/phase${phase}-disposable-fixture-smoke.ts`, import.meta.url), "utf8");
    const guardAt = source.indexOf(`requireStagingSupabase("phase${phase}-disposable-fixture-smoke");`);
    const clientAt = source.indexOf("= getSupabaseAdmin();");
    assert.notEqual(guardAt, -1, `phase ${phase} fixture smoke must call requireStagingSupabase`);
    assert.notEqual(clientAt, -1, `phase ${phase} fixture smoke still creates its client — this pin cannot silently stop checking`);
    assert.ok(guardAt < clientAt, `phase ${phase} fixture smoke must refuse BEFORE getSupabaseAdmin() runs`);
    assert.ok(source.indexOf("loadLocalEnv();") < guardAt, `phase ${phase} must load .env.local before it judges the URL`);
  }

  // 4. The SQL apply step compares the URL's project with the argument before it connects, and
  //    reports the ref, never current_database().
  const apply = await readFile(new URL("../scripts/apply-sql-file.mjs", import.meta.url), "utf8");
  const refusalAt = apply.indexOf("if (urlRef !== expectedRef) {");
  const connectAt = apply.indexOf("const sql = postgres(");
  assert.notEqual(refusalAt, -1, "apply-sql-file must compare the URL's project ref with the environment argument");
  assert.notEqual(connectAt, -1, "apply-sql-file still opens its connection with postgres(...) — this pin cannot silently stop checking");
  assert.ok(refusalAt < connectAt, "the project check must come before the connection opens");
  assert.ok(!apply.includes("select current_database()"), "current_database() answers 'postgres' on both projects — never print it as the target");
}
