import assert from "node:assert/strict";

import { assignablePhoenixRoles, createAccessContext, permissionMatrix } from "../src/lib/auth/permissions.ts";
import { getOverviewDashboard } from "../src/lib/overview/service.ts";
import { withPostgrestStandIn, type Row, type StandIn } from "./support/postgrest-stand-in.ts";

// REC-079 (phase 2): src/lib/overview — the admin overview's one loader — run against the shared
// in-memory PostgREST, not read.
//
// getOverviewDashboard fans out to the platform metrics, payroll, sales, the directory, expenses and
// the activity feed. Its main rule:
//
//   1. A section the viewer's grants do not open is never fetched: a seat without payroll, sales and
//      expenses grants reads none of their tables, and its overview shows them empty, not borrowed.
//   2. An activity source that cannot be read reaches the overview by NAME, so an outage never reads
//      as a quiet day, while the rest of the page still loads.

const ago = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
const MONEY_TABLE = /^(salary_|sales_|source_of_sales_|outstation_expense)/;

function emptyCompany(): StandIn {
  return {
    tables: {
      salary_batches: [
        { approved_at: ago(15), approved_by: "B-10", created_at: ago(120), id: "p1", month: 10, status: "approved", updated_at: ago(15), uploaded_by: "HR-9", year: 2026 } as Row,
      ],
    },
    // Every aggregate the payroll and sales dashboards ask for answers "nothing yet".
    unknownRpc: () => ({ body: [], status: 200 }),
  };
}

export async function runOverviewDashboardBehaviourTests(): Promise<void> {
  // ── 1. A section the viewer cannot read is never fetched ──────────────────────────────────────
  const blind = assignablePhoenixRoles.find((role) =>
    ["payroll", "sales", "expenses"].every((resource) => !(permissionMatrix[role][resource as "payroll"] ?? []).includes("read")),
  );
  assert.ok(blind, "precondition: at least one seat holds none of payroll, sales and expenses read");
  await withPostgrestStandIn(emptyCompany(), async (seen) => {
    const overview = await getOverviewDashboard(createAccessContext({ hrId: "STAND-IN-V", loginId: "stand.in.view", role: blind, source: "session" }));
    const moneyReads = [...new Set(seen.filter((entry) => entry.kind === "read" && MONEY_TABLE.test(entry.table ?? "")).map((entry) => entry.table))];
    assert.deepEqual(moneyReads, [], `HEADLINE: ${blind} holds no payroll, sales or expenses grant, so none of their tables is read`);
    assert.deepEqual(overview.payroll.distribution, [], "the payroll section is empty, not someone else's");
    assert.deepEqual(overview.sales.distribution, [], "so is sales");
    assert.deepEqual(overview.activity, { recent: [], staleSources: [] }, "no activity source is opened for this seat, and that is not an outage");
  });

  // ── 2. An activity outage is named on the overview, and the page still loads ───────────────────
  const owner = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin", source: "session" });
  const salesDown = emptyCompany();
  salesDown.failReads = { sales_audit_logs: { body: { code: "XX000", message: "stand-in read failure" }, status: 500 } };
  await withPostgrestStandIn(salesDown, async () => {
    const overview = await getOverviewDashboard(owner);
    assert.deepEqual(overview.activity.staleSources, ["Sales"], "HEADLINE: the sales feed that could not be read is named on the overview");
    assert.deepEqual(
      overview.activity.recent.map((event) => event.description),
      ["Payroll approved for 10/2026"],
      "and the payroll activity that did load still shows",
    );
  });
}
