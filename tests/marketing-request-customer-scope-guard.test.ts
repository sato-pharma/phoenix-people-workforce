import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { assertMarketingCustomerIsInScope } from "@/lib/marketing-requests/service";

/**
 * A marketing request may only be raised against a customer the requester can actually SEE.
 *
 * The gap this closes: `createMarketingRequestDraft` and `resubmitReturnedMarketingRequest` loaded
 * the customer with `.eq("id", normalized.customerId)` and then checked only that the row existed
 * and was active. Nothing checked visibility. The dropdown a requester picks from IS scoped — it is
 * filtered through `canSeeMarketingCustomer` — but the request body carries a raw `customerId`, and
 * a picker is a convenience, not a boundary. Any marketing-capable employee who knew or guessed a
 * customer id could therefore raise a spend request against a customer on somebody else's patch,
 * and it would enter the approval chain looking like any other request.
 *
 * The guard deliberately reuses the READ predicate rather than inventing a stricter one, so the
 * picker and the server can never disagree about what is in scope — including the territory route
 * from the 2026-08-19 ruling (see tests/marketing-customer-area-ownership.test.ts), which is what
 * lets the rep hired into a resigned rep's patch request for the customers they inherited.
 *
 * Measured on production before shipping: of the 9 rows then in `marketing_requests`, 0 would have
 * been refused — 8 raised by the customer's own owner, 1 by the Marketing Manager, whose
 * company-wide oversight role passes on the first branch. Cases 1 and 4 below are those two real
 * shapes, so a change that would have blocked live work fails here first.
 *
 * Delete either `assertMarketingCustomerIsInScope` call site and the wiring block at the end fails
 * on its own headline; weaken the predicate and case 3 ("another area is refused") fails on its.
 */

// Two real production areas, the same pair the area-ownership test uses.
const MENOUFIA_2 = 1102;
const GIZA_CENTERS = 1113;

const ANTI_INFECTIVE = 1;
const CNS = 3;

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function employee(over: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    fullName: `Employee ${over.hrId}`,
    managerHrId: null,
    areaId: null,
    lineId: null,
    ...over,
  } as unknown as EmployeeDirectoryRow;
}

function rep(hrId: string, areaId: number | null, lineId: number | null, managerHrId: string | null = "DM-1") {
  return employee({ hrId, areaId, lineId, managerHrId });
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

function accessFor(hrId: string, role: AccessContext["role"] = "Medical Rep"): AccessContext {
  return { hrId, loginId: hrId, role, scope: "self", source: "session" } as AccessContext;
}

/** The refusal the guard must produce: a 403, with the wording the pharmacy guard set the style for. */
function assertRefused(run: () => void, why: string) {
  assert.throws(
    run,
    (error: unknown) => {
      const api = error as { status?: number; code?: string; message?: string };
      assert.equal(api.status, 403, `${why} — must be a 403, not a validation or not-found error`);
      assert.equal(api.code, "forbidden", `${why} — must carry the forbidden code`);
      assert.equal(
        api.message,
        "Forbidden: that customer is not one you can raise a request for.",
        `${why} — must say plainly what was refused`,
      );
      return true;
    },
    why,
  );
}

export function runMarketingRequestCustomerScopeGuardTests() {
  const owner = rep("B-901", MENOUFIA_2, CNS);
  const crossLineColleague = rep("B-7", MENOUFIA_2, ANTI_INFECTIVE);
  const strangerRep = rep("B-59", GIZA_CENTERS, CNS);
  const manager = employee({ hrId: "DM-1", areaId: 29, lineId: null, managerHrId: null });
  const marketingManager = employee({ hrId: "A-9", areaId: 80, lineId: 4, managerHrId: "AA" });
  const directory = [owner, crossLineColleague, strangerRep, manager, marketingManager];

  const ownedCustomer = customer({
    areaId: MENOUFIA_2,
    lineId: CNS,
    ownerHrId: owner.hrId,
    managerHrId: manager.hrId,
  });

  // ── 1. The ordinary case, and 8 of the 9 real production rows: the owner requests for their own. ──
  assert.doesNotThrow(
    () => assertMarketingCustomerIsInScope(accessFor(owner.hrId), ownedCustomer, directory),
    "The customer's own owner must still be able to raise a request — this is what 8 of 9 live requests are",
  );

  // ── 2. The inherited patch. The owner resigned and is GONE from the directory; the replacement
  //       still works that area, so the customers on it are still theirs to spend against. ────────
  const departedOwnersCustomer = customer({ areaId: MENOUFIA_2, lineId: CNS, ownerHrId: "B-900" });
  assert.doesNotThrow(
    () => assertMarketingCustomerIsInScope(accessFor(owner.hrId), departedOwnersCustomer, directory),
    "A rep must be able to request for a customer left behind in their own area — the territory route, not a backfill",
  );

  // ── 3. THE HEADLINE. Another rep's patch is refused, which is the hole this guard closes. ──────
  //       Before it, this exact call wrote a request row and opened an approval chain.
  assertRefused(
    () => assertMarketingCustomerIsInScope(accessFor(strangerRep.hrId), ownedCustomer, directory),
    "A rep in another area must not raise a spend request against a customer on somebody else's patch",
  );

  // ── 4. The 9th real production row: the Marketing Manager's company-wide oversight still passes. ─
  //       MKT-REQ-20260811-FF5B0719 matches on neither owner nor area and would break without this.
  assert.doesNotThrow(
    () => assertMarketingCustomerIsInScope(accessFor(marketingManager.hrId, "Marketing Manager"), ownedCustomer, directory),
    "The Marketing Manager is a company-wide marketing role and must keep raising requests anywhere",
  );

  // ── 5. Line-agnostic, matching the read rule: same area, different line, still in scope. ───────
  assert.doesNotThrow(
    () => assertMarketingCustomerIsInScope(accessFor(crossLineColleague.hrId), ownedCustomer, directory),
    "A colleague on another line in the SAME area shares the customer — the cross-line 'treasure' case",
  );

  // ── 6. A customer with no area must not become raise-able by everyone. ────────────────────────
  assertRefused(
    () => assertMarketingCustomerIsInScope(
      accessFor(strangerRep.hrId),
      customer({ areaId: null, ownerHrId: "B-900" }),
      directory,
    ),
    "A customer carrying no area must not fall open to the whole company",
  );

  // ── 7. The manager route is untouched: a DM still requests across their own subtree. ──────────
  assert.doesNotThrow(
    () => assertMarketingCustomerIsInScope(accessFor(manager.hrId, "District Manager"), ownedCustomer, directory),
    "A District Manager must still raise requests for their own team's customers",
  );

  // ── 8. Wiring. A guard nothing calls is the exact defect being fixed, so pin BOTH call sites. ──
  //       The read filter existed all along; what was missing was anyone invoking it on the way in.
  const serviceSource = source("src/lib/marketing-requests/service.ts");

  const createPath = serviceSource.slice(
    serviceSource.indexOf("export async function createMarketingRequestDraft("),
    serviceSource.indexOf("export async function resubmitReturnedMarketingRequest("),
  );
  assert.ok(createPath.length > 0, "createMarketingRequestDraft must precede resubmitReturnedMarketingRequest in the file");
  assert.match(
    createPath,
    /assertMarketingCustomerIsInScope\(access, customerResult\.data as MarketingCustomerDbRow, employeeRows\)/,
    "createMarketingRequestDraft must check customer visibility before it writes anything",
  );
  assert.ok(
    createPath.indexOf("assertMarketingCustomerIsInScope") < createPath.indexOf("prepareMarketingRequestDraft("),
    "the create-path guard must run BEFORE the draft is prepared, not after rows are built",
  );

  const resubmitPath = serviceSource.slice(serviceSource.indexOf("export async function resubmitReturnedMarketingRequest("));
  assert.match(
    resubmitPath,
    /assertMarketingCustomerIsInScope\(access, customerResult\.data as MarketingCustomerDbRow, employeeRows\)/,
    "resubmitReturnedMarketingRequest must re-check visibility — the edited payload can swap the customer",
  );
  assert.ok(
    resubmitPath.indexOf("assertMarketingCustomerIsInScope") < resubmitPath.indexOf("prepareMarketingRequestDraft("),
    "the resubmit-path guard must run BEFORE the draft is prepared",
  );
}
