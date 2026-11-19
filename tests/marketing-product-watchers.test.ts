import assert from "node:assert/strict";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import { resolveCaseFileAdmission } from "../src/lib/marketing-requests/case-file-service.ts";
import {
  isMarketingProductWatcher,
  isWatchedMarketingEvent,
  marketingProductWatcherHrIds,
  marketingWatcherNoticeWording,
  watchedMarketingProductCodes,
  watchesMarketingRequestProducts,
  type MarketingWatchedEvent,
} from "../src/lib/marketing-requests/product-watchers.ts";
import {
  getMarketingWatchedProductRequests,
  summarizeMarketingWatchedRequests,
} from "../src/lib/marketing-requests/service.ts";

// Marketing PRODUCT WATCHERS (owner, 2026-11-19): "make Ahmed Sharaf have access and notification
// for Guamusin and Ivyronc marketing requests — he can not approve or reject but he can comment —
// also show the historical requests for these products."
//
// Every assertion calls the real exported function. What each group protects:
//   1. The named list — Ahmed SharafEldeen (B-155) watches exactly Guamusin and Ivyronc, NOT the
//      other two codes in his product scope, and nobody else watches anything.
//   2. Admission — a watcher reads the Case File in full (so the conversation he comments in is
//      mounted), from any role, and only on a request that promotes a watched product.
//   3. The notice — never the approver's "needs your approval" wording, and never the SLA reminders.
//   4. The list — refused to a non-watcher before any read; its tiles are counted from its rows.

const AHMED_SHARAF = "B-155";
const AHMED_ASHRAF_MEDICAL_REP = "B-143";

function ctx(role: PhoenixRole, hrId: string, overrides: Partial<AccessContext> = {}): AccessContext {
  return { hrId, loginId: hrId.toLowerCase(), role, scope: "line", source: "session", ...overrides };
}

function admission(access: AccessContext, requestProductCodes: string[]) {
  return resolveCaseFileAdmission({
    access,
    assignedSteps: [{ assignedHrId: "B-2", isCc: false }],
    hierarchyAllows: false,
    requestProductCodes,
    requesterHrId: "B-900",
    viewerOwnedProductCodes: null,
    viewerWatchedProductCodes: watchedMarketingProductCodes(access.hrId),
  });
}

function testTheNamedList() {
  assert.deepEqual(
    [...watchedMarketingProductCodes(AHMED_SHARAF)].sort(),
    ["GU001", "IV001"],
    "the owner named Guamusin and Ivyronc — not Tigogrow or Osteosat, though both are in his product scope",
  );
  assert.equal(isMarketingProductWatcher(AHMED_SHARAF), true);
  assert.equal(isMarketingProductWatcher("b155"), true, "an HR id in another spelling is still the same person");
  assert.equal(
    isMarketingProductWatcher(AHMED_ASHRAF_MEDICAL_REP),
    false,
    "Ahmed Ashraf the Medical Rep is NOT the person the owner meant ('ahmed sharaf i mean')",
  );
  assert.equal(isMarketingProductWatcher(null), false, "no HR id watches nothing");
  assert.equal(isMarketingProductWatcher(""), false);

  assert.equal(watchesMarketingRequestProducts(AHMED_SHARAF, ["gu001"]), true, "codes compare case-blind");
  assert.equal(watchesMarketingRequestProducts(AHMED_SHARAF, ["TG001", "OS001"]), false);
  assert.equal(watchesMarketingRequestProducts(AHMED_SHARAF, []), false, "a request with no products is nobody's");

  assert.deepEqual(marketingProductWatcherHrIds(["IV001", "XX999"]), [AHMED_SHARAF]);
  assert.deepEqual(marketingProductWatcherHrIds(["TG001"]), [], "a request for an unwatched product tells no watcher");
  assert.deepEqual(marketingProductWatcherHrIds([]), []);
}

function testAdmission() {
  const asPm = admission(ctx("Product Manager", AHMED_SHARAF), ["GU001"]);
  assert.deepEqual(asPm, ["product_watcher"], "a watcher with no rung is admitted on the watcher arm alone");
  assert.ok(
    asPm.some((arm) => arm !== "product_owner"),
    "the watcher arm is NOT the narrowed product-owner read — the Case File mounts the conversation for him",
  );

  const asEmployee = admission(ctx("Employee", AHMED_SHARAF), ["IV001"]);
  assert.deepEqual(asEmployee, ["product_watcher"], "the list is by person, so any role he holds is admitted");

  assert.deepEqual(
    admission(ctx("Product Manager", AHMED_SHARAF), ["TG001"]),
    [],
    "a request that promotes none of his watched products stays closed to him",
  );
  assert.deepEqual(
    admission(ctx("Product Manager", AHMED_ASHRAF_MEDICAL_REP), ["GU001"]),
    [],
    "someone not on the list is not admitted by the product alone",
  );
  assert.deepEqual(
    resolveCaseFileAdmission({
      access: ctx("Product Manager", AHMED_SHARAF),
      assignedSteps: [],
      hierarchyAllows: false,
      requestProductCodes: ["GU001"],
      requesterHrId: null,
      viewerOwnedProductCodes: null,
    }),
    [],
    "with no watched codes passed in, nothing is admitted — the arm reads only what it is handed",
  );
}

function testTheNotice() {
  for (const eventType of ["request_assigned", "request_returned", "request_approved", "request_rejected", "request_completed"] as const) {
    assert.equal(isWatchedMarketingEvent(eventType), true, `${eventType}: every move of the request reaches the watcher`);
  }
  for (const eventType of ["due_date_reminder", "overdue_reminder"]) {
    assert.equal(
      isWatchedMarketingEvent(eventType),
      false,
      `${eventType}: a reminder is an approver's nudge to act — a watcher holds no rung and cannot act`,
    );
  }

  const events: MarketingWatchedEvent[] = ["request_assigned", "request_returned", "request_approved", "request_rejected", "request_completed"];
  for (const eventType of events) {
    for (const currentStepName of ["Group Product Manager", null]) {
      const { message, title } = marketingWatcherNoticeWording({ currentStepName, eventType, requestCode: "MR-0042" });
      const text = `${title} ${message}`;
      assert.doesNotMatch(
        text,
        /needs your approval|please approve|approve or reject|awaiting your/i,
        `${eventType}: a watcher is never told to decide — he has no button to press`,
      );
      assert.match(title, /^MR-0042 /, "the request is named by its code first");
      assert.match(message, /hold no approval step/, "the notice says plainly that he cannot decide");
      assert.match(message, /comment/, "and that he can comment");
    }
  }
  assert.equal(
    marketingWatcherNoticeWording({ currentStepName: "Group Product Manager", eventType: "request_assigned", requestCode: "MR-1" }).title,
    "MR-1 is now with Group Product Manager",
  );
  assert.equal(
    marketingWatcherNoticeWording({ currentStepName: "", eventType: "request_assigned", requestCode: "" }).title,
    "A marketing request moved to its next approval step",
    "a missing step or code still reads as a sentence",
  );
}

async function testTheList() {
  await assert.rejects(
    () => getMarketingWatchedProductRequests(ctx("Product Manager", AHMED_ASHRAF_MEDICAL_REP)),
    /do not follow any marketing products/,
    "the list is refused to anyone who watches nothing, before any read — the page gate is UX only",
  );

  const summary = summarizeMarketingWatchedRequests([
    { outcome: "in_flight" },
    { outcome: "in_flight" },
    { outcome: "approved" },
    { outcome: "rejected" },
    { outcome: "returned" },
    { outcome: "cancelled" },
    { outcome: "closed" },
    { outcome: "archived" },
  ]);
  assert.deepEqual(summary, { approved: 1, closedOrCancelled: 3, inApproval: 2, rejected: 1, returned: 1, total: 8 });
  assert.deepEqual(summarizeMarketingWatchedRequests([]).total, 0, "an empty list counts zero, never a guess");
}

export async function runMarketingProductWatchersTests() {
  testTheNamedList();
  testAdmission();
  testTheNotice();
  await testTheList();
}
