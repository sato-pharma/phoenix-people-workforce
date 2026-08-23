import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canSeeMarketingCustomer, viewerAreaIdFor } from "@/lib/marketing-requests/service";

/**
 * A marketing customer belongs to a TERRITORY, not to a person.
 *
 * Owner ruling 2026-08-19: *"the customers are assigned to people. They must be assigned to areas.
 * Why? Because the employee resigns and another one is hired in his place, he finds his customers
 * automatically."*
 *
 * The regression these tests exist to catch is the ORIGINAL behaviour: visibility that reads only
 * `owner_hr_id` / `manager_hr_id`. Under that rule a resigned rep's customers become invisible to
 * the person who took over the patch, and the only repair is a manual ownership backfill — which is
 * exactly the day of work this rule abolishes. Delete the area branch in `canSeeMarketingCustomer`
 * and the first assertion below ("the replacement inherits the patch") fails on its own headline.
 *
 * Measured on production the day the rule was set: 97 owned customers, every one already carrying
 * an area and a line, 66 of them on a filled rep seat where the owner WAS the current seat holder —
 * so the data was already right and only the model was wrong.
 */

// Menoufia 2 and Giza - Giza Centers — two real production areas, deliberately chosen because the
// owner's own worked example (a doctor called on by two lines inside ONE area) lives in both.
const MENOUFIA_2 = 1102;
const GIZA_CENTERS = 1113;

const ANTI_INFECTIVE = 1;
const CNS = 3;

function employee(over: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    fullName: `Employee ${over.hrId}`,
    managerHrId: null,
    areaId: null,
    lineId: null,
    ...over,
  } as unknown as EmployeeDirectoryRow;
}

function customer(over: { areaId: number | null; lineId?: number | null; ownerHrId: string | null; managerHrId?: string | null }) {
  return {
    id: "cust-1",
    owner_hr_id: over.ownerHrId,
    manager_hr_id: over.managerHrId ?? null,
    area_id: over.areaId,
    line_id: over.lineId ?? null,
    active: true,
  } as never;
}

function rep(hrId: string, areaId: number | null, lineId: number | null, managerHrId: string | null = "DM-1") {
  return employee({ hrId, areaId, lineId, managerHrId });
}

function accessFor(hrId: string, role: AccessContext["role"] = "Medical Rep"): AccessContext {
  return { hrId, loginId: hrId, role, scope: "self", source: "session" } as AccessContext;
}

/**
 * The source of one function in the marketing service, bounded by the NEXT declaration rather than
 * by a fixed byte count. A fixed window slides off its target the moment anything above it grows,
 * and then passes for the wrong reason.
 */
function marketingServiceFunction(name: string) {
  const source = readFileSync(
    new URL("../src/lib/marketing-requests/service.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `${name} must still exist in the marketing service`);
  const rest = source.slice(start + 1);
  const nextDeclaration = rest.search(/\n(?:export )?(?:async )?function /);
  return nextDeclaration === -1 ? rest : rest.slice(0, nextDeclaration);
}

export function runMarketingCustomerAreaOwnershipTests() {
  // The departed rep is GONE from the directory — that is what a resignation looks like to this
  // code path, and it is why the person-based rule could never recover.
  const departed = "B-900";
  const replacement = rep("B-901", MENOUFIA_2, CNS);
  const crossLineColleague = rep("B-7", MENOUFIA_2, ANTI_INFECTIVE);
  const otherAreaRep = rep("B-59", GIZA_CENTERS, CNS);
  const manager = employee({ hrId: "DM-1", areaId: 29, lineId: null, managerHrId: null });
  const directory = [replacement, crossLineColleague, otherAreaRep, manager];

  const orphaned = customer({ areaId: MENOUFIA_2, lineId: CNS, ownerHrId: departed, managerHrId: null });

  // ── 1. The headline. The replacement inherits the patch with nothing re-stamped. ──────────────
  assert.equal(
    canSeeMarketingCustomer(
      accessFor(replacement.hrId),
      orphaned,
      directory,
      viewerAreaIdFor(accessFor(replacement.hrId), directory),
    ),
    true,
    "A rep hired into the area must see a customer left behind by the rep who resigned — no backfill",
  );

  // ── 2. Prove the OLD rule really did fail, so assertion 1 is not passing for a lazy reason. ───
  // A null viewer area is exactly what the person-based rule amounted to: hierarchy, and nothing
  // else. The same row, the same viewer, the area withheld — and the customer disappears.
  assert.equal(
    canSeeMarketingCustomer(accessFor(replacement.hrId), orphaned, directory, null),
    false,
    "Without the area branch the replacement sees nothing — this is the bug the rule replaces",
  );

  // ── 3. Line-agnostic, per the same ruling he set for pharmacies: one area, one capture. ───────
  // This is the "treasure" case: a doctor called on by two lines inside one area is visible to
  // both reps, with no ownership shifted and nobody's name moved.
  assert.equal(
    canSeeMarketingCustomer(
      accessFor(crossLineColleague.hrId),
      orphaned,
      directory,
      viewerAreaIdFor(accessFor(crossLineColleague.hrId), directory),
    ),
    true,
    "A colleague on a DIFFERENT line in the SAME area must see the customer — shared, not contested",
  );

  // ── 4. It must not over-grant. A different area is still a different territory. ───────────────
  assert.equal(
    canSeeMarketingCustomer(
      accessFor(otherAreaRep.hrId),
      orphaned,
      directory,
      viewerAreaIdFor(accessFor(otherAreaRep.hrId), directory),
    ),
    false,
    "A rep in another area must NOT see the customer — the rule widens to the patch, not the company",
  );

  // ── 5. A row with no area grants nobody anything. ─────────────────────────────────────────────
  // 18 production rows carry a REGION rather than a patch because the app copied the creator's own
  // geography; a null must never degrade into "everyone sees it".
  assert.equal(
    canSeeMarketingCustomer(
      accessFor(replacement.hrId),
      customer({ areaId: null, ownerHrId: departed }),
      directory,
      viewerAreaIdFor(accessFor(replacement.hrId), directory),
    ),
    false,
    "A customer with no area must not become visible to everyone",
  );

  // ── 6. A viewer with no area of their own matches nothing either. ─────────────────────────────
  const areaLessRep = rep("B-902", null, CNS);
  assert.equal(
    canSeeMarketingCustomer(
      accessFor(areaLessRep.hrId),
      orphaned,
      [...directory, areaLessRep],
      viewerAreaIdFor(accessFor(areaLessRep.hrId), [...directory, areaLessRep]),
    ),
    false,
    "A viewer with no area must not match a customer that has one",
  );

  // ── 7. The hierarchy route is untouched — this rule ADDS a way in, it removes none. ───────────
  const ownedByLiveRep = customer({
    areaId: GIZA_CENTERS,
    lineId: CNS,
    ownerHrId: otherAreaRep.hrId,
    managerHrId: manager.hrId,
  });
  assert.equal(
    canSeeMarketingCustomer(
      accessFor(otherAreaRep.hrId),
      ownedByLiveRep,
      directory,
      viewerAreaIdFor(accessFor(otherAreaRep.hrId), directory),
    ),
    true,
    "The owner still sees their own customer through the identity route",
  );
  assert.equal(
    canSeeMarketingCustomer(
      accessFor(manager.hrId, "District Manager"),
      ownedByLiveRep,
      directory,
      viewerAreaIdFor(accessFor(manager.hrId, "District Manager"), directory),
    ),
    true,
    "A District Manager still sees their subtree through the hierarchy route, not the area route",
  );

  // ── 8. viewerAreaIdFor is the single source of the viewer's area. ─────────────────────────────
  assert.equal(viewerAreaIdFor(accessFor(replacement.hrId), directory), MENOUFIA_2);
  assert.equal(viewerAreaIdFor(accessFor("NOT-IN-DIRECTORY"), directory), null);

  // ── 9. The area rule did NOT make the picker's owner filter redundant. ─────────────────────────
  //
  // The rule proven above is exactly the reasoning that would delete the next line of code, so it
  // is pinned here rather than beside the picker. `buildReusableMarketingPharmacies` excludes rows
  // with no `owner_hr_id`, and reading "a venue belongs to an AREA, not a person" invites a
  // session to call that filter a leftover of the ownership model and remove it as a tidy-up.
  //
  // It is not a leftover. Measured on production 2026-08-24: 280 active seeded venues, written by
  // one 2026-06-20 backfill, all `evidence_status = 'missing'`, none owned — and every single
  // one carrying an `area_id`, over 37 areas, up to 26 in a single area. The owner filter is what
  // excludes them and NOTHING else does: the area branch of `canReuseMarketingPharmacy` would
  // offer them to every rep in those 37 areas, and `canSeeMarketingHierarchyRecord` would hand all
  // 280 to every company-wide role. Each one linked parks its customer on "Not Usable Yet" with no
  // route out for anybody.
  assert.match(
    marketingServiceFunction("buildReusableMarketingPharmacies"),
    /\.not\("owner_hr_id", "is", null\)/,
    "The My Pharmacies picker must keep its owner_hr_id filter — it is the ONLY thing excluding the 280 seeded venues, and every one of them carries an area_id, so the area rule offers them to 37 areas the moment it goes",
  );
}
