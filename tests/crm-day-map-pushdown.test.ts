import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mergeDayMapVisitPages } from "../src/lib/attendance/crm-day-maps.ts";

/**
 * THE ATTENDANCE CRM DAY MAP MUST FETCH ONLY THE WANTED PEOPLE'S ROWS, NOT THE WHOLE COMPANY.
 *
 * Profiled 2026-08-14: `scanCompanyVisitsByEmployee` scanned EVERY company visit for the window and
 * discarded all but the wanted employees' rows in JS. The per-employee day report asks for exactly
 * one hr id ([hrId]) yet paged through ~18k company rows (keyset, 1,000/page, ~19 round trips for a
 * month) to keep ~20 — the heaviest live-traffic CRM read (434.7s / 0.77% of DB time). The fix reads
 * only the wanted people's rows via the existing (agent_hr_id, visit_date) / (double_hr_id,
 * visit_date) indexes — once as the agent, once as the double — and merges them (single-employee
 * month: 28.1ms company scan -> 2.7ms index read, proven on production).
 *
 * The merge is the ONLY new logic that could move output, so it is pinned here: it must return
 * exactly what a single company-wide keyset scan returned — one row per visit id, id-ascending — so
 * the unchanged downstream classification counts and the order-sensitive `describeCrmDay` first-match
 * label never shift. (Set-level equivalence of old vs new was also proven live on production:
 * old_n == new_n and zero rows different in either direction, including 846 both-roles-wanted rows.)
 */

type Row = { id: string; role: string };

function ids(rows: ReadonlyArray<{ id: string }>): string[] {
  return rows.map((row) => row.id);
}

export function runCrmDayMapPushdownTests() {
  // ---- ONE ROW PER VISIT ID, id-ASCENDING -----------------------------------
  // A single company-wide keyset scan returns each visit once, ordered by id asc. The two-read merge
  // must reproduce that exactly, regardless of the order the two reads arrive in.
  const agentPage: Row[] = [
    { id: "d", role: "agent" },
    { id: "b", role: "agent" },
    { id: "a", role: "agent" },
  ];
  const doublePage: Row[] = [
    { id: "c", role: "double" },
    { id: "b", role: "double" }, // the SAME visit — this person is both agent and double on it
    { id: "e", role: "double" },
  ];
  const merged = mergeDayMapVisitPages<Row>([agentPage, doublePage]);
  assert.deepEqual(
    ids(merged),
    ["a", "b", "c", "d", "e"],
    "merge must be one row per id, sorted id-ascending — the exact shape a single keyset scan produces",
  );

  // ---- A BOTH-ROLES VISIT IS COUNTED ONCE, NOT TWICE ------------------------
  // id 'b' is in both pages (agent AND double both wanted). The old full scan carried that visit
  // once; duplicating it would double every per-day count and could flip a describeCrmDay winner.
  assert.equal(
    merged.filter((row) => row.id === "b").length,
    1,
    "a visit whose agent and double are both wanted must appear once, matching the single-scan row set",
  );
  assert.equal(
    merged.find((row) => row.id === "b")?.role,
    "agent",
    "the first page's copy is kept for a duplicate id — deterministic (and the two copies are the same visit)",
  );

  // ---- AGENT-ONLY AND DOUBLE-ONLY ROWS BOTH SURVIVE -------------------------
  assert.ok(ids(merged).includes("a"), "an agent-only visit must be kept — the person was the agent");
  assert.ok(ids(merged).includes("e"), "a double-only visit must be kept — the person rode along as the double");

  // ---- DEGENERATE INPUTS ----------------------------------------------------
  assert.deepEqual(mergeDayMapVisitPages<Row>([]), [], "no pages -> no rows");
  assert.deepEqual(mergeDayMapVisitPages<Row>([[], []]), [], "empty pages -> no rows");
  assert.deepEqual(
    ids(mergeDayMapVisitPages<Row>([[{ id: "z", role: "agent" }]])),
    ["z"],
    "a single page passes through, still id-ordered",
  );

  // ---- SOURCE GUARD: THE PUSHDOWN MUST STAY WIRED ---------------------------
  // Both paths return the same rows, so a revert to a single company-wide scan for a bounded caller
  // is invisible to any behavioural test here — only the query strategy differs. Guard it at the
  // source, like the CRM connector's N+1 guard. Plain string checks, deliberately not a regex over
  // match-anything — a quantifier over `[\s\S]` is the classic ReDoS shape, banned here on sight.
  const source = readFileSync(
    new URL("../src/lib/attendance/crm-day-maps.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.includes("queryVisits") && source.includes("agentHrIds") && source.includes("doubleHrIds"),
    "the day map must fetch by index — queryVisits with agentHrIds AND doubleHrIds — not a company-wide scan of every visit",
  );
  assert.ok(
    source.includes("DAY_MAP_PUSHDOWN_MAX_IDS") && source.includes("scanVisitsForRange"),
    "the whole-company fallback (scanVisitsForRange above the id threshold) must remain so large callers never regress",
  );
  assert.ok(
    source.includes("return mergeDayMapVisitPages"),
    "the two index reads must be combined through mergeDayMapVisitPages so the merged row set matches a single scan",
  );

  // A MANAGER'S OWN SINGLE VISITS ARE A WORKED DAY (owner, 2026-10-19: "proof he worked the day"; 6 Nov
  // 2026: his own visits count to him). They live in phoenix_crm_manager_visits, outside the CRM door and
  // the work-evidence read, so the day map reads them itself — into the field-visit cancel only.
  assert.ok(
    source.includes("loadManagerOwnVisitDays({ end: input.dateToIso, managerHrIds: input.employeeHrIds, start: input.dateFromIso })"),
    "the day map reads the wanted people's own manager visits for the window",
  );
  const foldAt = source.indexOf("for (const day of managerOwnDays)");
  assert.ok(foldAt > 0, "and folds them in");
  const ownFold = source.slice(foldAt, source.indexOf("return { detailMap, fieldVisitMap, leaveMap };", foldAt));
  for (const line of [
    "if (day.visits <= 0) continue;",
    "if (!hrId || !wantedAttendanceKeys.has(hrId)) continue;",
    "fieldVisitMap.set(hrId, fieldDates);",
  ]) {
    assert.ok(ownFold.includes(line), `only a day with a visit, only a wanted person, and only into the field-visit cancel: ${line}`);
  }
  assert.ok(!ownFold.includes("leaveMap"), "never into the leave map");
}
