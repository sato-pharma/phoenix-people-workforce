/**
 * A manager's board prints every person by their proper name, whatever their status (NSM audit, 2026-10-26).
 *
 *   1. The National Sales Manager's Top Reps board printed a departed district manager in the Source of Sales
 *      file's capitals beside every active one in proper case, because the directory it swapped names from holds
 *      ACTIVE staff only. `personNameLookup` now asks `employees` by HR id, any status, for the ids the directory
 *      did not answer — nickname first, then full name.
 *   2. The Business Review's district filter and cards printed "SAHAR EL GALLAD": the review directory took
 *      `full_name` raw and ignored the nickname. `reviewDisplayName` is nickname-first and tidies capitals.
 *   3. A name the HR team typed in mixed case is never re-cased — only an all-capitals Latin name is tidied.
 */
import assert from "node:assert/strict";

import { resolvePersonDisplayName, tidyAllCapitalsName } from "@/lib/employees/display-name";
import type { EmployeeNameLookupClient } from "@/lib/employees/names-by-hr-id";
import { personNameLookup } from "@/lib/employees/person-name-lookup";
import { reviewRepName } from "@/lib/business-review/rep-name";
import { reviewDisplayName } from "@/lib/business-review/sources/roles";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

import { fakeSupabaseClient } from "./fixtures/fake-supabase-table";

type Row = { hr_id: string; full_name: string; nickname?: string | null; employment_status?: string };

function client(rows: Row[]) {
  return fakeSupabaseClient({ employees: rows }) as unknown as EmployeeNameLookupClient;
}

export async function runBusinessReviewPersonNamesTests() {
  // ── 1. The departed manager on the Top Reps board ─────────────────────────────────────────────────
  {
    const lookup = await personNameLookup(
      [{ hrId: "PD-0028", displayName: "Sahar El Gallad" }],
      ["B-23", "PD-0028", "B-999"],
      client([
        { hr_id: "B-23", full_name: "Yehya Kamal", nickname: null, employment_status: "resigned" },
        { hr_id: "PD-0028", full_name: "SAHAR EL GALLAD", nickname: null, employment_status: "active" },
      ]),
    );
    assert.equal(
      lookup("B-23", "YEHYA MOHAMED KAMAL ELDEEN SAAD MOHAMED"),
      "Yehya Kamal",
      "a manager who has LEFT is printed by the employees row's name, never the sales file's capitals",
    );
    assert.equal(lookup("b23", "x"), "Yehya Kamal", "any spelling of the HR id finds the same person");
    assert.equal(lookup("PD-0028", "SAHAR EL GALLAD"), "Sahar El Gallad", "an active person keeps the directory's name");
    assert.equal(lookup("B-999", "MONA SAMIR"), "Mona Samir", "no row anywhere → the fallback, tidied out of capitals");
    assert.equal(lookup(null, "Unassigned"), "Unassigned");
  }
  {
    // A failed read costs the departed names, never the page.
    const broken = fakeSupabaseClient({ employees: [] }, { failOn: { employees: "connection reset by peer" } });
    const lookup = await personNameLookup([], ["B-23"], broken as unknown as EmployeeNameLookupClient);
    assert.equal(lookup("B-23", "YEHYA KAMAL"), "Yehya Kamal");
  }

  // ── 2. The Business Review directory: nickname first, capitals tidied ─────────────────────────────
  assert.equal(reviewDisplayName({ full_name: "SAHAR EL GALLAD", nickname: null }, "PD-0028"), "Sahar El Gallad");
  assert.equal(
    reviewDisplayName({ full_name: "Hana Abdelaziz Samir Abdelaziz", nickname: "Hana Abdelaziz" }, "B-110"),
    "Hana Abdelaziz",
    "the review prints the nickname the person is known by, as every other board does",
  );
  assert.equal(reviewDisplayName({ full_name: "", nickname: "" }, "B-77"), "B-77");

  // ── 3. Only an all-capitals Latin name is re-cased ────────────────────────────────────────────────
  assert.equal(tidyAllCapitalsName("Mohamed ElSayed"), "Mohamed ElSayed", "a mixed-case name stays exactly as stored");
  assert.equal(tidyAllCapitalsName("AHMED ABD-EL RAHMAN"), "Ahmed Abd-El Rahman");
  assert.equal(tidyAllCapitalsName("محمد علي"), "محمد علي", "an Arabic name has no case and is left alone");
  assert.equal(resolvePersonDisplayName("SAHAR EL GALLAD", null, "PD-0028"), "Sahar El Gallad");

  // ── 4. A rep's own review and pack are headed with her name, never her HR id (2026-10-29) ──────────
  //
  // The session carries no name, so the scope's viewerName is the HR id; a rep the review's people rows
  // did not hold exported a pack whose cover read "ai-0029 · Pedia Line".
  {
    const people = [{ hrId: "X-1", name: "Dalia Fikry" }];
    assert.equal(
      await reviewRepName(
        { fallback: "x-2", hrId: "X-2", people },
        client([{ hr_id: "X-2", full_name: "Nour Hany Wagdy", nickname: "Nour Hany" }]),
      ),
      "Nour Hany",
      "a rep with no row among the review's people is asked of employees — nickname first",
    );
    assert.equal(
      await reviewRepName(
        { fallback: "x-1", hrId: "X-1", people },
        client([{ hr_id: "X-1", full_name: "Someone Else", nickname: null }]),
      ),
      "Dalia Fikry",
      "the review's own people row still answers first",
    );
    const broken = fakeSupabaseClient({ employees: [] }, { failOn: { employees: "connection reset by peer" } });
    assert.equal(
      await reviewRepName({ fallback: "x-3", hrId: "X-3", people: [] }, broken as unknown as EmployeeNameLookupClient),
      "x-3",
      "a failed read costs the name, never the page",
    );
    for (const file of ["app/api/business-review/pack/route.ts", "app/employee-portals/business-review/page.tsx"]) {
      assert.match(
        stripComments(readFileSync(file, "utf8")),
        // awaited alone, or one member of the page's read wave (1 Nov 2026)
        /(?:await |^\s*)reviewRepName\(\{/m,
        `${file} heads the rep's review with reviewRepName, never the scope's HR-id fallback`,
      );
    }
  }
}
