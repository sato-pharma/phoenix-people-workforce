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
  //
  // THIS SECTION OVERTURNS AN EARLIER DECISION IN THIS FILE, ON PURPOSE.
  //
  // It used to assert the SQL must NOT contain `to_tsquery` or `@@`, with a stated reason: "a
  // recruiter types 'cardio' and a lexeme match would find nothing while the candidate sits there
  // with 'Cardiology' in their skills". That reason was RIGHT, and it is why the search stayed on
  // ILIKE.
  //
  // The substring match it protected also cost two things, measured on production 2026-09-05:
  // "managing" found 15 candidates and "managed" found 8, neither reaching somebody who wrote
  // "manager"; and "rep" matched 395 because '%rep%' also hits "prepare" and "reporting".
  //
  // Appending `:*` to the final lexeme answers the original objection instead of ignoring it —
  // "cardio" becomes a PREFIX and finds "Cardiology" again. Measured on staging, same corpus:
  // cardio 4 before, 1 with plain lexemes, 4 with the prefix. So the assertion below is no longer
  // "never use tsvector"; it is "cardio must still find Cardiology", which is what was actually
  // being defended.

  // The migration that defines the function TODAY. Two files now touch it; this is the later one,
  // and reading the earlier one would pin a body that no longer runs.
  const searchMigration = read("supabase/migrations/20260905181500_cv_search_short_terms_are_words.sql");
  const indexMigration = read("supabase/migrations/20260905174500_cv_search_uses_an_index.sql");
  const corpusMigration = read("supabase/migrations/20260905080000_cv_content_search.sql");

  // Executable SQL only. This file EXPLAINS in prose why it does not use `to_tsquery`, and a naive
  // scan for that word fails on a correct migration - the fourth time in this module a comment has
  // been mistaken for a declaration.
  const sqlOnly = (text: string) =>
    text
      .split(String.fromCharCode(10))
      .map((line) => {
        const idx = line.indexOf("--");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join(" ");
  const searchSql = sqlOnly(searchMigration);
  assert.ok(searchSql.includes("create or replace function"), "the strip must leave the SQL behind");

  // A SHORT term is the WORD; a longer one still prefixes. Owner's decision 2026-09-05: `rep`
  // matched 401 of 745 candidates - over half the pool - on "prepare" and "reporting", and a
  // plain prefix rule kept 382 of them because `rep:*` still reaches "representative".
  assert.ok(
    searchSql.includes("[1]) >= 4"),
    "a term shorter than four characters must match the WORD, not a prefix - otherwise the noise "
      + "the owner asked to remove survives",
  );

  // THE CONCERN THE OLD RULE DEFENDED: a partial word must still match.
  assert.match(
    searchSql,
    /base::text \|\| ':\*'/,
    "the final lexeme must be a PREFIX - without it 'cardio' stops finding 'Cardiology', which is "
      + "exactly why this search was kept on ILIKE in the first place",
  );
  assert.match(
    searchSql,
    /case\s+when base::text = '' then base/,
    "and the prefix may only be appended to a NON-EMPTY query - ':*' alone is not a valid tsquery "
      + "and the cast would raise, turning an empty search box into a 500",
  );

  // websearch, never to_tsquery: the raw parser throws on punctuation a person types by accident.
  assert.match(searchSql, /websearch_to_tsquery\('english'/, "the forgiving parser, not the raw one");
  assert.doesNotMatch(
    searchSql,
    /[^_]to_tsquery\('english', coalesce\(btrim\(p_query/,
    "p_query must never reach to_tsquery directly - 'sales & marketing' and '!!!' would raise",
  );

  // EVERY term, not any - unchanged in meaning, new in mechanism.
  assert.doesNotMatch(searchSql, /bool_or\(|\|\|'\s*\|\s*'/, "an OR match must never appear here");

  // An empty or unusable query returns NOTHING, not everything.
  assert.match(
    searchSql,
    /q\.tsq != ''::tsquery/,
    "an empty query returns NOTHING - 'search for nothing' must never read as 'here is everyone'",
  );

  // The newest reading only - a re-extraction adds a row rather than replacing one.
  assert.match(
    searchSql,
    /select distinct on \(e\.candidate_id\) e\.candidate_id, e\.created_at/,
    "the NEWEST extraction per candidate, or somebody matches on a superseded reading",
  );

  // Ranked, so the cap keeps the BEST rows rather than an arbitrary slice.
  assert.match(
    searchSql,
    /order by ts_rank\(m\.search_tsv, q\.tsq\) desc/,
    "results must be ranked - the caller caps at 200 and reports truncation, so an unordered cut "
      + "tells a recruiter they are missing an unknown set rather than the tail",
  );

  // The snippet says WHY, and obeys the house rules on text.
  assert.match(searchSql, /ts_headline\(/, "matched_on must be the matching text, not the first 160 characters");
  assert.match(
    searchMigration,
    /FragmentDelimiter=" · "/,
    "fragments are joined with the house separator - never an ellipsis, which is banned for text",
  );
  assert.doesNotMatch(searchMigration, /FragmentDelimiter="[^"]*(…|\.\.\.)/, "no ellipsis in the delimiter");
  assert.match(
    searchSql,
    /StartSel="", StopSel=""/,
    "no markup in the snippet - the caller renders it as plain text and ts_headline's default <b> "
      + "tags would appear literally on screen",
  );

  // The index is what makes this worth doing, and it must be GENERATED so it cannot drift.
  assert.match(
    sqlOnly(indexMigration),
    /generated always as \(\s*to_tsvector\('english', public\.ats_candidate_cv_search_text\(extracted_fields\)\)\s*\) stored/,
    "the column must be GENERATED from the SAME corpus function the old search used - a trigger "
      + "could drift, and a different corpus would silently change what the search covers",
  );
  assert.match(sqlOnly(indexMigration), /using gin \(search_tsv\)/, "and the GIN index is the point of the exercise");

  // Authority, restated in the file that now defines the function.
  assert.doesNotMatch(searchSql, /security definer/i, "this reads CV contents for the whole pool");
  assert.match(searchSql, /set search_path to ''/, "an empty search_path, as the house style does");
  assert.ok(
    searchMigration.includes("revoke execute on function public.ats_search_candidate_cvs(text, integer) from public, anon, authenticated;"),
    "EXECUTE must be revoked from PUBLIC - a function in `public` inherits the default grant, and "
      + "this one returns candidate ids for any keyword",
  );
  assert.ok(
    searchMigration.includes("grant execute on function public.ats_search_candidate_cvs(text, integer) to service_role;"),
    "and granted back to service_role - revoking PUBLIC strips it too",
  );

  // The CORPUS is untouched, and its own guard still stands in the migration that defines it.
  assert.match(
    corpusMigration,
    /string_agg\(s ->> 'name', ' '\)/,
    "skills are still pulled out by name - casting the raw JSON would make EVERY candidate match "
      + "the word 'name'",
  );
  assert.doesNotMatch(
    sqlOnly(indexMigration),
    /ats_cv_extraction_search_text/,
    "there must be ONE corpus function. A second one was written and dropped the same day: it "
      + "included address and professionalSummary, which moved 'cairo' from 71 hits to 289 - a "
      + "different search wearing the same name",
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
