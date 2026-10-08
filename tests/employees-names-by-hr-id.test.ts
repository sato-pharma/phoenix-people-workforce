/**
 * The shared HR id → name lookup, driven against the in-memory Supabase fake.
 *
 * WHY A FAKE AND NOT THE DATABASE. This repo's suite runs with PRODUCTION credentials, so a test
 * that read the real `employees` table would both reach live data and prove nothing repeatable. The
 * fake is a real query engine over seeded rows, which is what lets these assertions be about the
 * BEHAVIOUR — the chunk boundary, the spelling that is actually sent, the failed chunk — rather than
 * about the shape of the source.
 *
 * Three call sites were folded onto this function: the production planner's grant list, the
 * recruiter's vacancy stand-ins and the CV shelf's filer column. Each had its own copy, and they had
 * already drifted — the planner's did not chunk. These are the behaviours that keep them identical.
 */
import assert from "node:assert/strict";

import { HR_ID_LOOKUP_CHUNK, namesByHrId, type EmployeeNameLookupClient } from "@/lib/employees/names-by-hr-id";

import { fakeSupabaseClient } from "./fixtures/fake-supabase-table";

type Row = { hr_id: string; full_name: string; nickname?: string | null };

function client(rows: Row[]) {
  return fakeSupabaseClient({ employees: rows }) as unknown as EmployeeNameLookupClient;
}

/** Records every `.in("hr_id", …)` batch the lookup sends, and optionally fails one of them. */
function recording(rows: Row[], failNth?: number) {
  const good = fakeSupabaseClient({ employees: rows });
  const broken = fakeSupabaseClient({ employees: rows }, { failOn: { employees: "connection reset by peer" } });
  const batches: string[][] = [];
  let calls = 0;
  const db = {
    from(table: string) {
      calls += 1;
      const picked = (calls === failNth ? broken : good).from(table);
      return {
        select(columns: string) {
          const query = picked.select(columns);
          return {
            in(column: string, values: string[]) {
              batches.push([...values]);
              return query.in(column, values);
            },
          };
        },
      };
    },
  };
  return { batches, db: db as unknown as EmployeeNameLookupClient };
}

export async function runEmployeeNamesByHrIdTests() {
  // ── THE WHOLE POINT: THE STORED SPELLING IS NOT THE ASKED-FOR SPELLING ──────────────────────────
  //
  // Production stores `hr_id` upper-case and the app holds lower-case comparison keys in plenty of
  // places. A bare `.eq`/`.in` on the asked-for spelling matches nothing and returns NO ERROR, so
  // this is the assertion that separates a working lookup from a silently empty one.
  {
    const names = await namesByHrId(["b-10"], client([{ hr_id: "B-10", full_name: "Omar Gawish" }]));
    assert.equal(
      names.get("b-10"),
      "Omar Gawish",
      "a lower-case id must resolve the upper-case stored row — PostgREST matches case-sensitively and returns no error when it misses",
    );
    assert.equal(names.size, 1, "one person asked for, one person resolved");
  }

  // The accessor canonicalises on the way IN as well, so a caller holding any spelling gets the
  // name. Every hand-written copy made its callers write `map.get(canonicalHrIdKey(id) ?? "")`,
  // where the `?? ""` quietly looks up the empty key instead of saying "no id".
  {
    const names = await namesByHrId(["B-10"], client([{ hr_id: "b-10", full_name: "Omar Gawish" }]));
    for (const spelling of ["B-10", "b-10", " b-10 "]) {
      assert.equal(names.get(spelling), "Omar Gawish", `the index must answer to the spelling "${spelling}"`);
    }
    assert.equal(names.get(null), null, "a null id is not a lookup of the empty key — it is no name");
    assert.equal(names.get(""), null, "an empty id is not a lookup of the empty key — it is no name");
    assert.equal(names.get("ZZ-99"), null, "an id nobody holds resolves to null, never to a blank string");
  }

  // ── NICKNAME-AWARE, so one person reads the same on every screen ────────────────────────────────
  {
    const names = await namesByHrId(
      ["A-1", "A-2"],
      client([
        { hr_id: "A-1", full_name: "Hany Saad Mohamed Omar", nickname: "Hany Saad" },
        { hr_id: "A-2", full_name: "Sameh Shabaan El Hoseiny El Hoseiny", nickname: null },
      ]),
    );
    assert.equal(names.get("A-1"), "Hany Saad", "the nickname is the display name where one is stored");
    assert.equal(
      names.get("A-2"),
      "Sameh Shabaan El Hoseiny El Hoseiny",
      "with no nickname the full name stands — never a blank and never the id",
    );
  }

  // A row with no usable name is NOT resolved. Leaving the caller's own fallback in place is the
  // rule: it shows an id or a dash, where a blank name would read as a person with no name.
  {
    const names = await namesByHrId(
      ["A-1", "A-2"],
      client([
        { hr_id: "A-1", full_name: "   " },
        { hr_id: "A-2", full_name: "", nickname: "Nicky" },
      ]),
    );
    assert.equal(names.get("A-1"), null, "a whitespace-only full_name resolves to no name at all");
    assert.equal(names.get("A-2"), null, "a nickname does not rescue an empty full_name — the row is unusable");
    assert.equal(names.size, 0, "an unusable row must not inflate the resolved count");
  }

  // ── THE CHUNK BOUNDARY ──────────────────────────────────────────────────────────────────────────
  //
  // 🔴 A long enough `.in()` filter makes PostgREST return ZERO ROWS AND NO ERROR. The filter is
  // built from every spelling of every id, so it outgrows the id list: this is the fault the
  // planner's unchunked copy was one growing list away from.
  {
    assert.equal(HR_ID_LOOKUP_CHUNK, 50, "the chunk size is 50 keys — raising it walks back toward the length limit");

    const ids = Array.from({ length: 60 }, (_, index) => `E-${index + 1}`);
    const rows = ids.map((hrId) => ({ hr_id: hrId.toLowerCase(), full_name: `Person ${hrId}` }));
    const { batches, db } = recording(rows);
    const names = await namesByHrId(ids, db);

    assert.ok(batches.length > 1, "60 ids must not be sent as one filter — each id becomes two or three spellings");
    for (const [index, batch] of batches.entries()) {
      assert.ok(
        batch.length <= HR_ID_LOOKUP_CHUNK,
        `batch ${index + 1} sent ${batch.length} keys, over the ${HR_ID_LOOKUP_CHUNK}-key chunk`,
      );
    }
    assert.equal(
      batches.flat().length,
      new Set(batches.flat()).size,
      "no spelling is sent twice — the key list is de-duplicated before it is chunked",
    );
    assert.equal(names.size, 60, "every one of the 60 people is still resolved across the chunks");
    assert.equal(names.get("E-60"), "Person E-60", "the last chunk's rows are kept, not dropped on the boundary");
  }

  // ── A FAILED CHUNK COSTS THE NAMES IN IT AND NOTHING ELSE ───────────────────────────────────────
  //
  // Not a throw: a name column must not take down a screen. The caller falls back to whatever it
  // showed before the lookup existed, which is an id — under-reporting a name beats inventing one.
  {
    const ids = Array.from({ length: 60 }, (_, index) => `E-${index + 1}`);
    const rows = ids.map((hrId) => ({ hr_id: hrId.toUpperCase(), full_name: `Person ${hrId}` }));
    const { batches, db } = recording(rows, 1);
    // An expression body, not a block: a block would infer `void` and union itself into the result
    // type. `assert.fail` returns `never`, so this way the index's own type survives the catch.
    const names = await namesByHrId(ids, db).catch((error: unknown) =>
      assert.fail(`a failed chunk must not throw into the caller's page — it threw ${String(error)}`),
    );

    assert.ok(names.size > 0, "a failed FIRST chunk must not empty the whole lookup — the later chunks still ran");
    assert.ok(names.size < 60, "the names in the failed chunk are genuinely lost, not silently refetched");
    assert.ok(batches.length > 1, "the failure test needs more than one chunk to show the rest still ran");
  }

  // Every chunk failing is still not a throw — it is an empty index, the state the callers each
  // already render ("no name on file", the id, a dash).
  {
    const db = fakeSupabaseClient(
      { employees: [{ hr_id: "B-10", full_name: "Omar Gawish" }] },
      { failOn: { employees: "employees is unreachable" } },
    ) as unknown as EmployeeNameLookupClient;
    // Caught here on purpose rather than left to blow the suite up: a throw and a failed assertion
    // are the same red in CI, but only the assertion SAYS which rule broke, and this one is the rule
    // — a name column must never take down the page it decorates.
    const names = await namesByHrId(["B-10"], db).catch((error: unknown) =>
      assert.fail(`a read that fails must not throw into the caller's page — it threw ${String(error)}`),
    );
    assert.equal(names.size, 0, "a read that fails outright resolves no names");
    assert.equal(names.get("B-10"), null, "and answers null rather than a stale or invented name");
  }

  // ── NO IDS, NO QUERY ────────────────────────────────────────────────────────────────────────────
  //
  // Called on an empty list from pages that usually have nothing to resolve, so the round trip has
  // to be skipped rather than sent with an empty filter.
  {
    const { batches, db } = recording([{ hr_id: "B-10", full_name: "Omar Gawish" }]);
    for (const asked of [[], [null], [""], ["   ", undefined]] as Array<Array<string | null | undefined>>) {
      const names = await namesByHrId(asked, db);
      assert.equal(names.size, 0, `asking for ${JSON.stringify(asked)} resolves nothing`);
      assert.equal(names.get("B-10"), null, "and the index stays empty rather than answering from a stale read");
    }
    // Documentation rather than a guard, and worth being honest about: this cannot be made to fail
    // by one edit. Two independent lines keep it true — the early return, and a loop bound that
    // cannot enter its body with no keys — so the pre-guard code sent nothing either.
    assert.equal(batches.length, 0, "an empty id list must send NO query at all");
  }

  // An `Iterable` is accepted, because the callers hold a Set of distinct ids — the planner's grant
  // list and the CV shelf both de-duplicate before asking, and making them spread it back into an
  // array is how a 323-row pool turns into a 323-key filter.
  {
    const { batches, db } = recording([{ hr_id: "B-10", full_name: "Omar Gawish" }]);
    const names = await namesByHrId(new Set(["B-10", "b-10"]), db);
    assert.equal(names.get("B-10"), "Omar Gawish", "a Set of ids is a valid argument, not just an array");
    const sent = batches.flat();
    assert.equal(
      sent.length,
      new Set(sent).size,
      `two spellings of ONE person must not send the same key twice — sent ${JSON.stringify(sent)}`,
    );
  }

  console.log("employees/names-by-hr-id: shared HR id → name lookup OK");
}
