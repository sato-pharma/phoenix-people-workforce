import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import {
  hrIdsForManagerLinks,
  managerLinksToWrite,
} from "../src/lib/imports/employee-manager-links.ts";
import {
  groupRowsByColumnSet,
  upsertByColumnSet,
} from "../src/lib/imports/upsert-by-column-set.ts";

// Regression tests for the 2026-09-15 Employee Master upload that "did not sync".
//
// 1. A blank cell must leave the saved value alone. The confirm route builds every row with
//    conditional spreads so a blank cell is skipped, then used to send all rows in ONE bulk upsert.
//    postgrest-js turns that into one column list for the whole request — the union of every row's
//    keys — and PostgREST writes NULL for a listed column a row does not carry, merged over the
//    saved value. The export has no region code column and the seat map resolves one only for sales
//    seats, so that upload wrote NULL over the region code of every employee in it whose line and
//    area resolve to no region — managers and Head Office staff: 39 of the 103 it updated have none.
//
// 2. A manager link must not depend on the manager being a row in the same file. The existence
//    check looked up only the file's own HR_IDs, so a partial upload skipped every link to a manager
//    who was not in it, without a word.
//
// Each has two halves: the behaviour of the lib helper, and a source pin that the route still writes
// through it.

type CapturedRequest = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

/**
 * A real supabase-js client whose fetch records each PostgREST request instead of sending it, so the
 * test sees exactly the column list and body the database would receive.
 */
function capturingClient() {
  const requests: CapturedRequest[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (!url.pathname.startsWith("/rest/v1/")) {
      return new Response("{}", { status: 200 });
    }

    const columns = (url.searchParams.get("columns") ?? "")
      .split(",")
      .filter(Boolean)
      .map((column) => column.replace(/^"|"$/g, ""));
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : [];

    requests.push({
      columns,
      rows: (Array.isArray(body) ? body : [body]) as Array<Record<string, unknown>>,
    });

    return new Response(null, { status: 201 });
  };
  const client = createClient("http://127.0.0.1:54321", "stub-key-never-sent", {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { fetch: fetchStub },
  });

  return { client, requests };
}

/**
 * The body of one top-level `async function <name>(` in the route source, cut at the next top-level
 * function rather than at a fixed byte offset (see employee-import-team-resurrection-guard.test.ts).
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `route source must still declare async function ${name}(`);
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/\n(?:async function|function) [A-Za-z]/);
  return nextFn === -1 ? rest : rest.slice(0, nextFn);
}

export async function runEmployeeImportKeepsBlankCellsTests() {
  // Three existing employees from one master file. The rep's region resolves from the seat map; the
  // manager's does not, so the manager's row carries no region_code key at all — the importer's way
  // of saying "leave the saved value alone". An undefined value is the other way a cell goes missing.
  const rep = { full_name: "Rep One", hr_id: "PD-9001", region_code: "D1", updated_at: "2026-09-15T11:00:00.000Z" };
  const manager = { full_name: "Manager One", hr_id: "PD-9002", updated_at: "2026-09-15T11:00:00.000Z" };
  const officeUndefined = {
    full_name: "Office One",
    hr_id: "B-9003",
    region_code: undefined,
    updated_at: "2026-09-15T11:00:00.000Z",
  };

  // ── Why this exists: the pinned client sends ONE column list for a mixed bulk upsert. ────────
  {
    const { client, requests } = capturingClient();
    const { error } = await client.from("employees").upsert([rep, manager], { onConflict: "hr_id" });

    assert.equal(error, null);
    assert.equal(requests.length, 1, "a bulk upsert is one request");
    assert.ok(
      requests[0].columns.includes("region_code") && !("region_code" in requests[0].rows[1]),
      "characterization: postgrest-js lists region_code for the whole request although the manager's row does not carry it, so PostgREST writes NULL over that manager's saved region code. If an upgrade stops doing this, this one assertion can go — the ones below are the guard",
    );
  }

  // ── The guard: no request names a column one of its rows left blank. ────────────────────────
  {
    const { client, requests } = capturingClient();
    const { error } = await upsertByColumnSet([rep, manager, officeUndefined], (group) =>
      client.from("employees").upsert(group, { onConflict: "hr_id" }),
    );

    assert.equal(error, null);

    for (const request of requests) {
      for (const row of request.rows) {
        assert.deepEqual(
          Object.keys(row).sort(),
          [...request.columns].sort(),
          `row ${String(row.hr_id)} was sent in a request naming columns it does not carry — PostgREST would write NULL over its saved values`,
        );
      }
    }

    assert.deepEqual(
      requests.flatMap((request) => request.rows.map((row) => row.hr_id)).sort(),
      ["B-9003", "PD-9001", "PD-9002"],
      "every row must still be written, exactly once",
    );
    assert.equal(
      requests.length,
      2,
      "rows that carry the same columns must still travel together — one request per column set, not one per row",
    );
  }

  // ── Grouping is by exact key set, in first-seen order, and leaves the caller's rows alone. ───
  const reordered = { updated_at: "2026-09-15T11:00:00.000Z", hr_id: "PD-9004", region_code: "D2", full_name: "Rep Two" };
  const groups = groupRowsByColumnSet([rep, manager, officeUndefined, reordered]);

  assert.deepEqual(
    groups.map((group) => group.map((row) => row.hr_id)),
    [
      ["PD-9001", "PD-9004"],
      ["PD-9002", "B-9003"],
    ],
    "rows group by the SET of keys they carry — key order is irrelevant, and an undefined value is an absent key",
  );
  assert.equal("region_code" in officeUndefined, true, "the caller's row object must not be mutated");
  assert.deepEqual(groupRowsByColumnSet([]), []);

  // ── A failing group stops the write and surfaces its error. ─────────────────────────────────
  {
    const attempted: string[][] = [];
    const failure = { message: "column employees.region_code does not exist" };
    const result = await upsertByColumnSet([rep, manager], async (group) => {
      attempted.push(group.map((row) => row.hr_id));
      return { error: attempted.length === 1 ? failure : null };
    });

    assert.equal(
      result.error,
      failure,
      "the failing group's error must reach the caller, which decides whether to retry without optional columns or throw",
    );
    assert.equal(attempted.length, 1, "no group may be written after one has failed");
  }

  {
    let calls = 0;
    const result = await upsertByColumnSet([], async () => {
      calls += 1;
      return { error: null };
    });

    assert.equal(result.error, null);
    assert.equal(calls, 0, "an empty import sends no request");
  }

  // ── Manager links: the managers each row names are part of the existence lookup. ────────────
  const linkRows = [
    { hrId: "PD-9101", managerHrId: "B-9050" }, // the manager exists but is not a row in this file
    { hrId: "PD-9102", managerHrId: "PD-9101" }, // the manager is a row in this file
    { hrId: "PD-9103", managerHrId: "B-9404" }, // the manager has no employee row anywhere
    { hrId: "PD-9104", managerHrId: null },
  ];

  assert.deepEqual(
    hrIdsForManagerLinks(linkRows).sort(),
    ["B-9050", "B-9404", "PD-9101", "PD-9102", "PD-9103", "PD-9104"],
    "the existence lookup must cover the managers each row names — looking up only the file's own HR_IDs skipped every link to a manager outside the file",
  );

  // What that lookup returns: everyone except the manager who exists nowhere.
  const found = new Set(["B-9050", "PD-9101", "PD-9102", "PD-9103", "PD-9104"]);

  assert.deepEqual(
    managerLinksToWrite(linkRows, found),
    [
      { hrId: "PD-9101", managerHrId: "B-9050" },
      { hrId: "PD-9102", managerHrId: "PD-9101" },
    ],
    "a link is written whenever the manager has an employee row, in the file or not; a manager with no row anywhere is skipped rather than failing the import on the foreign key",
  );

  // ── The route still writes through both helpers. ────────────────────────────────────────────
  const routeSource = readFileSync(
    fileURLToPath(new URL("../app/api/imports/employees/confirm/route.ts", import.meta.url)),
    "utf8",
  );

  for (const name of ["upsertEmployees", "upsertEmployeeCompensation"]) {
    const body = functionBody(routeSource, name);
    const upsertCalls = body.match(/\.upsert\(/g) ?? [];
    const groupedCalls = body.match(/\.upsert\(\s*group\s*,/g) ?? [];

    assert.ok(body.includes("upsertByColumnSet("), `${name} must write its rows through upsertByColumnSet()`);
    assert.ok(upsertCalls.length > 0, `${name} no longer upserts at all — re-read this pin rather than deleting it`);
    assert.equal(
      groupedCalls.length,
      upsertCalls.length,
      `every .upsert( in ${name} must receive one column-set group — a bulk upsert of mixed rows is the call that wrote NULL over blank cells`,
    );
  }

  const upsertEmployeesBody = functionBody(routeSource, "upsertEmployees");

  assert.ok(
    /existingEmployeeHrIds\(\s*supabase,\s*hrIdsForManagerLinks\(/.test(upsertEmployeesBody),
    "the manager-existence lookup must be built by hrIdsForManagerLinks(), which includes the managers themselves",
  );
  assert.ok(
    upsertEmployeesBody.includes("managerLinksToWrite("),
    "upsertEmployees must choose its manager links with managerLinksToWrite()",
  );
}
