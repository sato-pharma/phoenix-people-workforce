import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CV_SEARCH_LIMIT, CV_SEARCH_MIN_LENGTH } from "../src/lib/recruitment/cv-search.ts";

/**
 * Searching what a CV SAYS, not just who sent it.
 *
 * ── THE PLAN'S PREMISE WAS WRONG, AND THE CORRECTION IS THE DESIGN ──────────────────────────────
 *
 * This was planned as "full-text search over extracted CV text", on the premise that the text exists
 * and is merely unsearchable. Measured on production 2026-09-05: there is NO raw CV text anywhere.
 * `ats_candidate_cv_extractions` holds `extracted_fields` jsonb and nothing else; `ats_files` holds
 * metadata while the document lives in Drive.
 *
 * What exists is the structured reading — job title, employer, university, degree, faculty, skills,
 * work history, education — 514 kB across 581 live candidates. Better than raw text here:
 * "cardiology" in a parsed skills list is a fact about the person; in raw text it might be a former
 * employer's letterhead.
 *
 * ── THE FOUR THINGS THIS FILE HOLDS ─────────────────────────────────────────────────────────────
 *
 *   1. SEARCH IS NOT A WAY AROUND THE POOL'S GATE. "Who has cardiology on their CV" returns
 *      candidate ids, which is the pool by another name. Same `candidates: read`, asserted in the
 *      service AND at the route, so a future caller reaching the service another way cannot skip it.
 *   2. EVERY TERM MUST MATCH. "pharmacist cairo" means both. Measured on staging: `pharmacist`
 *      returns 31 and `pharmacist cairo` returns 4. An OR would return most of the pool for any
 *      two-word query and teach the recruiter that search does not work.
 *   3. SUBSTRING, NOT `tsvector`. A recruiter types "cardio", not "cardiology". A lexeme match finds
 *      nothing while the candidate sits there — and a search returning nothing reads as "we have
 *      nobody like that" rather than as a limitation. That is the worst failure this screen has.
 *   4. A TRUNCATED LIST SAYS SO. "pharma" exceeds the cap on production today. A list silently
 *      stopped at 200 reads as a complete answer, and a recruiter who believes they have seen every
 *      match stops looking.
 */
export function runRecruitmentCvSearchTests() {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

  // ── 1 · THE LIMITS ARE REAL VALUES, SHARED WITH THE DATABASE ──────────────────────────────────

  assert.equal(CV_SEARCH_LIMIT, 200, "the cap is 200 — and the SQL function repeats it");
  assert.equal(CV_SEARCH_MIN_LENGTH, 2, "one character matches nearly every CV and means nothing");

  // ── 2 · THE GATE ──────────────────────────────────────────────────────────────────────────────

  const service = read("src/lib/recruitment/cv-search.ts");
  assert.match(
    service,
    /await assertPermission\(access, "candidates", "read"\);/,
    "the service asserts candidates:read BEFORE reading anything — search must never become a way " +
      "around the gate on the pool, because a list of ids IS the pool by another name",
  );
  const route = read("app/api/recruitment/candidates/cv-search/route.ts");
  assert.match(
    route,
    /requireRecruitmentAccess\(request, "candidates", "read"\)/,
    "and the route asserts it too, so an unauthorised caller is refused before a query is built",
  );

  // ── 3 · TRUNCATION IS DETECTED, NOT GUESSED ───────────────────────────────────────────────────
  //
  // Reading exactly `capped` rows cannot tell "exactly 200 matches" from "at least 200". Asking for
  // one more is the only way the answer is a fact.
  assert.match(
    service,
    /p_limit: capped \+ 1,/,
    "the service asks for ONE more than the cap, so `truncated` is measured rather than assumed",
  );
  assert.match(
    service,
    /truncated: hits\.length > capped,/,
    "and truncation is that extra row actually arriving",
  );
  assert.match(
    service,
    /hits: hits\.slice\(0, capped\)/,
    "while the caller still receives only the cap — the probe row is never shown as a result",
  );

  // ── 4 · THE SQL ───────────────────────────────────────────────────────────────────────────────

  const migration = read("supabase/migrations/20260905080000_cv_content_search.sql");
  // THE EXECUTABLE SQL ONLY. Every `doesNotMatch` below must ask the code, not the prose: this
  // file EXPLAINS in its header why it does not use `to_tsquery`, and a naive search for that
  // word fails on a correct migration. That is the fourth time in this module a comment has been
  // mistaken for a declaration, so the strip is done once and reused.
  const migrationSql = migration
    .split(String.fromCharCode(10))
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join(" ");
  assert.ok(migrationSql.includes("create or replace function"), "the strip must leave the SQL behind");
  const headers = [...migration.matchAll(/create or replace function[\s\S]*?as \$\$/g)].map((m) => m[0]);
  assert.equal(headers.length, 2, "both functions must be found — otherwise the checks below ask nothing");
  for (const header of headers) {
    assert.doesNotMatch(
      header,
      /security definer/i,
      "neither function may be SECURITY DEFINER — these read CV contents for the whole pool",
    );
    assert.match(header, /set search_path = ''/, "each pins an empty search_path, as the house style does");
  }

  // EVERY term, not any.
  assert.match(
    migration,
    /bool_and\(h\.body ilike '%' \|\| t \|\| '%'\)/,
    "every term must match — bool_and, never bool_or: 'pharmacist cairo' means both, and an OR " +
      "would return most of the pool for any two-word query",
  );
  assert.doesNotMatch(migrationSql, /bool_or\(/, "an OR match must never appear here");

  // Substring, not lexemes.
  assert.doesNotMatch(
    migrationSql,
    /to_tsquery|plainto_tsquery|websearch_to_tsquery|@@/,
    "substring matching, NOT tsvector — a recruiter types 'cardio' and a lexeme match would find " +
      "nothing while the candidate sits there with 'Cardiology' in their skills",
  );

  // Skill NAMES, never the raw [{"name": ...}] JSON.
  assert.match(
    migration,
    /string_agg\(s ->> 'name', ' '\)/,
    "skills are pulled out by name — casting the raw JSON would make EVERY candidate match the word " +
      "'name', which is exactly what a search for a common word would then return",
  );

  // An empty query returns nothing, not everything.
  assert.match(
    migration,
    /if v_terms is null or cardinality\(v_terms\) = 0 then\s*\n\s*return;/,
    "an empty query returns NOTHING — 'search for nothing' must never read as 'here is everyone'",
  );
  assert.match(
    migration,
    /where length\(t\) > 1/,
    "single-character terms are dropped rather than matching nearly every CV",
  );

  // The newest reading only.
  assert.match(
    migration,
    /select distinct on \(f\.candidate_id\) f\.candidate_id, f\.extracted_fields/,
    "the NEWEST extraction per candidate — a re-extraction writes another row rather than replacing " +
      "one, so without this a candidate could match on a superseded reading",
  );

  // The grant, by name.
  for (const fn of ["ats_candidate_cv_search_text", "ats_search_candidate_cvs"]) {
    assert.ok(
      migration.includes(`revoke execute on function public.${fn}(`),
      `${fn} must revoke EXECUTE — a function in \`public\` inherits the default grant to PUBLIC, ` +
        "and these read CV contents for the whole pool",
    );
    assert.ok(
      migration.includes(`grant execute on function public.${fn}(`),
      `${fn} must be granted back to service_role — revoking PUBLIC strips it too`,
    );
  }
  assert.ok(
    migration.includes("from public, anon, authenticated;"),
    "the revoke names PUBLIC — revoking only anon and authenticated is a no-op, they inherit it",
  );

  // ── 5 · THE SCREEN ────────────────────────────────────────────────────────────────────────────

  const workstation = read("src/components/recruitment/workstation/screening-workstation.tsx");

  // A UNION, not a mode swap.
  assert.match(
    workstation,
    /if \(cvSearch && cvSearch\.query === needle && cvSearch\.ids\.has\(row\.id\)\) return true;/,
    "a CV match ADDS to the text matches rather than replacing them — somebody searching 'pharmacist' " +
      "keeps the people whose job title says it as well as the ones whose CV body does",
  );

  // A stale result cannot survive an edit to the box.
  assert.match(
    workstation,
    /cvSearch\.query === search\.trim\(\)\.toLowerCase\(\)/,
    "the result is honoured only while the box still holds the query it was run for — otherwise " +
      "editing the search would leave matches attached to words nobody typed",
  );

  // It is EXPLICIT, never fired on a keystroke.
  assert.doesNotMatch(
    workstation,
    /useEffect\([^)]*\)\s*=>\s*\{[\s\S]{0,200}searchCvContents\(\)/,
    "the CV search must not run automatically — it is a round trip over half a megabyte, and firing " +
      "it per keystroke would make the instant box feel slow to pay for a search most sessions never run",
  );

  // Truncation reaches the screen.
  assert.match(workstation, /cvSearch\.truncated \?/, "a truncated result says so on screen");
  assert.match(
    workstation,
    /More than \{cvSearch\.ids\.size\} CVs match/,
    "and says it in words a recruiter can act on, not as a silent cut",
  );
}
