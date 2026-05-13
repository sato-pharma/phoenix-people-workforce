import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runLeaveServiceSafetyTests() {
  const source = readFileSync("src/lib/leave/service.ts", "utf8");
  const migration = readFileSync("supabase/migrations/20260513100825_leave_production_readiness.sql", "utf8");
  const recordStart = source.indexOf("async function recordBalanceTransaction");
  const insertPosition = source.indexOf('.from("leave_transactions").insert', recordStart);
  const updatePosition = source.indexOf('.from("employee_leave_balances")', recordStart);

  assert.ok(recordStart > -1, "recordBalanceTransaction should exist");
  assert.ok(insertPosition > -1, "leave transaction insert should exist");
  assert.ok(updatePosition > -1, "balance update should exist");
  assert.ok(insertPosition < updatePosition, "transaction insert should happen before balance update to avoid duplicate-click balance corruption");
  assert.match(source, /requestHasTransaction\(request\.id, "pending_reversal"\)/);
  assert.match(source, /\.rpc\("phx_leave_manager_decision_atomic"/);
  assert.match(source, /\.rpc\("phx_leave_hr_decision_atomic"/);
  assert.match(migration, /select \* into v_request from public\.leave_requests where id = p_request_id for update;/);
  assert.match(migration, /if v_request\.status not in \('pending_hr', 'manager_approved'\) then/);
  assert.match(migration, /where request_id = p_request\.id and transaction_type = 'pending_reversal'/);
  assert.match(migration, /where request_id = p_request\.id and transaction_type = 'consumed'/);
  assert.match(source, /Forbidden: managers can only approve their own team requests/);
  assert.match(source, /employeeIsUnderManager\(access\.hrId, row\.employee_hr_id, employeeByHrId\)/);
  assert.match(source, /payrollCanRead\(access\) && Boolean\(request\.leaveType\?\.affectsPayroll\)/);
}
