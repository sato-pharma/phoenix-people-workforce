import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { getFinanceCommandCenterData } from "../src/lib/finance/command-center.ts";
import { rpcCalls, withPostgrestStandIn, type StandIn } from "./support/postgrest-stand-in.ts";

// REC-079 (phase 2): src/lib/finance — the Finance Manager's landing page data — run, not read.
//
// getFinanceCommandCenterData is called against the shared in-memory PostgREST. Its main rule:
//
//   1. A money source that fails is NAMED as unavailable — never answered with a confident zero the
//      page would print as fact — and one failing source degrades its own section, never the page.
//   2. It re-checks payroll:read itself (the page's gate is not the only one), and a seat without it
//      is refused before any figure is read.
//   3. The aggregate is asked for the caller's own figures over a trend window held to 1–24 months.
//   4. A payroll reader who may not open the finance sheet gets no sheets section, and that is not an
//      error: the sheet status is never asked for him, so nothing is logged or named unavailable.

const FINANCE = createAccessContext({ hrId: "FM-2", loginId: "fm.two", role: "Finance Manager", source: "session" });
const PAYLOAD = {
  directOrders: { approvedCount: 4, approvedValue: 120_500 },
  generatedAt: "2026-11-19T08:00:00.000Z",
  headcount: { activeEmployees: 181, payrollEligible: 176 },
  leave: { awaitingMyDecision: 2 },
  marketing: { awaitingMyStep: 3 },
  payroll: { committed: [], runs: [] },
};

const rpcFailure = () => ({ body: { code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" }, status: 500 });

export async function runFinanceCommandCenterBehaviourTests(): Promise<void> {
  // ── 1. A failed aggregate is named, never a confident zero; the other section survives ──────────
  {
    const standIn: StandIn = { rpc: { phx_finance_command_center: rpcFailure }, tables: { automated_payroll_runs: [] } };
    await withPostgrestStandIn(standIn, async () => {
      const view = await getFinanceCommandCenterData(FINANCE);
      assert.deepEqual(
        view.unavailable,
        ["Finance command centre aggregates"],
        "HEADLINE: the failed aggregate is named, so the page says it could not be read instead of printing zeros as fact",
      );
      assert.equal(view.data.headcount.activeEmployees, 0, "the empty shape stands in, and the page marks it unavailable");
      assert.ok(view.sheets, "the finance-sheets section still answers on its own");
      assert.equal(view.sheets.hasRun, false);
    });
  }

  // …and the other way round: the payroll run cannot be read, the aggregate still shows.
  {
    const standIn: StandIn = {
      failReads: { automated_payroll_runs: { body: { code: "XX000", message: "stand-in read failure" }, status: 500 } },
      rpc: { phx_finance_command_center: () => PAYLOAD },
      tables: {},
    };
    await withPostgrestStandIn(standIn, async () => {
      const view = await getFinanceCommandCenterData(FINANCE);
      assert.deepEqual(view.unavailable, ["Automated Payroll finance sheets"], "a failed run read is named too");
      assert.equal(view.sheets, null, "and its section is empty, never a run that is not there");
      assert.equal(view.data.headcount.activeEmployees, 181, "the aggregate that did load is shown as it came");
    });
  }

  // ── 2. The aggregate as it came, for the caller, over a held window ────────────────────────────
  {
    const standIn: StandIn = {
      rpc: { phx_finance_command_center: () => PAYLOAD },
      tables: { automated_payroll_runs: [] },
    };
    await withPostgrestStandIn(standIn, async (seen) => {
      const view = await getFinanceCommandCenterData(FINANCE, { trendMonths: 99 });
      assert.deepEqual(view.unavailable, [], "both sources read: nothing to name");
      assert.deepEqual(view.data, PAYLOAD, "the aggregate reaches the page unchanged");
      const [call] = rpcCalls(seen, "phx_finance_command_center");
      assert.deepEqual(call.body, { p_actor_hr_id: FINANCE.hrId, p_trend_months: 24 }, "the caller's own figures (the session's HR id key), over at most 24 months");
      await getFinanceCommandCenterData(FINANCE, { trendMonths: 0 });
      assert.equal((rpcCalls(seen, "phx_finance_command_center")[1].body as Record<string, unknown>).p_trend_months, 1, "and at least one");
    });
  }

  // ── 3. A seat without payroll:read is refused before any figure is read ────────────────────────
  {
    const advisor = createAccessContext({ hrId: "FA-1", loginId: "fa.one", role: "Financial Advisor", source: "session" });
    const standIn: StandIn = { rpc: { phx_finance_command_center: () => PAYLOAD }, tables: { automated_payroll_runs: [] } };
    await withPostgrestStandIn(standIn, async (seen) => {
      await assert.rejects(
        getFinanceCommandCenterData(advisor),
        (error: Error) => error.message === "Forbidden: Financial Advisor cannot read payroll.",
        "HEADLINE: the Financial Advisor holds no payroll grant and is refused by the service itself",
      );
      assert.equal(rpcCalls(seen, "phx_finance_command_center").length, 0, "no aggregate was asked for");
      assert.equal(seen.filter((entry) => entry.table === "automated_payroll_runs").length, 0, "no payroll run was read");
    });
  }

  // ── 4. A payroll reader who is not a payroll finance actor gets no sheets section — and no error ──
  // Production, 27 Nov 2026 19:09 Cairo: the SFE Command Center (through the CEO command centre's
  // payroll-trend read) called this as the SFE Manager, who holds payroll:read but may not open the
  // Automated Payroll finance sheet. The sheet service refused him — correctly — and that refusal was
  // logged as "Finance sheet availability failed" and named "unavailable": an error for a section that
  // simply does not apply to him. `sheets: null` is the screen's own "not authorised" (no button).
  {
    const sfeManager = createAccessContext({ hrId: "SFE-1", loginId: "sfe.one", role: "SFE Manager", source: "session" });
    const standIn: StandIn = { rpc: { phx_finance_command_center: () => PAYLOAD }, tables: { automated_payroll_runs: [] } };
    await withPostgrestStandIn(standIn, async (seen) => {
      const view = await getFinanceCommandCenterData(sfeManager);
      assert.deepEqual(view.unavailable, [], "HEADLINE: a section the viewer may not open is not 'unavailable' — nothing failed");
      assert.equal(view.sheets, null, "no sheets section for a viewer who may not open the finance sheet");
      assert.equal(seen.filter((entry) => entry.table === "automated_payroll_runs").length, 0, "the payroll run is never read for him");
      assert.deepEqual(view.data, PAYLOAD, "the aggregate he may read still comes through");
    });
  }
}
