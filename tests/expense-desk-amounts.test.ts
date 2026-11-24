/**
 * Expense Approvals — EDITING A CLAIM'S AMOUNTS, pinned.
 *
 * Owner, 24 Nov 2026: "i want to be able to edit in expense value"; asked which edit, "All of these":
 * each part (travel, allowance, meeting, other), on a waiting and on a decided claim, any figure —
 * above the claim too — until a payroll takes the trip.
 *
 *   1. The edit is read whole or not at all: a half-written edit never pays a part as zero.
 *   2. The ONE payroll mapper pays the edited parts and their sum — above the claim included — and
 *      with no edit pays exactly what it paid before. Both mappers (the row and the request) do.
 *   3. The desk claim carries what was claimed beside what is paid, and pays the edit.
 *   4. The plan refuses, before anything is written: a claim off the list, one a payroll took, one
 *      whose payroll ran, a moved claim, a bad figure, no change, no reason. Every part back at the
 *      claim clears the edit.
 *   5. The boxes take "0" (a part can be nothing) and refuse what is not a figure.
 *   6. A saved edit moves the claim's tile by the difference and never touches the agreement meter.
 *   7. The migration: the edit column, the flag that alone lets the mirror hold an approved total
 *      above the claim, and the mirror's guard letting only an edited trip through.
 *   8. The route's order, the server's checks, and the box on the opened trip.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { AMOUNTS_REFUSAL, amountsOpen, draftParts, planDeskAmounts, typedPart } from "@/lib/outstation/approvals/amounts-plan";
import { buildDeskClaim, DESK_CLAIM_COLUMNS, type ClaimRow } from "@/lib/outstation/approvals/claim-row";
import { applyEditedClaim } from "@/lib/outstation/approvals/desk-view";
import type { DeskClaim, DeskQueue } from "@/lib/outstation/approvals/types";
import { OUTSTATION_CLAIM_CHANGED_MESSAGE } from "@/lib/outstation/claim-revision";
import { partsTotal, readHrAmounts } from "@/lib/outstation/hr-amounts";
import { mapOutstationRequestRowToPayrollApproval, withHrAmounts } from "@/lib/outstation/payroll-expense-mapping";

const NOW = new Date("2026-11-24T09:00:00.000Z");

const EDIT = { allowance: 300, before: null, by: "B-10", meeting: 0, other: 50, reason: "Return ticket was paid on the day.", setAt: "2026-11-24T08:00:00.000Z", travel: 700 };

function row(over: ClaimRow = {}): ClaimRow {
  return {
    allowance_amount: 300,
    approval_reason: "",
    created_at: "2026-11-10T08:00:00.000Z",
    employee_hr_id: "PD-0015",
    employee_name: "Stored Name",
    employee_role: "Medical Representative",
    evidence_gate_status: "complete",
    expected_total_amount: 900,
    expense_type: "traveling",
    fuel_amount: 600,
    id: 412,
    notes: "",
    status: "submitted",
    to_label: "Asyut 2",
    transportation_type: "car",
    trip_end_date: "2026-11-10",
    trip_start_date: "2026-11-09",
    updated_at: "2026-11-10T08:05:00.000Z",
    workload_gate_status: "complete",
    ...over,
  };
}

const claimOf = (over: ClaimRow = {}): DeskClaim => buildDeskClaim({ context: { today: "2026-11-24" }, ledger: null, now: NOW, row: row(over) });

const ask = (claim: DeskClaim, parts: Partial<Record<"allowance" | "meeting" | "other" | "travel", number>>, reason = "Ticket receipt checked.") =>
  planDeskAmounts({
    by: "B-10",
    claim,
    now: NOW,
    request: { parts: { allowance: 300, meeting: 0, other: 0, travel: 600, ...parts }, reason, requestId: claim.requestId, revision: claim.revision },
  });

export function runExpenseDeskAmountsTests() {
  // 1. Whole or nothing.
  assert.equal(readHrAmounts(null), null);
  assert.equal(readHrAmounts({ allowance: 300, meeting: 0, travel: 700 }), null, "a part missing reads as no edit, never as a zero");
  assert.equal(readHrAmounts({ ...EDIT, other: -1 }), null);
  assert.equal(readHrAmounts({ ...EDIT, travel: 2_000_000 }), null);
  assert.equal(readHrAmounts({ ...EDIT, travel: "" }), null);
  assert.deepEqual(readHrAmounts(EDIT)?.travel, 700);
  assert.equal(partsTotal(EDIT), 1050);

  // 2. The one mapper pays the edit, above the claim included; with none it is unchanged.
  const plain = mapOutstationRequestRowToPayrollApproval(row());
  assert.equal(plain.total, 900);
  assert.equal(plain.travelCost, 600);
  const edited = mapOutstationRequestRowToPayrollApproval(row({ hr_amounts: EDIT }));
  assert.equal(edited.total, 1050, "the edited parts and their sum ARE the trip's money, above the claim too");
  assert.equal(edited.travelCost, 700);
  assert.equal(edited.other, 50);
  assert.equal(edited.allowance, 300);
  assert.equal(mapOutstationRequestRowToPayrollApproval(row({ hr_amounts: { travel: 1 } })).total, 900, "a broken edit pays the claim");
  assert.deepEqual(withHrAmounts(null, { allowance: 1, meeting: 2, other: 3, total: 6, travel: 0 }), { allowance: 1, meeting: 2, other: 3, total: 6, travel: 0 });
  const mapping = fs.readFileSync("src/lib/outstation/payroll-expense-mapping.ts", "utf8");
  assert.match(mapping, /withHrAmounts\(request\.hrAmounts \?\? null,/, "the request mapper (the payroll push) pays the edit too");
  assert.match(mapping, /withHrAmounts\(readHrAmounts\(row\.hr_amounts\),/);
  assert.ok(DESK_CLAIM_COLUMNS.split(", ").includes("hr_amounts"), "the desk reads the edit");
  assert.match(fs.readFileSync("src/lib/outstation/service.ts", "utf8"), /hrAmounts: readHrAmounts\(row\.hr_amounts\),/, "the request read carries the edit to the payroll push");

  // 3. The desk claim: claimed beside paid, and it pays the edit.
  const waiting = claimOf();
  assert.equal(waiting.parts?.claimedTotal, 900);
  assert.equal(waiting.parts?.edited, null);
  const raised = claimOf({ hr_amounts: EDIT });
  assert.equal(raised.total, 1050);
  assert.equal(raised.payable, 1050);
  assert.equal(raised.parts?.claimed.travel, 600, "the claim is shown as the employee sent it");
  assert.equal(raised.parts?.claimedTotal, 900);
  assert.equal(raised.parts?.edited?.reason, EDIT.reason);

  // 4. The plan.
  assert.deepEqual(planDeskAmounts({ by: null, claim: null, now: NOW, request: { parts: EDIT, reason: "x", requestId: 1, revision: "r" } }), { code: "refused", message: AMOUNTS_REFUSAL.gone, ok: false });
  assert.equal((ask({ ...waiting, locked: true, standing: "in_payroll" }, { travel: 700 }) as { message: string }).message, AMOUNTS_REFUSAL.inPayroll);
  assert.equal((ask({ ...waiting, standing: "approved_missed" }, { travel: 700 }) as { message: string }).message, AMOUNTS_REFUSAL.payrollRan);
  assert.deepEqual(ask({ ...waiting, revision: "2026-11-11T00:00:00.000Z" }, { travel: 700 }).ok, true, "the plan reads the claim's own revision");
  const moved = planDeskAmounts({ by: "B-10", claim: waiting, now: NOW, request: { parts: EDIT, reason: "x", requestId: 412, revision: "2026-11-01T00:00:00.000Z" } });
  assert.deepEqual(moved, { code: "changed", message: OUTSTATION_CLAIM_CHANGED_MESSAGE, ok: false }, "a claim that moved is refused, never overwritten");
  for (const bad of [-1, Number.NaN, 2_000_000]) {
    assert.equal((ask(waiting, { travel: bad }) as { message: string }).message, AMOUNTS_REFUSAL.badPart);
  }
  assert.equal((ask(waiting, {}) as { message: string }).message, AMOUNTS_REFUSAL.noChange);
  assert.equal((ask(waiting, { travel: 700 }, "   ") as { message: string }).message, AMOUNTS_REFUSAL.noReason);
  const up = ask(waiting, { other: 50, travel: 700 });
  assert.ok(up.ok);
  assert.equal(up.total, 1050, "above the claim is allowed — it is his figure");
  assert.equal(up.next?.travel, 700);
  assert.equal(up.next?.by, "B-10");
  assert.deepEqual(up.before, { allowance: 300, meeting: 0, other: 0, travel: 600 });
  const back = ask(raised, {});
  assert.ok(back.ok);
  assert.equal(back.next, null, "every part back at the claim clears the edit");
  assert.equal(back.total, 900);
  assert.ok(ask({ ...waiting, standing: "approved_queued" }, { travel: 500 }).ok, "an approved claim no payroll took is open");
  assert.ok(ask({ ...waiting, standing: "rejected" }, { travel: 500 }).ok);
  assert.equal(amountsOpen(waiting), true);
  assert.equal(amountsOpen({ ...waiting, locked: true }), false);
  assert.equal(amountsOpen({ ...waiting, standing: "approved_missed" }), false);

  // 5. The boxes.
  assert.equal(typedPart("0"), 0);
  assert.equal(typedPart("1,250.50"), 1250.5);
  assert.equal(typedPart("EGP 75"), 75);
  assert.equal(typedPart("-5"), null);
  assert.equal(typedPart("abc"), null);
  assert.equal(typedPart(""), null);
  assert.equal(draftParts({ allowance: "300", meeting: "0", other: "", travel: "600" }), null, "an empty box is not a zero");

  // 6. The tile moves by the difference; the meter does not move.
  const queue: DeskQueue = {
    agreement: { ready: { approved: 3, decided: 4 }, windowDays: 30, yourCall: { approved: 1, decided: 2 } },
    canDecide: true,
    claims: [waiting],
    decided: [],
    overSevenDays: 1,
    tiles: {
      approved_held: { count: 0, value: 0 },
      approved_missed: { count: 0, value: 0 },
      approved_queued: { count: 0, value: 0 },
      in_payroll: { count: 0, value: 0 },
      rejected: { count: 0, value: 0 },
      waiting: { count: 1, value: 900 },
    } as DeskQueue["tiles"],
    unavailable: [],
  };
  const next = applyEditedClaim(queue, waiting, raised);
  assert.deepEqual(next.tiles.waiting, { count: 1, value: 1050 });
  assert.deepEqual(next.agreement, queue.agreement);
  assert.equal(next.claims[0]?.total, 1050);

  // 7. The migration.
  const migration = fs.readdirSync("supabase/migrations").find((name) => name.endsWith("_expense_hr_amounts_edit.sql"));
  assert.ok(migration, "the migration file exists");
  const sql = fs.readFileSync(`supabase/migrations/${migration}`, "utf8");
  assert.match(sql, /add column if not exists hr_amounts jsonb;/);
  assert.match(sql, /add column if not exists approved_above_claim boolean not null default false;/);
  assert.match(sql, /approved_total is null\s+or \(approved_total >= 0 and \(approved_total <= claimed_total or approved_above_claim\)\)/);
  assert.equal((sql.match(/r\.hr_amounts is not null\s+or coalesce\(e\.approved_amount, e\.total\)/g) ?? []).length, 2, "the mirror and the parity view let only an edited trip through");
  assert.match(sql, /revoke execute on function public\.phx_refresh_expense_claims\(\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.phx_refresh_expense_claims\(\) to service_role;/);

  // 8. The route, the server and the box.
  const code = (path: string) => fs.readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const routeFile = code("app/api/admin/outstation/approvals/amounts/route.ts");
  const route = routeFile.slice(routeFile.indexOf("export async function POST"));
  const order = ["assertSameOriginMutation", "unauthenticatedSessionResponse", "assertSystemAdministratorWorkspaceAccess", "assertRealSessionForDecision", "parseJsonBody", "editDeskClaimAmounts"].map((step) => route.indexOf(step));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!)), "same-origin, session, workspace, real session, then the body");
  const server = code("src/lib/outstation/approvals/amounts.ts");
  assert.ok(server.indexOf("assertRealSessionForDecision") < server.indexOf("loadDeskClaims"));
  assert.match(server, /decidedChangeRunRefusal/, "an approved claim asks its payroll run first");
  assert.match(server, /\.eq\("updated_at", storedStamp as string\)/, "the write is pinned to the version he saw");
  assert.match(server, /claim\.standing === "approved_queued"\) \{\s+try \{\s+payrollRow = await rewriteOutstationRequestPayrollFigures/);
  assert.match(server, /writeRequiredAuditLog/);
  assert.doesNotMatch(server, /notif|telegram|sendEmail/i, "the employee is not told");
  assert.match(fs.readFileSync("src/lib/security/access-registry.ts", "utf8"), /methods: \["POST"\], pattern: "\/api\/admin\/outstation\/approvals\/amounts", permission: null, guard: "domain-helper", csrfRequired: true/);
  const file = code("src/components/outstation/approvals-desk/desk-trip-file.tsx");
  assert.match(file, /canDecide && amountsOpen\(claim\) \? \(\s+<DeskAmounts/, "only the approver sees the box, and only where it is open");
  const box = code("src/components/outstation/approvals-desk/desk-amounts.tsx");
  assert.doesNotMatch(box, /rounded-(?!none)|truncate|overflow-x-auto/, "square, uncut, no sideways scroll");
  assert.match(box, /grid-cols-\[minmax\(0,1fr\)_30%_34%\]/, "the parts are rows of fixed shares, so they fit a phone");
  assert.doesNotMatch(box, /<table/, "no table, so no second phone layout to keep in step");
}
