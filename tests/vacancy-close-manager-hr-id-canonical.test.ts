import assert from "node:assert/strict";

import { closeVacancyOnHire } from "../src/lib/employees/vacancy-closer.ts";

// closeVacancyOnHire matches a new hire to an open position_vacancies row on
// (area, line, position, manager_hr_id). manager_hr_id is stored canonical-uppercase and
// PostgREST `eq.` is a case-sensitive string comparison, so a mixed-case manager id (as a hire
// form or an import row can carry) must be canonicalized before it reaches the filter -- a raw
// `eq.b-10` silently matches zero rows on real data, and the function then falls through to the
// weaker manager-NAME match and the open-manager-less-vacancy match, which can close a DIFFERENT
// vacancy on the same area/line/position with no error (AGENTS.md 2.1, "HR ids are MIXED CASE").
// This mirrors the exact bug class already fixed for several other files -- see
// tests/hrid-alias-normalization.test.ts.

type FetchStub = (input: string, init?: RequestInit) => Promise<Response>;

async function withFetch(stub: FetchStub, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function runVacancyCloseManagerHrIdCanonicalTests() {
  const managerHrIdFiltersSeen: string[] = [];
  let fallbackQueried = false;
  let patchedVacancyId: number | null = null;

  const stub: FetchStub = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();

    if (!url.pathname.endsWith("/rest/v1/position_vacancies")) {
      throw new Error(`unexpected fetch target: ${method} ${url.pathname}`);
    }

    if (method === "PATCH") {
      const idFilter = url.searchParams.get("id") ?? "";
      patchedVacancyId = idFilter.startsWith("eq.") ? Number(idFilter.slice(3)) : null;
      return json([{ id: patchedVacancyId }]);
    }

    const managerFilter = url.searchParams.get("manager_hr_id");
    if (managerFilter) managerHrIdFiltersSeen.push(managerFilter);

    if (managerFilter === "eq.B-10") {
      // The real, stored form -- the vacancy actually managed by B-10.
      return json([
        { id: 501, department_id: null, manager_hr_id: "B-10", manager_name: "Dina DSM", replacement_for_hr_id: null },
      ]);
    }

    if (managerFilter === "is.null") {
      fallbackQueried = true;
      // An unrelated, unmanaged vacancy on the same area/line/position -- the WRONG seat a
      // missed canonical match would fall through to and close instead.
      return json([
        { id: 999, department_id: null, manager_hr_id: null, manager_name: null, replacement_for_hr_id: null },
      ]);
    }

    // Any other manager_hr_id filter (e.g. the un-canonicalized "eq.b-10") is what a raw,
    // un-canonicalized query would send, and on real Supabase data matches nothing.
    return json([]);
  };

  // supabaseRest() requires these via getRequiredEnv() regardless of test context (there is no
  // injectable client here, unlike seat-transfer.ts) -- CI's validate job does not set them for
  // this test, so they must be stubbed for the duration of the call. global.fetch is mocked
  // above, so no request ever actually leaves the process.
  const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  try {
    await withFetch(stub, async () => {
      const closed = await closeVacancyOnHire({
        area_id: 10,
        department_id: null,
        filled_by_hr_id: "B-201",
        line_id: 2,
        manager_name: "Dina DSM",
        manager_hr_id: "b-10", // mixed case, as a hire form / import row can carry it
        position_id: 30,
      });

      assert.deepEqual(
        managerHrIdFiltersSeen,
        ["eq.B-10"],
        "the manager_hr_id filter reaches PostgREST already canonicalized to the stored uppercase form",
      );
      assert.equal(
        fallbackQueried,
        false,
        "the canonical match succeeds on the first query, so the weaker manager-less-vacancy fallback is never reached",
      );
      assert.equal(
        closed?.id,
        501,
        "the vacancy actually managed by B-10 is the one closed, not the unrelated manager-less vacancy 999 the fallback would have picked",
      );
      assert.equal(patchedVacancyId, 501, "the PATCH that marks a vacancy filled targets vacancy 501, never 999");
    });
  } finally {
    if (prevUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
}
