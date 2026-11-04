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
  assert.deepEqual(options.otherLineVacantSeats, [], "a line-less employee gets no other-line seats and no extra query");

  // A line move (Omaima Wael, Anti Infective -> Pedia, same area) goes to phx_move_employee_to_line,
  // which moves the line, fills the destination seat's vacancy and opens one for the seat left.
  // Without the routing the seat transfer refuses another line's seat, and the only route left was
  // resigning the person and re-hiring them.
  const lineMove = rpcCapturingClient({
    data: {
      mode: "transferred",
      employeeHrId: "AI-0009",
      fromSeatId: "SEAT-AIF-REP-GZ2",
      toSeatId: "SEAT-PED-REP-GZ2",
      effectiveDate: "2026-11-01",
      occupancyId: 1000,
      employeesSync: {},
      lineMove: { fromLine: "Anti Infective", toLine: "Pedia", vacanciesFilled: ["VAC-B164-P7C"], vacancyOpened: "VAC-AI0009-LMABCD" },
    },
  });
  const moved = await transferEmployeeSeat(
    "AI-0009",
    { toSeatId: "SEAT-PED-REP-GZ2", effectiveDate: "2026-11-01", fromSeatId: "SEAT-AIF-REP-GZ2", moveLine: true },
    "B-10",
    superAdmin,
    lineMove.client,
  );
  assert.equal(lineMove.calls.length, 1, "a line move is one RPC call, one transaction");
  assert.equal(lineMove.calls[0].fn, "phx_move_employee_to_line", "a seat on another line routes to the line move");
  assert.deepEqual(
    lineMove.calls[0].args,
    {
      p_actor: "B-10",
      p_effective_date: "2026-11-01",
      p_employee_hr_id: "AI-0009",
      p_reason: null,
      p_to_seat_id: "SEAT-PED-REP-GZ2",
    },
    "the line move takes exactly its own five arguments (it derives the seat left itself)",
  );
  assert.equal(moved.lineMove?.toLine, "Pedia", "the line-move summary passes through for the success notice");

  const sameLine = rpcCapturingClient({ data: { mode: "transferred" } });
  await transferEmployeeSeat("CN-0006", { toSeatId: "SEAT-CNS-REP-CA5", moveLine: false }, "AA", superAdmin, sameLine.client);
  assert.equal(sameLine.calls[0].fn, "phx_transfer_au_seat", "a same-line seat stays on the plain transfer");

  await assert.rejects(
    () =>
      transferEmployeeSeat("AI-0009", { toSeatId: "SEAT-PED-REP-GZ2", moveLine: true }, "B-12", districtManager, untouchableClient()),
    /Forbidden/,
    "a line move is gated exactly like a seat transfer",
  );

  // The options list offers every other line's vacant seats, named by line, never pseudo seats.
  const tree = [
    { seat_id: "SEAT-AIF-REP-GZ2", seat_tier: "rep", line_code: "AIF", area_name: "Dokki", region_name: "Giza", seat_display_label: "Rep GZ2", occupant_hr_id: "ai-0009", is_vacant: false, is_other_pseudo_dm: false },
    { seat_id: "SEAT-PED-REP-GZ2", seat_tier: "rep", line_code: "PED", area_name: "Dokki", region_name: "Giza", seat_display_label: "Rep GZ2", occupant_hr_id: null, is_vacant: true, is_other_pseudo_dm: false },
    { seat_id: "SEAT-PED-DM-X", seat_tier: "dm", line_code: "PED", area_name: null, region_name: null, seat_display_label: "Other DM", occupant_hr_id: null, is_vacant: true, is_other_pseudo_dm: true },
  ];
  const fullClient = {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      const rows = () => {
        if (table === "employees") return [{ hr_id: "AI-0009", full_name: "Omaima Wael", line_id: 3, employment_status: "active" }];
        if (table === "lines") {
          const all = [{ id: 3, code: "AIF", name: "Anti Infective" }, { id: 5, code: "PED", name: "Pedia" }];
          return all.filter((line) => filters.every(([op, col, val]) => op !== "eq" || (line as Record<string, unknown>)[col] === val));
        }
        if (table === "au_v_org_tree") {
          return tree.filter((row) =>
            filters.every(([op, col, val]) =>
              op === "eq" ? (row as Record<string, unknown>)[col] === val : (row as Record<string, unknown>)[col] !== val,
            ),
          );
        }
        throw new Error(`unexpected table ${table}`);
      };
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => (filters.push(["eq", col, val]), builder),
        neq: (col: string, val: unknown) => (filters.push(["neq", col, val]), builder),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: { data: unknown; error: null }) => unknown) => resolve({ data: rows(), error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  const crossLine = await listSeatTransferOptions("AI-0009", superAdmin, fullClient);
  assert.deepEqual(
    crossLine.otherLineVacantSeats.map((seat) => [seat.seatId, seat.lineName]),
    [["SEAT-PED-REP-GZ2", "Pedia"]],
    "another line's vacant seat is offered with its line's name; pseudo seats and the own line are not",
  );
  assert.deepEqual(crossLine.currentSeats.map((seat) => seat.seatId), ["SEAT-AIF-REP-GZ2"]);
  assert.deepEqual(crossLine.vacantSeats, [], "the own line has no vacant seat in this tree");
}
