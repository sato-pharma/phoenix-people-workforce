import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { calculateVacationPayment } from "../src/lib/vacation/calculations.ts";

function source(path: string) {
  return readFileSync(path, "utf8");
}

// Mirror of the SQL split arithmetic in phx_apply_vacation_paid_approval. It must stay
// identical to splitVacationPayment in src/lib/vacation/calculations.ts; this test guards
// against the JS<->SQL formula drifting apart. (Exact round() identity between Postgres and
// JS is validated on staging; here we validate the FORMULA the SQL ports.)
function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function sqlMirrorSplit(entitlementDays: number, usedPaidDays: number, durationDays: number) {
  const used = round2(usedPaidDays);
  const balanceBefore = round2(Math.max(0, entitlementDays - used));
  const paid = round2(Math.min(durationDays, Math.max(0, balanceBefore)));
  const unpaid = round2(Math.max(0, durationDays - paid));
  const balanceAfter = round2(Math.max(0, balanceBefore - paid));
  const paymentStatus = unpaid > 0 && paid > 0 ? "partial" : unpaid > 0 ? "unpaid" : "paid";
  return { balanceAfter, balanceBefore, paid, paymentStatus, unpaid };
}

export function runVacationPaidApprovalAtomicTests() {
  // ---- Numeric parity: the ported SQL split must match the production JS split. ----
  const hireDate = "2000-01-01"; // long-tenured → standard accrued annual period
  const startDate = "2024-06-15";
  for (const used of [0, 3, 7.5, 20, 21, 100]) {
    for (const duration of [0.5, 1, 5, 10, 30]) {
      const res = calculateVacationPayment({
        approvedPaidDaysInPeriod: used,
        durationDays: duration,
        hireDate,
        startDate,
        vacationType: "annual",
      });
      const mirror = sqlMirrorSplit(res.entitlementDays, res.usedPaidDays, duration);
      assert.equal(res.paidDurationDays, mirror.paid, `paid mismatch used=${used} dur=${duration}`);
      assert.equal(res.unpaidDurationDays, mirror.unpaid, `unpaid mismatch used=${used} dur=${duration}`);
      assert.equal(res.paymentStatus, mirror.paymentStatus, `status mismatch used=${used} dur=${duration}`);
      assert.equal(res.balanceBeforeDays, mirror.balanceBefore, `before mismatch used=${used} dur=${duration}`);
      assert.equal(res.balanceAfterDays, mirror.balanceAfter, `after mismatch used=${used} dur=${duration}`);
    }
  }

  // ---- Migration shape: lock + CAS + period sum + split + server-only grant. ----
  const migration = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260615080500_vacation_paid_approval_atomic.sql");
  assert.match(migration, /create or replace function public\.phx_apply_vacation_paid_approval/);
  assert.match(migration, /security definer/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtext\(lower\(v_employee_hr_id\)\)\)/);
  assert.match(migration, /status is distinct from p_expected_status/);
  assert.match(migration, /coalesce\(sum\(paid_duration_days\), 0\)/);
  assert.match(migration, /vacation_type in \('annual', 'emergency'\)/);
  assert.match(migration, /v_payment_status := 'partial'/);
  assert.match(migration, /v_unpaid_reason := case when v_unpaid > 0 then 'insufficient_balance'/);
  assert.match(migration, /grant execute on function public\.phx_apply_vacation_paid_approval[\s\S]*to service_role/);
  assert.match(migration, /from authenticated/);

  // ---- Service rewire: contended final approval routes through the atomic RPC. ----
  const service = source("src/lib/vacation/service.ts");
  assert.match(service, /const isPaidBalanceContended =/);
  // Since 13 Nov 2026 (F-HR-010) through the wrapper that writes the approver's step in the same
  // transaction; the wrapper runs this RPC unchanged (pinned in tests/hr-atomic-writes.test.ts).
  assert.match(service, /\.rpc\("phx_apply_vacation_paid_approval_with_step"/);
  assert.match(
    source("supabase/migrations/20261113161725_vacation_step_and_request_atomic.sql"),
    /from public\.phx_apply_vacation_paid_approval\(/,
    "the wrapper must still run the unchanged paid-balance RPC",
  );
  assert.match(service, /p_expected_status: input\.request\.status/);
  // Forced-unpaid and compensatory must NOT take the atomic path.
  assert.match(service, /balance\.unpaidReason !== "first_six_months"/);
  assert.match(service, /balance\.unpaidReason !== "missing_hire_date"/);
}
