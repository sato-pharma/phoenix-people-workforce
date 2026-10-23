import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { checkinAgentKey } from "../src/lib/crm/checkin-match.ts";
import type { DoctorCoverageScope } from "../src/lib/crm/doctor-coverage-roles.ts";
import { isAgentInScope } from "../src/lib/crm/doctor-coverage-roles.ts";
import { KPI_NARROW_MAX_CRM_IDS, resolveRepKeyAgents, type KpiBoardAgentReaders, type KpiBoardAgents } from "../src/lib/crm/kpi-board-agents.ts";
import { narrowPhoenixKpiReads, phoenixHrKeyByCrmId, phoenixRowKey, type PhoenixKpiNarrowing } from "../src/lib/crm/phoenix-kpi-data.ts";
import { expandHrIdFilterValues } from "../src/lib/crm/reads.ts";
import { canonicalHrIdKey, hrIdAliasSources } from "../src/lib/hr-id.ts";

/**
 * THE PHOENIX KPI LOADER READS ONLY ITS SCOPE'S REPS, AND KEEPS EVERY ROW THE COMPANY-WIDE READ CREDITED
 * TO THEM (2026-10-23).
 *
 * It read the whole company's month of plans, visits and check-ins on every KPIs board load — about 66
 * requests to the unified CRM views for one rep's landing tile. A narrowed read is only right if it
 * holds every row `phoenixRowKey` gives an in-scope rep, every row of that rep's agent (the duplicate
 * collapse keys on the agent) and every check-in one of his visits can match. This selects fixture rows
 * the way the SQL filter does (`agent_crm_id IN (…) OR agent_hr_id IN (every casing)`) and checks each
 * of those against the company-wide rows, for the shapes that are easy to get wrong: a vendor row with
 * no hr id placed only by the contact list, a native rep with no CRM id, a mixed-case hr id, a legacy
 * alias, a CRM id the contact list gives to SOMEONE ELSE, and a check-in with no hr id.
 */

type Row = { agent_crm_id: number | null; agent_hr_id: string | null };

const agentsScope = (hrIds: string[]): DoctorCoverageScope => ({ kind: "agents", agentHrIds: hrIds }) as DoctorCoverageScope;

/** The panel: B-1 owns CRM 101, B-2 owns 202, the native rep B-3 has none, Dr AA owns 303. */
const PANEL: Row[] = [
  { agent_crm_id: 101, agent_hr_id: "B-1" },
  { agent_crm_id: 202, agent_hr_id: "B-2" },
  { agent_crm_id: null, agent_hr_id: "B-3" },
  { agent_crm_id: 303, agent_hr_id: "AA" },
];

/** Company-wide rows of one door (plans and visits share the shape that matters here). */
const ROWS: Row[] = [
  { agent_crm_id: 101, agent_hr_id: "B-1" },
  { agent_crm_id: 101, agent_hr_id: null }, // vendor row, placed only by the contact list
  { agent_crm_id: 101, agent_hr_id: "" },
  { agent_crm_id: 909, agent_hr_id: "b-1" }, // a second CRM slot, his hr id in another casing
  { agent_crm_id: 909, agent_hr_id: null }, // its blank-hr sibling: the collapse must see it
  { agent_crm_id: 202, agent_hr_id: "B-2" },
  { agent_crm_id: 202, agent_hr_id: null },
  { agent_crm_id: null, agent_hr_id: "B-3" }, // native rep, no CRM id
  { agent_crm_id: null, agent_hr_id: "b-3" }, // (no stored hr id carries whitespace: 0 rows in all four tables, 2026-10-23)
  { agent_crm_id: 303, agent_hr_id: "AAA" }, // stored under the legacy alias
  { agent_crm_id: 303, agent_hr_id: null },
  { agent_crm_id: 404, agent_hr_id: null }, // nobody's
];

const CHECKINS: Row[] = [
  { agent_crm_id: 101, agent_hr_id: null },
  { agent_crm_id: 909, agent_hr_id: null },
  { agent_crm_id: null, agent_hr_id: "B-3" },
  { agent_crm_id: 202, agent_hr_id: null },
  { agent_crm_id: 303, agent_hr_id: null },
  { agent_crm_id: 404, agent_hr_id: null },
];

/** The discovery kpi-board-agents.ts does: every CRM id an in-scope hr id's own rows carry. */
function discoverFrom(rows: readonly Row[]) {
  return async (scope: DoctorCoverageScope): Promise<KpiBoardAgents | null> => {
    if (scope.kind !== "agents") return null;
    const hrIds = scope.agentHrIds.filter((id) => id.trim().length > 0);
    const keys = new Set(expandHrIdFilterValues(hrIds));
    const crmIds = new Set<number>();
    for (const row of rows) if (row.agent_hr_id != null && keys.has(row.agent_hr_id) && row.agent_crm_id != null) crmIds.add(row.agent_crm_id);
    return { crmIds: [...crmIds].sort((a, b) => a - b), hrIds };
  };
}

/** What `agent_crm_id IN (…) OR agent_hr_id IN (every casing)` returns. */
function selectedBy(narrowing: PhoenixKpiNarrowing, rows: readonly Row[]): Row[] {
  const crmIds = new Set(narrowing.crmIds);
  const hrKeys = new Set(expandHrIdFilterValues(narrowing.hrIds));
  return rows.filter((row) => (row.agent_crm_id != null && crmIds.has(row.agent_crm_id)) || (row.agent_hr_id != null && hrKeys.has(row.agent_hr_id)));
}

export async function runPhoenixKpiNarrowingTests() {
  const hrKeyByCrmId = phoenixHrKeyByCrmId(PANEL);
  assert.equal(hrIdAliasSources("AA").join(","), "aaa", "the legacy alias is found from the live id");
  assert.deepEqual(hrIdAliasSources("B-1"), [], "most ids have no alias");

  // ── 1. Every row the company-wide read credits to a scoped rep is in the narrowed read ─────────
  for (const scopeIds of [["B-1"], ["B-3"], ["b-2"], ["AA"], ["B-1", "B-3"], ["B-2", "AA", "B-3"]]) {
    const scope = agentsScope(scopeIds);
    const narrowing = await narrowPhoenixKpiReads({ scope, window: { from: "2026-10-01", to: "2026-10-31" }, panelRows: PANEL }, discoverFrom(ROWS));
    assert.ok(narrowing, `${scopeIds.join("+")}: a small scope is narrowed`);
    const kept = new Set(selectedBy(narrowing, ROWS));
    const credited = ROWS.filter((row) => {
      const key = phoenixRowKey(hrKeyByCrmId, row.agent_hr_id, row.agent_crm_id);
      return key != null && isAgentInScope(scope, key);
    });
    for (const row of credited) assert.ok(kept.has(row), `${scopeIds.join("+")}: row ${JSON.stringify(row)} is credited and must be read`);

    // The same rows, judged by the same gate, are exactly the credited ones.
    const keptCredited = [...kept].filter((row) => {
      const key = phoenixRowKey(hrKeyByCrmId, row.agent_hr_id, row.agent_crm_id);
      return key != null && isAgentInScope(scope, key);
    });
    assert.deepEqual(keptCredited, credited, `${scopeIds.join("+")}: the gate leaves the same rows`);

    // Every row of a credited row's agent, so the duplicate collapse sees what it saw before.
    const creditedAgents = new Set(credited.map((row) => row.agent_crm_id).filter((id) => id != null));
    for (const row of ROWS) {
      if (row.agent_crm_id != null && creditedAgents.has(row.agent_crm_id)) assert.ok(kept.has(row), `${scopeIds.join("+")}: agent ${row.agent_crm_id}'s every row is read`);
    }

    // Every check-in a credited visit can match (its CRM id, else its hr id).
    const visitKeys = new Set(
      credited.map((row) => checkinAgentKey(row.agent_crm_id, row.agent_hr_id)).filter((key): key is string => key != null),
    );
    const keptCheckins = new Set(selectedBy(narrowing, CHECKINS));
    for (const checkin of CHECKINS) {
      const key = checkinAgentKey(checkin.agent_crm_id, checkin.agent_hr_id);
      if (key != null && visitKeys.has(key)) {
        assert.ok(keptCheckins.has(checkin), `${scopeIds.join("+")}: check-in ${JSON.stringify(checkin)} matches a scoped visit and must be read`);
      }
    }
  }

  // The vendor row with no hr id is found by the contact list's CRM id alone.
  const onlyPanel = await narrowPhoenixKpiReads(
    { scope: agentsScope(["B-2"]), window: { from: "2026-10-01", to: "2026-10-31" }, panelRows: PANEL },
    async () => ({ crmIds: [], hrIds: ["B-2"] }),
  );
  assert.deepEqual(onlyPanel?.crmIds, [202], "the contact list's CRM id is read even when no row of it carries his hr id");
  assert.ok(
    (await narrowPhoenixKpiReads({ scope: agentsScope(["AA"]), window: { from: "2026-10-01", to: "2026-10-31" }, panelRows: PANEL }, discoverFrom(ROWS)))?.hrIds.includes("aaa"),
    "rows stored under a legacy alias are asked for",
  );

  // ── 2. Anything doubtful reads company-wide ───────────────────────────────────────────────────
  const window = { from: "2026-10-01", to: "2026-10-31" };
  assert.equal(await narrowPhoenixKpiReads({ scope: { kind: "company" } as DoctorCoverageScope, window, panelRows: PANEL }, discoverFrom(ROWS)), null, "a company scope is not narrowed");
  assert.equal(await narrowPhoenixKpiReads({ scope: agentsScope(["B-1"]), window, panelRows: PANEL }, async () => null), null, "a discovery that gave up reads company-wide");
  const wide = Array.from({ length: KPI_NARROW_MAX_CRM_IDS + 1 }, (_, index) => 5000 + index);
  assert.equal(
    await narrowPhoenixKpiReads({ scope: agentsScope(["B-1"]), window, panelRows: PANEL }, async () => ({ crmIds: wide, hrIds: ["B-1"] })),
    null,
    "too many CRM ids for one request reads company-wide",
  );
  assert.deepEqual(
    await narrowPhoenixKpiReads({ scope: agentsScope([]), window, panelRows: PANEL }, async () => ({ crmIds: [], hrIds: [] })),
    { crmIds: [], hrIds: [] },
    "a scope that names nobody reads nobody, as the company-wide read showed it",
  );
  assert.equal(canonicalHrIdKey("AAA"), "aa");

  // ── 3. The loader and the board are wired to it ───────────────────────────────────────────────
  const loader = readFileSync(new URL("../src/lib/crm/phoenix-kpi-data.ts", import.meta.url), "utf8");
  assert.equal((loader.match(/\.\.\.people,/g) ?? []).length, 2, "the visit and check-in reads both take the narrowing");
  assert.match(loader, /scanPlanEntries\(input\.month\.start, input\.month\.end, \{ agentCrmIds: narrowed\.crmIds, agentHrIds: narrowed\.hrIds \}\)\.then\(inPlanEntryOrder\)/);
  const board = readFileSync(new URL("../src/lib/crm/kpis-board.ts", import.meta.url), "utf8");
  assert.match(board, /narrowToScope: !input\.coverageDoctors,/, "the Coverage tab keeps the company-wide read");

  // ── 4. One rep's call-rate page reads that rep's accounts only ───────────────────────────────
  const asked: string[][] = [];
  const readers: KpiBoardAgentReaders = {
    visits: async (filter) => {
      asked.push(filter.agentHrIds);
      return [{ agent_crm_id: 909 }, { agent_crm_id: 101 }];
    },
    plans: async () => [{ agent_crm_id: 101 }],
  };
  assert.deepEqual(await resolveRepKeyAgents("crm:2103", window, readers), { crmIds: [2103], hrIds: [] }, "a CRM account is read by its id alone");
  assert.equal(asked.length, 0, "a CRM account needs no discovery");
  assert.deepEqual(await resolveRepKeyAgents("hr:b-10", window, readers), { crmIds: [101, 909], hrIds: ["b-10"] }, "a person is read with every account his rows carry");
  assert.deepEqual(asked, [["b-10"]]);
  for (const bad of ["", "crm:", "crm:abc", "hr:", "hr:   ", "B-10", "crm:99999999999999999999"]) {
    assert.equal(await resolveRepKeyAgents(bad, window, readers), null, `"${bad}" reads the whole field force`);
  }
  const page = readFileSync(new URL("../src/components/crm/rep-visits-page.tsx", import.meta.url), "utf8");
  assert.match(page, /resolveRepKeyAgents\(repKey, \{ from: range\.dateFrom, to: range\.dateTo \}\)\.catch\(\(\) => null\)/, "a failed discovery reads the whole field force");
  assert.match(page, /loadCallRateReport\(\{ dateFrom: range\.dateFrom, dateTo: range\.dateTo, holidays, reuseRecentWindow: true, \.\.\.\(agents \? \{ agents \} : \{\}\) \}\)/);
}
