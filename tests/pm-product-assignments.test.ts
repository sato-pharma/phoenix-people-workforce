// PM PRODUCT ASSIGNMENTS — `setPmProductCodes` must read the errors it was ignoring.
//
// Found 2026-09-30 by the org select-audit. supabase-js RETURNS a failure in `error` rather than
// throwing it, and neither the delete nor the insert destructured it — so the route's own try/catch
// caught nothing and it answered `{ok: true}` whatever happened. The delete runs FIRST, so a failed
// insert left the Product Manager with NO products while the screen said saved, and the module's
// reads are deliberately table-missing-safe, so Employee 360 then attributed his sales through the
// (usually empty) team roll-up with nothing anywhere to show it had gone wrong. No schema change was
// needed to fire it: any constraint breach or transient error did.
//
// The two steps cannot be atomic through PostgREST, so surfacing the insert's error IS the fix —
// the admin is told the list was cleared and can save again, instead of believing it stuck.

import { strict as assert } from "node:assert";

import { setPmProductCodes } from "../src/lib/employee-360/pm-products.ts";

type InsertedRow = { hr_id: string; product_code: string; created_by: string };
type Calls = { deleted: number; inserted: InsertedRow[][] };

/**
 * The two PostgREST chains this function builds: `.from().delete().ilike()` and `.from().insert()`.
 * A stub rather than a live client — a real database will not fail on demand, and the failure
 * branches are the whole point of these cases.
 */
function stubDb(opts: { deleteError?: string; insertError?: string } = {}) {
  const calls: Calls = { deleted: 0, inserted: [] };
  const chain = {
    from: () => chain,
    delete: () => chain,
    ilike: () => {
      calls.deleted += 1;
      return Promise.resolve({ error: opts.deleteError ? { message: opts.deleteError } : null });
    },
    insert: (rows: InsertedRow[]) => {
      calls.inserted.push(rows);
      return Promise.resolve({ error: opts.insertError ? { message: opts.insertError } : null });
    },
  };
  return { db: chain as unknown as Parameters<typeof setPmProductCodes>[3], calls };
}

async function thrownBy(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error as Error;
  }
}

export async function runPmProductAssignmentTests() {
  // 1. The happy path still writes what it always wrote, de-duplicated and stamped with the actor.
  {
    const { db, calls } = stubDb();
    await setPmProductCodes("PM-001", [" SA001 ", "SA001", "LA002", ""], "B-10", db);
    assert.equal(calls.deleted, 1, "the previous assignments are cleared first");
    assert.deepEqual(
      calls.inserted[0],
      [
        { hr_id: "PM-001", product_code: "SA001", created_by: "B-10" },
        { hr_id: "PM-001", product_code: "LA002", created_by: "B-10" },
      ],
      "codes are trimmed, de-duplicated and blanks dropped — unchanged by this fix",
    );
  }

  // 2. Clearing a PM's list writes nothing, and must not insert an empty batch.
  {
    const { db, calls } = stubDb();
    await setPmProductCodes("PM-001", [], "B-10", db);
    assert.equal(calls.deleted, 1, "an empty selection still clears");
    assert.equal(calls.inserted.length, 0, "and never sends an empty insert");
  }

  // 3. A FAILED DELETE must throw. Nothing was changed, and the message has to say so.
  {
    const { db, calls } = stubDb({ deleteError: "permission denied for table pm_product_assignments" });
    const error = await thrownBy(() => setPmProductCodes("PM-001", ["SA001"], "B-10", db));
    assert.ok(error, "a failed delete must throw — returning normally reports a save that never happened");
    assert.match(error!.message, /nothing was changed/i, "the message must say the assignments are untouched");
    assert.equal(calls.inserted.length, 0, "and it must not go on to insert over a clear that failed");
  }

  // 4. THE ONE THAT MATTERS. A failed insert leaves the PM with NO products, because the delete
  // already succeeded. Reporting success here is what hid it: the screen said saved while his
  // product attribution silently fell back to the team roll-up.
  {
    const { db } = stubDb({ insertError: 'duplicate key value violates unique constraint "pm_product_assignments_hr_id_product_code_key"' });
    const error = await thrownBy(() => setPmProductCodes("PM-001", ["SA001"], "B-10", db));
    assert.ok(
      error,
      "a failed insert must THROW — the delete already ran, so returning normally tells the admin the "
        + "list was saved when it is in fact empty",
    );
    assert.match(
      error!.message,
      /currently has none/i,
      "the message must say the Product Manager now has none, so the admin knows to save again — the "
        + "two steps cannot be atomic, which is exactly why the failure has to be visible",
    );
    assert.match(error!.message, /duplicate key value/, "and it must carry the database's own reason");
  }
}
