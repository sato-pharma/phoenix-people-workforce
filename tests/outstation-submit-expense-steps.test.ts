import assert from "node:assert/strict";
import { join } from "node:path";

import {
  afterSubmitGuidance,
  firstOpenSubmitExpenseStep,
  MY_CLAIMS_ANCHOR,
  submitExpenseStepInstruction,
  submitExpenseStepProblem,
  submitExpenseSteps,
  type SubmitExpenseFacts,
} from "../src/lib/outstation/submit-expense-steps.ts";
import { NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE } from "../src/lib/outstation/non-travel-expense.ts";
import { stripComments } from "./support/comment-strip.ts";
import { cachedReadFile } from "./support/source-corpus.ts";

// Submit Expense is a step form like Report It and Log a visit, every step says what to do in it and
// what comes next, the screen after Submit lists what is still owed — and Submit Expense and Expense
// Submissions are ONE page (owner, 2026-10-22: "make it in a form exactly like the one in reported or
// in the weekly plan or in the log a visit in Phoenix CRM … and in every step, show him what should
// he do in this step and the next", then "I want the submit expense and the expense submissions to be
// in one page … in the same form").
//
// THE CASE BEHIND IT. Osama Mohamed El-said (District Sales Manager, Pedia line) took his arrival
// photo on a train trip to Assiut and submitted. The form reset in silence, the departure photo it
// now owed lived only on the Expense Dashboard and inside a collapsed row of Expense Submissions, and
// he did not know what to do when the trip ended. The claim had also arrived with no ticket, and
// nothing anywhere offered him a way to attach one.

const read = (file: string) => stripComments(cachedReadFile(join(process.cwd(), file)));

function facts(overrides: Partial<SubmitExpenseFacts> = {}): SubmitExpenseFacts {
  return {
    arrivalPhotoOwed: true,
    captured: true,
    hasArrivalPhoto: true,
    isNonTravel: false,
    isOffline: false,
    isTicketBased: true,
    isTicketRequired: true,
    meetingAmount: "",
    otherAmount: "",
    ticketCount: 1,
    transportationType: "train",
    tripEndDate: "2026-10-20",
    tripStartDate: "2026-10-20",
    ...overrides,
  };
}

export function runOutstationSubmitExpenseStepsTests() {
  // ── 1. The steps ─────────────────────────────────────────────────────────────
  assert.deepEqual(
    submitExpenseSteps(false).map((step) => step.key),
    ["trip", "destination", "evidence", "amounts", "review"],
    "a trip walks five steps, the destination before the evidence taken there",
  );
  assert.deepEqual(
    submitExpenseSteps(true).map((step) => step.key),
    ["trip", "evidence", "amounts", "review"],
    "a Meeting or Other expense is not a trip, so it has no destination step",
  );
  assert.equal(submitExpenseSteps(true).find((step) => step.key === "evidence")?.label, "Invoice");
  assert.equal(submitExpenseSteps(false).find((step) => step.key === "evidence")?.label, "Evidence");
  for (const isNonTravel of [false, true]) {
    for (const step of submitExpenseSteps(isNonTravel)) {
      assert.ok(
        submitExpenseStepInstruction(step.key, facts({ isNonTravel })).trim().length > 0,
        `every step opens with what to do in it (${step.key})`,
      );
    }
  }

  // ── 2. What each step still needs ────────────────────────────────────────────
  assert.equal(submitExpenseStepProblem("trip", facts({ tripStartDate: "" })), "Choose the From date.");
  assert.equal(submitExpenseStepProblem("trip", facts({ tripEndDate: "" })), "Choose the To date.");
  assert.equal(
    submitExpenseStepProblem("trip", facts({ tripEndDate: "2026-10-19", tripStartDate: "2026-10-20" })),
    "The To date must be on or after the From date.",
  );
  assert.equal(submitExpenseStepProblem("trip", facts()), null);
  assert.match(String(submitExpenseStepProblem("destination", facts({ captured: false }))), /Capture my location/);
  assert.equal(submitExpenseStepProblem("destination", facts({ captured: false, isNonTravel: true })), null);

  // The arrival photo is named for what it is: a live car photo, or a photo that may be uploaded.
  assert.equal(
    submitExpenseStepProblem("evidence", facts({ hasArrivalPhoto: false, transportationType: "car" })),
    "Take the live car photo.",
  );
  assert.match(
    String(submitExpenseStepProblem("evidence", facts({ hasArrivalPhoto: false }))),
    /arrival photo/,
  );
  assert.equal(
    submitExpenseStepProblem("evidence", facts({ arrivalPhotoOwed: false, hasArrivalPhoto: false, ticketCount: 1 })),
    null,
    "a role that owes no photo is never asked for one",
  );
  // The ticket never blocks Next, online or offline (owner, 2026-10-27, after a manager's train claim
  // could not leave the evidence step): the claim is submitted, held for review, and the ticket is
  // attached afterwards from My claims.
  assert.equal(submitExpenseStepProblem("evidence", facts({ ticketCount: 0 })), null, "online, a missing ticket never blocks Next");
  assert.equal(submitExpenseStepProblem("evidence", facts({ isOffline: true, ticketCount: 0 })), null);
  assert.equal(
    submitExpenseStepProblem("evidence", facts({ isTicketRequired: false, ticketCount: 0 })),
    null,
    "a waived role's ticket is optional",
  );
  assert.equal(
    submitExpenseStepProblem("amounts", facts({ isNonTravel: true })),
    NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE,
    "a Meeting or Other expense is refused with no amount — the same rule the server applies",
  );
  assert.equal(submitExpenseStepProblem("amounts", facts({ isNonTravel: true, meetingAmount: "250" })), null);
  assert.equal(submitExpenseStepProblem("review", facts()), null);

  const steps = submitExpenseSteps(false);
  assert.deepEqual(
    firstOpenSubmitExpenseStep(steps, facts({ captured: false, hasArrivalPhoto: false })),
    { index: 1, problem: submitExpenseStepProblem("destination", facts({ captured: false })) },
    "Submit sends the employee to the FIRST step still missing something, not the last one",
  );
  assert.equal(firstOpenSubmitExpenseStep(steps, facts()), null);

  // ── 3. What is still owed after Submit — Osama's train to Assiut ─────────────
  const osama = afterSubmitGuidance({
    arrivalPhotoOwed: true,
    destination: "Assiut",
    isCarTrip: false,
    isNonTravel: false,
    isTicketBased: true,
    ticketsAttached: 0,
  });
  assert.deepEqual(
    osama.map((item) => [item.key, item.state]),
    [
      ["submitted", "done"],
      ["departure", "now"],
      ["ticket", "next"],
      ["workload", "next"],
      ["validation", "next"],
      ["payroll", "next"],
    ],
    "the departure photo leads, then the missing ticket, the CRM visits, validation and payroll",
  );
  assert.match(osama[1].title, /departure photo before you leave Assiut/);
  assert.match(osama[1].detail, /top of this page/, "it says where the departure photo waits");
  assert.match(osama[3].detail, /next morning/, "visits saved later the same evening are picked up the next morning");
  assert.equal(osama.filter((item) => item.state === "now").length, 1, "exactly one thing is NOW");

  const meeting = afterSubmitGuidance({
    arrivalPhotoOwed: false,
    destination: null,
    isCarTrip: false,
    isNonTravel: true,
    isTicketBased: false,
    ticketsAttached: 0,
  });
  assert.deepEqual(
    meeting.map((item) => item.key),
    ["submitted", "validation", "payroll"],
    "a Meeting or Other expense owes no photo, ticket or CRM visits after Submit",
  );
  assert.equal(meeting[1].state, "now");

  // A car trip can drive on and add stops (owner, 2026-10-22: "what about the stops we added in
  // expenses"; the pricing rule is chained-journey.ts). The stop is taken on the way, BEFORE the
  // departure photo, and most trips have none — so it is listed as "if-needed" and never "now".
  const car = afterSubmitGuidance({
    arrivalPhotoOwed: true,
    destination: "Minya",
    isCarTrip: true,
    isNonTravel: false,
    isTicketBased: false,
    ticketsAttached: 0,
  });
  assert.deepEqual(
    car.map((item) => [item.key, item.state]),
    [
      ["submitted", "done"],
      ["stops", "if-needed"],
      ["departure", "now"],
      ["workload", "next"],
      ["validation", "next"],
      ["payroll", "next"],
    ],
    "a car trip is told it can add a stop on the way, and the departure photo is still what is owed now",
  );
  assert.match(car[1].detail, /My claims/, "it says where a stop is added");
  assert.match(car[1].detail, /before the trip's last day ends/, "and until when — the window the server enforces");
  assert.ok(
    !osama.some((item) => item.key === "stops") && !meeting.some((item) => item.key === "stops"),
    "a train, bus or non-travel claim is never offered a stop",
  );

  // ── 4. The wizard is driven by these rules and never resets in silence ───────
  const wizard = read("src/components/outstation/mobile-outstation-wizard.tsx");
  assert.ok(wizard.includes("submitExpenseSteps(isNonTravel)"), "the rail is the module's steps");
  assert.ok(wizard.includes("submitExpenseStepInstruction(currentStep.key, facts)"), "each step opens with its instruction");
  assert.ok(wizard.includes("firstOpenSubmitExpenseStep("), "Submit is judged by the module's own rule");
  assert.ok(wizard.includes("<FormWizard"), "the step form is the shared FormWizard, the one Log a visit renders");
  assert.ok(wizard.includes("<SubmittedClaimPanel"), "after Submit the employee sees what is still owed");
  assert.ok(wizard.includes("afterSubmitGuidance(claim)"));
  assert.ok(wizard.includes("router.refresh()"), "a submit re-reads the page, so what is now owed appears at the top");
  assert.ok(wizard.includes("href={`#${MY_CLAIMS_ANCHOR}`}"), "the after-submit screen links to My claims on the same page");
  assert.ok(!wizard.includes("/employee-portals/expense-submissions"), "nothing in the form sends the employee to another page");

  // ── 5. One page: what is owed, the form, then My claims ─────────────────────
  for (const page of [
    "app/employee-portals/submit-expense/page.tsx",
    "src/components/workspace/admin-shell-employee-pages.tsx",
  ]) {
    const source = read(page);
    assert.ok(source.includes("getOwnOutstationPendingActions(access)"), `${page} reads what is still owed`);
    assert.ok(source.includes("listOwnOutstationSubmissions(access)"), `${page} reads the employee's claims`);
    const owed = source.indexOf("<OutstationPendingActions");
    const form = source.indexOf("<MobileOutstationWizard");
    const claims = source.indexOf("<SubmitExpenseMyClaims");
    assert.ok(owed > -1 && form > owed && claims > form, `${page}: what is owed, then the form, then My claims`);
    assert.ok(!source.includes("showIntro"), `${page} passes no intro switch — the form has one shape`);
  }
  const myClaims = read("src/components/outstation/submit-expense-my-claims.tsx");
  assert.ok(myClaims.includes("id={MY_CLAIMS_ANCHOR}"));
  assert.ok(
    myClaims.includes("submissions === null"),
    "a failed read of the claims is said in words, never drawn as an empty list",
  );
  assert.equal(MY_CLAIMS_ANCHOR, "my-claims");

  const submissionsPage = read("app/employee-portals/expense-submissions/page.tsx");
  assert.ok(
    submissionsPage.includes('if (access.role !== "Medical Rep" && (await canAccess(access, "outstation", "create"))) {') &&
      submissionsPage.includes("redirect(`/employee-portals/submit-expense#${MY_CLAIMS_ANCHOR}`);"),
    "Expense Submissions forwards anyone who can submit a claim to the one page",
  );
  assert.ok(
    !read("app/employee-portals/submit-expense/page.tsx").includes("/employee-portals/expense-submissions"),
    "Submit Expense never sends anyone back to Expense Submissions, so the forward cannot loop",
  );

  // ── 6. The Expense Dashboard keeps its page open for a missing ticket too ───
  const dashboard = read("app/employee-portals/expense-dashboard/page.tsx");
  assert.ok(dashboard.includes("<OutstationPendingActions"));
  assert.ok(
    dashboard.includes("departurePhotoDue.length === 0 &&") && dashboard.includes("missingTicket.length === 0"),
    "an employee whose only activity is a claim owing a photo or a ticket is never sent to the empty state",
  );

  // ── 7. What is owed is offered exactly where the write is accepted ──────────
  const service = read("src/lib/outstation/service.ts");
  const start = service.indexOf("export async function getOwnOutstationRequestsMissingTicket(");
  const end = service.indexOf("export async function getOwnOutstationPendingActions(");
  assert.ok(start > -1 && end > start);
  const reader = service.slice(start, end);
  assert.ok(reader.includes("canAttachMissingOutstationTicket({"), "the card is offered by the attach route's own rule");
  assert.ok(reader.includes('.in("employee_hr_id", hrIdLookupKeys(access.hrId))'), "only the caller's own claims are read");
  assert.ok(reader.includes("normalizeHrIdForAccess(row.employeeHrId) === callerHrId"));

  const pending = read("src/components/outstation/outstation-pending-actions.tsx");
  assert.ok(pending.includes("<DeparturePhotoCard") && pending.includes("<MissingTicketCard"));
  assert.ok(pending.includes("onCaptured={() => router.refresh()}"), "a captured photo leaves the list without a reload");

  const ticketCard = read("src/components/outstation/missing-ticket-card.tsx");
  assert.ok(ticketCard.includes("fetch(`/api/outstation/${request.id}/ticket`"), "the card posts to the evidence-only route");
  assert.ok(!/amount/i.test(ticketCard.replace(/No amount\s+changes\./, "")), "the card carries no amount — evidence only");
  assert.ok(ticketCard.includes("router.refresh()"));

  const list = read("src/components/outstation/my-expense-submissions.tsx");
  assert.ok(list.includes("{departureDue || ticketDue ? ("), "a missing ticket is an Action needed too");
  assert.ok(list.includes("{ticketDue ? (") && list.includes("<MissingTicketCard"), "the ticket is attachable inside the claim");
  assert.ok(list.includes("rowNowAndNext(stages, { departureDue, ticketDue })"), "every row says what is now and what is next");
  assert.ok(
    list.includes("{submission.canAddJourneyStop ? (") && list.includes("add a stop in each new governorate"),
    "a car claim that can still take a stop says so on its row, not only inside the closed detail",
  );
  assert.ok(list.includes("<JourneyStopCard"), "and the stop is still captured inside the claim, on the same page");
  assert.ok(wizard.includes(`isCarTrip: !isNonTravel && transportationType === "car",`), "the screen after Submit knows a car trip");
}
