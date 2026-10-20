import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  candidatePoolCountsFromTotals,
  countCandidatePoolStatuses,
  notACvCandidateIds,
} from "../src/lib/recruitment/pool-enrichment.ts";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

/** The body of one exported function, from its signature to the next top-level export. */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must still exist`);
  const next = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, next === -1 ? undefined : next);
}

// The Recruitment page made ~79 database requests per load (counted from its loaders, 2026-10-16),
// and 41 of them were three loops walking the pool's ids a hundred at a time. These tests pin the
// reads that replaced them: what they decide on plain arrays, and the order they start in.
export async function runRecruitmentPoolRoundTripsTests() {
  // ── 1 · The pool's piles, counted from the pool's own rows ──────────────────────────────────────
  // The dashboard's six `head` counts are gone from the page, so the rows must give the SAME answer
  // the database did: each of five statuses matched exactly, `new` as the remainder.
  const statuses = [
    "new",
    "new",
    "shortlisted",
    "shortlisted",
    "shortlisted",
    "backup",
    "sent_to_manager",
    "sent_to_manager",
    "rejected",
    "hired",
    // A legacy free-text status, an upper-cased one and a missing one match none of the five piles,
    // so — exactly as `.eq("status", …)` would — they fall into the remainder, i.e. `new`.
    "Reviewed by phone",
    "Shortlisted",
    null,
    undefined,
  ];
  const counts = countCandidatePoolStatuses(statuses);
  assert.deepEqual(
    counts,
    { backup: 1, hired: 1, new: 6, rejected: 1, sent_to_manager: 2, shortlisted: 3 },
    "five exact piles, and everything else is the undecided remainder",
  );
  assert.equal(
    Object.values(counts).reduce((sum, value) => sum + value, 0),
    statuses.length,
    "the six piles add back up to the pool, so no candidate is counted twice or not at all",
  );
  assert.deepEqual(
    counts,
    candidatePoolCountsFromTotals({ backup: 1, hired: 1, rejected: 1, sentToManager: 2, shortlisted: 3, total: statuses.length }),
    "counting rows and counting with six head requests are one rule, so they cannot disagree",
  );
  assert.deepEqual(
    countCandidatePoolStatuses([]),
    { backup: 0, hired: 0, new: 0, rejected: 0, sent_to_manager: 0, shortlisted: 0 },
    "an empty pool is six zeros",
  );
  assert.equal(
    candidatePoolCountsFromTotals({ backup: 5, hired: 5, rejected: 5, sentToManager: 5, shortlisted: 5, total: 3 }).new,
    0,
    "the remainder never goes negative when the piles were counted a moment after the total",
  );

  // ── 2 · The Not-a-CV verdict, from the whole table in whatever order it arrives ──────────────────
  const row = (id: string, candidate: string, createdAt: string, isCv: boolean | null) => ({
    candidate_id: candidate,
    created_at: createdAt,
    id,
    is_cv: isCv,
  });
  assert.deepEqual(
    [...notACvCandidateIds([row("a", "c1", "2026-09-01T10:00:00+00:00", false)])],
    ["c1"],
    "an explicit false is the verdict",
  );
  assert.equal(
    notACvCandidateIds([row("a", "c1", "2026-09-01T10:00:00+00:00", null)]).size,
    0,
    "NULL is no judgement on record and must never flag a row",
  );
  // The newest row decides, in either arrival order — the table is read in id order now, where the
  // batched read arrived newest first, so the answer must not lean on the order.
  const olderNo = row("a", "c1", "2026-09-01T10:00:00+00:00", false);
  const newerYes = row("b", "c1", "2026-09-05T10:00:00+00:00", true);
  assert.equal(notACvCandidateIds([olderNo, newerYes]).size, 0, "a later read that found a CV overrules an older no");
  assert.equal(notACvCandidateIds([newerYes, olderNo]).size, 0, "…whichever row the walk meets first");
  const olderYes = row("a", "c2", "2026-09-01T10:00:00+00:00", true);
  const newerNo = row("b", "c2", "2026-09-05T10:00:00+00:00", false);
  assert.deepEqual([...notACvCandidateIds([newerNo, olderYes])], ["c2"], "a later no overrules an older yes");
  assert.deepEqual([...notACvCandidateIds([olderYes, newerNo])], ["c2"]);
  // Two spellings of one instant are one instant, not two rows to choose between by text.
  assert.deepEqual(
    [...notACvCandidateIds([row("a", "c3", "2026-09-01T12:00:00+02:00", true), row("b", "c3", "2026-09-01T10:00:00+00:00", false)])],
    ["c3"],
    "the same moment in two offsets ties, and the larger id then decides",
  );
  assert.equal(
    notACvCandidateIds([row("z", "c4", "not a date", false), row("a", "c4", "2026-09-01T10:00:00+00:00", true)]).size,
    0,
    "a stamp that cannot be parsed sorts oldest and can never overrule a real one",
  );
  assert.equal(
    notACvCandidateIds([{ created_at: "2026-09-01T10:00:00+00:00", id: "a", is_cv: false }]).size,
    0,
    "a row with no candidate is ignored, not filed under an empty key",
  );

  // ── 3 · The reads start BEFORE the pool, and the page counts from the pool ──────────────────────
  const candidates = read("src/lib/recruitment/candidates.ts");
  const listCandidates = bodyOf(candidates, "export async function listCandidates(");
  const sourceStart = listCandidates.indexOf("const sourceContextLoad = loadSourceContextForWholePool();");
  const verdictStart = listCandidates.indexOf("const notACvLoad = loadNotACvCandidates();");
  const poolRead = listCandidates.indexOf("await selectEveryCandidateRow(");
  assert.ok(sourceStart >= 0 && verdictStart >= 0, "listCandidates must start both whole-table reads");
  assert.ok(
    sourceStart < poolRead && verdictStart < poolRead,
    "both must START before the pool read is awaited — started after it, they are a wait at the front of the longest chain on the page",
  );
  assert.ok(
    listCandidates.includes("attachAppliedFor(candidates, { sourceContext: sourceContextLoad })"),
    "the intake context must be the walk started above, not a second read of the pool's ids",
  );
  assert.ok(
    !/loadNotACvCandidates\(\s*candidates/.test(listCandidates) &&
      !/loadSourceContextByCandidate\(/.test(listCandidates),
    "listCandidates must not walk the pool's ids in batches for either read again",
  );
  // Neither whole-table walk may reject into an unawaited promise: a failed pool read leaves them
  // unawaited, and a rejection with no handler is a crashed process.
  for (const loader of ["loadNotACvCandidates", "loadSourceContextForWholePool"]) {
    const start = candidates.indexOf(`async function ${loader}(`);
    assert.ok(start >= 0, `${loader} must exist`);
    const end = candidates.indexOf("\n}\n", start);
    assert.match(
      candidates.slice(start, end),
      /\}\s*catch\s*(\([^)]*\))?\s*\{/,
      `${loader} must catch inside — it is started before the pool and may never be awaited`,
    );
  }
  assert.match(
    candidates,
    /cursorColumn: "candidate_id"[\s\S]{0,200}?\}\s*,?\s*\)/,
    "the intake view is walked by keyset on its unique candidate_id, so a CV arriving mid-read cannot repeat or skip a row",
  );
  assert.ok(candidates.includes('cursorColumn: "id"'), "the verdict table is walked by keyset on its primary key");

  const dashboard = read("src/lib/recruitment/dashboard.ts");
  const dashboardCall = bodyOf(dashboard, "export async function getRecruitmentDashboard(");
  assert.ok(
    dashboardCall.includes("options.candidatePoolCounts ? await options.candidatePoolCounts : null") &&
      dashboardCall.includes("?? getCandidatePoolCounts()"),
    "given counts the dashboard makes no head requests, and a null (the pool failed) falls back to them rather than to nothing",
  );
  assert.ok(
    dashboard.includes("candidatePoolCountsFromTotals({ backup, hired, rejected, sentToManager, shortlisted, total })"),
    "the head-count path and the row-count path share one remainder rule",
  );

  for (const page of ["app/(admin)/recruitment/previous/page.tsx", "app/employee-portals/recruitment/page.tsx"]) {
    const source = read(page);
    assert.match(
      source,
      /const candidatePoolCounts = canViewCandidates\s*\?\s*poolLoad\.then\(\(pool\) => \(pool\.ok \? countCandidatePoolStatuses\(pool\.rows\.map\(\(row\) => row\.status\)\) : null\)\)\s*:\s*undefined;/,
      `${page}: counts come from the pool, only for a viewer who reads it, and null when the pool failed`,
    );
    assert.ok(
      source.includes("getRecruitmentDashboard(access, candidatePoolCounts ? { candidatePoolCounts } : {})"),
      `${page}: a viewer who may not read candidates holds an empty list, which would count as an empty pool — it must not be handed to the dashboard`,
    );
  }

  // ── 4 · One request for a lookup table, not a name request and a code request ────────────────────
  const vacancies = read("src/lib/reports/vacancies.ts");
  assert.ok(
    !vacancies.includes("loadCodeLookup") && vacancies.includes('select: "id,name,code"'),
    "lines and areas are read once each for their name and their code",
  );
  const lookupCalls = vacancies.match(/loadNameAndCodeLookup\("(lines|areas)"/g) ?? [];
  assert.equal(lookupCalls.length, 2, "exactly one combined read each for lines and for areas");
}
