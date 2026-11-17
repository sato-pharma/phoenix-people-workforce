import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  earlierWaitingMessage,
  findEarlierWaitingRequest,
  vacationBalancePool,
  type EarlierWaitingRequest,
} from "../src/lib/vacation/earlier-waiting.ts";

/**
 * APPROVE THE EARLIER REQUEST FIRST — A WARNING, NEVER A BLOCK (owner, 2026-11-17, from the Ragaa
 * audit). A request is priced at approval against the paid days already approved in its pool, so
 * approving a later request first lets it take the balance and leaves the earlier one unpaid: Ragaa's
 * November sick request VAC-0729 was approved before her October one VAC-0647 and took the whole sick
 * allowance. The approver of the later request is now told to approve the earlier one first.
 */

function other(overrides: Partial<EarlierWaitingRequest> & Pick<EarlierWaitingRequest, "id" | "startDate">): EarlierWaitingRequest {
  return { endDate: overrides.startDate, requestCode: null, status: "pending_hr", vacationType: "sick", ...overrides };
}

function read(relative: string) {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

export function runVacationEarlierWaitingWarningTests() {
  // 1. The Ragaa order: November is being decided while October, same sick pool, still waits.
  {
    const october = other({ id: "vac-0647", requestCode: "VAC-0647", startDate: "2026-10-03", endDate: "2026-11-07" });
    const hit = findEarlierWaitingRequest({
      others: [october],
      request: { id: "vac-0729", startDate: "2026-11-01", status: "pending_hr", vacationType: "sick" },
    });
    assert.equal(hit?.id, "vac-0647", "the later request must be told an earlier one in its pool is still waiting");
    const message = earlierWaitingMessage(hit!);
    assert.match(message, /VAC-0647/, "the warning names the earlier request");
    assert.match(message, /2026-10-03 to 2026-11-07/, "the warning names its dates");
    assert.match(message, /Approve that one first/, "the warning says what to do");
  }

  // 2. The earlier request itself is never warned about the later one — order only runs one way.
  {
    const hit = findEarlierWaitingRequest({
      others: [other({ id: "vac-0729", startDate: "2026-11-01" })],
      request: { id: "vac-0647", startDate: "2026-10-03", status: "pending_hr", vacationType: "sick" },
    });
    assert.equal(hit, null, "a request with only LATER waiting requests gets no warning");
  }

  // 3. Pools: annual and emergency share one; sick, other stand alone; compensatory draws on none.
  {
    assert.equal(vacationBalancePool("annual"), vacationBalancePool("emergency"));
    assert.notEqual(vacationBalancePool("sick"), vacationBalancePool("annual"));
    assert.equal(vacationBalancePool("compensatory"), null);
    const emergencyBeforeAnnual = findEarlierWaitingRequest({
      others: [other({ id: "e", startDate: "2026-07-01", vacationType: "emergency" })],
      request: { id: "a", startDate: "2026-08-01", status: "pending_manager", vacationType: "annual" },
    });
    assert.equal(emergencyBeforeAnnual?.id, "e", "an earlier emergency request waits in the annual pool");
    const sickBeforeAnnual = findEarlierWaitingRequest({
      others: [other({ id: "s", startDate: "2026-07-01", vacationType: "sick" })],
      request: { id: "a", startDate: "2026-08-01", status: "pending_manager", vacationType: "annual" },
    });
    assert.equal(sickBeforeAnnual, null, "a sick request does not draw on the annual balance");
    const compensatory = findEarlierWaitingRequest({
      others: [other({ id: "c0", startDate: "2026-07-01", vacationType: "compensatory" })],
      request: { id: "c1", startDate: "2026-08-01", status: "pending_manager", vacationType: "compensatory" },
    });
    assert.equal(compensatory, null, "a compensatory day uses no balance, so order cannot cost anything");
  }

  // 4. Only WAITING requests count, on both sides.
  {
    for (const status of ["approved", "returned", "rejected", "cancelled"]) {
      const hit = findEarlierWaitingRequest({
        others: [other({ id: "old", startDate: "2026-10-01", status })],
        request: { id: "new", startDate: "2026-11-01", status: "pending_hr", vacationType: "sick" },
      });
      assert.equal(hit, null, `an earlier ${status} request has nothing left to approve`);
    }
    for (const status of ["needs_assignment", "pending_manager", "pending_hr"]) {
      const hit = findEarlierWaitingRequest({
        others: [other({ id: "old", startDate: "2026-10-01", status })],
        request: { id: "new", startDate: "2026-11-01", status: "pending_hr", vacationType: "sick" },
      });
      assert.equal(hit?.id, "old", `an earlier ${status} request is still waiting`);
    }
    const decided = findEarlierWaitingRequest({
      others: [other({ id: "old", startDate: "2026-10-01" })],
      request: { id: "new", startDate: "2026-11-01", status: "approved", vacationType: "sick" },
    });
    assert.equal(decided, null, "an already approved request is not warned");
  }

  // 5. Several earlier ones: the EARLIEST is named, and the request never names itself.
  {
    const hit = findEarlierWaitingRequest({
      others: [
        other({ id: "self", startDate: "2026-09-01" }),
        other({ id: "mid", startDate: "2026-10-15" }),
        other({ id: "first", startDate: "2026-10-01" }),
      ],
      request: { id: "self", startDate: "2026-11-01", status: "pending_hr", vacationType: "sick" },
    });
    assert.equal(hit?.id, "first", "the earliest waiting request is the one to approve first");
  }

  // 6. Wiring: the warning reaches every place a leave request is decided.
  {
    const service = read("src/lib/vacation/service.ts");
    assert.match(service, /code: "earlier_waiting_same_pool"/, "the vacation report's warnings carry it");
    assert.match(service, /earlierWaitingMessage: earlierWaiting \? earlierWaitingMessage\(earlierWaiting\) : null/, "the emailed decision link's page data carries it");
    const decisionPage = read("app/(admin)/leave-management/vacation-decision/[id]/page.tsx");
    assert.match(decisionPage, /<EarlierWaitingNotice message=\{data\.earlierWaitingMessage\} \/>/, "the decision page shows it");
    const detail = read("src/components/approvals-hub/vacation-request-detail.tsx");
    assert.match(detail, /<EarlierWaitingNotice message=\{earlierWaitingMessage\} \/>/, "the approvals hub detail shows it");
    for (const page of ["app/(admin)/admin/approvals/vacation/[id]/page.tsx", "app/employee-portals/approvals/vacation/[id]/page.tsx"]) {
      assert.match(read(page), /earlierWaitingMessage=\{earlierWaitingMessage\}/, `${page} passes it to the detail`);
    }
    const hub = read("src/lib/approvals-hub/service.ts");
    assert.match(hub, /export async function getEarlierWaitingMessageForApprovalDetail/);
  }
}
