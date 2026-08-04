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
}
