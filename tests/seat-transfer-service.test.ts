import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  listSeatTransferOptions,
  transferEmployeeSeat,
} from "../src/lib/employees/seat-transfer.ts";

// phx_transfer_au_seat rewrites live org structure (seat occupancy + the employee
// master's area/region/manager), so the service must gate on Super Admin server-side
// and only ever call the RPC with clean, validated arguments.

const superAdmin: AccessContext = {
  hrId: "AA",
  loginId: "AA",
  role: "Super Admin",
  scope: "system",
  source: "session",
};

const districtManager: AccessContext = {
  hrId: "B-12",
  loginId: "B-12",
  role: "District Manager",
  scope: "team",
  source: "session",
};

function untouchableClient(): SupabaseClient {
  return {
    from() {
      throw new Error("client must not be touched before the permission gate");
    },
    rpc() {
      throw new Error("rpc must not be called before the permission gate");
    },
  } as unknown as SupabaseClient;
}

function rpcCapturingClient(result: { data?: unknown; error?: { message: string } | null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
  } as unknown as SupabaseClient;
  return { calls, client };
}

// employees.hr_id is stored canonical-uppercase (same rule as position_vacancies.manager_hr_id
// in vacancy-closer.ts). A row with line_id: null keeps the scenario to a single query -- the
// lines/au_v_org_tree lookups are skipped entirely -- and lets `from()` refuse any other table,
// which doubles as proof nothing else is queried.
function employeeLookupClient(
  employeeRow: { hr_id: string; full_name: string; line_id: number | null; employment_status: string } | null,
) {
  const eqCalls: Array<{ column: string; value: unknown }> = [];
  const client = {
    from(table: string) {
      if (table !== "employees") throw new Error(`unexpected table for this scenario: ${table}`);
      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              eqCalls.push({ column, value });
              return { maybeSingle: () => Promise.resolve({ data: employeeRow, error: null }) };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { eqCalls, client };
}

export async function runSeatTransferServiceTests() {
  await assert.rejects(
    () => transferEmployeeSeat("CN-0006", { toSeatId: "SEAT-CNS-REP-CA5" }, "B-12", districtManager, untouchableClient()),
    /Forbidden/,
    "a District Manager must never move seats - seat moves rewrite payroll-bearing org structure",
  );
  await assert.rejects(
    () => listSeatTransferOptions("CN-0006", districtManager, untouchableClient()),
    /Forbidden/,
    "the options listing is gated the same as the mutation - it enumerates org structure",
  );

  await assert.rejects(
    () => transferEmployeeSeat("CN-0006", { toSeatId: "  " }, "AA", superAdmin, untouchableClient()),
    /Destination seat is required/,
    "a blank destination fails before any database call",
  );
  await assert.rejects(
    () =>
      transferEmployeeSeat(
        "CN-0006",
        { toSeatId: "SEAT-CNS-REP-CA5", effectiveDate: "04-08-2026" },
        "AA",
        superAdmin,
        untouchableClient(),
      ),
    /YYYY-MM-DD/,
    "a non-ISO effective date fails before any database call",
  );

  const happy = rpcCapturingClient({
    data: {
      mode: "transferred",
      employeeHrId: "CN-0006",
      fromSeatId: "SEAT-CNS-REP-GZ1",
      toSeatId: "SEAT-CNS-REP-CA5",
      effectiveDate: "2026-08-04",
      occupancyId: 999,
      employeesSync: {},
    },
  });
  const result = await transferEmployeeSeat(
    " CN-0006 ",
    { toSeatId: " SEAT-CNS-REP-CA5 ", reason: "  " },
    "AA",
    superAdmin,
    happy.client,
  );
  assert.equal(happy.calls.length, 1, "exactly one RPC call performs the move");
  assert.equal(happy.calls[0].fn, "phx_transfer_au_seat");
  assert.deepEqual(
    happy.calls[0].args,
    {
      p_actor: "AA",
      p_effective_date: null,
      p_employee_hr_id: "CN-0006",
      p_from_seat_id: null,
      p_reason: null,
      p_to_seat_id: "SEAT-CNS-REP-CA5",
    },
    "arguments reach the RPC trimmed, with blanks normalized to null so SQL sees real defaults",
  );
  assert.equal(result.mode, "transferred", "the RPC result passes through untouched");

  const failing = rpcCapturingClient({ error: { message: "transfer: seat SEAT-CNS-REP-CA5 is already occupied by CN-0006" } });
  await assert.rejects(
    () => transferEmployeeSeat("B-144", { toSeatId: "SEAT-CNS-REP-CA5" }, "AA", superAdmin, failing.client),
    /already occupied/,
    "the SQL guard's message surfaces verbatim so the dialog can show the real reason",
  );

  const lookup = employeeLookupClient({ hr_id: "B-12", full_name: "Reem Kassem", line_id: null, employment_status: "active" });
  const options = await listSeatTransferOptions("b-12", superAdmin, lookup.client);
  assert.deepEqual(
    lookup.eqCalls,
    [{ column: "hr_id", value: "B-12" }],
    "a lower-case hr_id path segment is canonicalized to the stored uppercase form before the .eq() filter -- a raw eq(\"hr_id\",\"b-12\") would silently return no row, same defect class as vacancy-closer.ts's manager_hr_id match",
  );
  assert.equal(options.employee.hrId, "B-12", "the employee is found despite the mixed-case path segment");
}
