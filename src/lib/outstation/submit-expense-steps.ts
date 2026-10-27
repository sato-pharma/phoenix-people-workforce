import { NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE, nonTravelAmountRefusal } from "@/lib/outstation/non-travel-expense";

/**
 * Submit Expense as a step form (owner, 2026-10-22: "make it in a form exactly like the one in
 * reported or in the weekly plan or in the log a visit in Phoenix CRM … and in every step, show him
 * what should he do in this step and the next").
 *
 * THE HOLE IT CLOSES. The old screen was one long page with a decorative three-pill stepper, and it
 * never said what came after the press. Osama Mohamed El-said took his arrival photo on a train trip
 * to Assiut, submitted, and the form reset in silence: nothing told him a departure photo was owed
 * before he left, so the claim sat held. Every step now names what to do in it and what comes next,
 * and the screen after Submit lists what is still owed, in order.
 *
 * Pure, so the rules are tested as behaviour (tests/outstation-submit-expense-steps.test.ts). The
 * server still enforces every one of them; this only decides what the form asks for and when.
 */

/**
 * My claims sits under the form on the same page (owner, 2026-10-22: "I want the submit expense and
 * the expense submissions to be in one page … in the same form"). The after-submit screen links to
 * it, and Expense Submissions forwards a submitter straight to it.
 */
export const MY_CLAIMS_ANCHOR = "my-claims";

export type SubmitExpenseStepKey = "trip" | "destination" | "evidence" | "amounts" | "review";

export type SubmitExpenseStep = {
  key: SubmitExpenseStepKey;
  /** The rail's short name. */
  label: string;
  /** The rail's line under it. */
  description: string;
  /** The heading over the step. */
  title: string;
};

/** The steps a claim walks through. A Meeting or Other expense is not a trip, so it has no destination. */
export function submitExpenseSteps(isNonTravel: boolean): SubmitExpenseStep[] {
  return [
    { key: "trip", label: "Trip", description: isNonTravel ? "Type and dates" : "Type, dates and transport", title: isNonTravel ? "The expense" : "Your trip" },
    ...(isNonTravel
      ? []
      : [{ key: "destination" as const, label: "Destination", description: "Where you are now", title: "Capture where you are" }]),
    isNonTravel
      ? { key: "evidence", label: "Invoice", description: "Invoice or picture", title: "Invoice or picture" }
      : { key: "evidence", label: "Evidence", description: "Arrival photo and ticket", title: "Arrival photo and ticket" },
    { key: "amounts", label: "Amounts", description: "What you paid", title: "Amounts and notes" },
    { key: "review", label: "Review & submit", description: "Check, then submit", title: "Check and submit" },
  ];
}

/** What the form knows when it judges a step. */
export type SubmitExpenseFacts = {
  arrivalPhotoOwed: boolean;
  captured: boolean;
  hasArrivalPhoto: boolean;
  isNonTravel: boolean;
  isOffline: boolean;
  isTicketBased: boolean;
  isTicketRequired: boolean;
  meetingAmount: string;
  otherAmount: string;
  ticketCount: number;
  transportationType: string;
  tripEndDate: string;
  tripStartDate: string;
};

/** The one sentence at the top of a step: what to do in it. */
export function submitExpenseStepInstruction(key: SubmitExpenseStepKey, facts: SubmitExpenseFacts): string {
  switch (key) {
    case "trip":
      return facts.isNonTravel
        ? "Choose the expense type and the date of the expense."
        : "Choose the expense type, the dates you were away and how you travelled.";
    case "destination":
      return "Stand at the destination and tap Capture my location. From is your registered home.";
    case "evidence":
      if (facts.isNonTravel) {
        return "Attach the invoice or a picture of the expense. Without one, the claim is held for review.";
      }
      if (facts.arrivalPhotoOwed && facts.isTicketBased) {
        return facts.transportationType === "train"
          ? "Take the arrival photo here at the destination, then attach your train ticket."
          : "Take the arrival photo here at the destination, then attach your bus ticket.";
      }
      if (facts.arrivalPhotoOwed) {
        return facts.transportationType === "car"
          ? "Take one live photo of the car here at the destination."
          : "Take the arrival photo here at the destination, or upload one.";
      }
      return facts.isTicketBased
        ? "Attach your ticket if you have it. No photo is needed for your role."
        : "No photo or ticket is needed for your role on this trip.";
    case "amounts":
      return facts.isNonTravel
        ? "Enter what you paid. The claim is paid on these amounts alone."
        : "Enter what you paid. The allowance and the travel cost are calculated for you.";
    case "review":
      return "Check the total Phoenix calculated, then press Submit.";
  }
}

/**
 * The one thing still missing in a step, in the words the bar under his thumb shows, or null when
 * the step is complete. Review is judged by the form itself (it depends on the server's price).
 */
export function submitExpenseStepProblem(key: SubmitExpenseStepKey, facts: SubmitExpenseFacts): string | null {
  switch (key) {
    case "trip":
      if (!facts.tripStartDate) return "Choose the From date.";
      if (!facts.tripEndDate) return "Choose the To date.";
      if (facts.tripEndDate < facts.tripStartDate) return "The To date must be on or after the From date.";
      return null;
    case "destination":
      return facts.isNonTravel || facts.captured
        ? null
        : "Tap Capture my location while you are at the destination.";
    case "evidence":
      if (facts.arrivalPhotoOwed && !facts.hasArrivalPhoto) {
        return facts.transportationType === "car"
          ? "Take the live car photo."
          : "Add the arrival photo — take it live or upload it.";
      }
      // The ticket never blocks Next (owner, 2026-10-27): online or offline, a claim without it is
      // submitted, held for review, and the ticket is attached afterwards from My claims, under the form.
      return null;
    case "amounts":
      return facts.isNonTravel && nonTravelAmountRefusal({ meetingAmount: facts.meetingAmount, otherAmount: facts.otherAmount })
        ? NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE
        : null;
    case "review":
      return null;
  }
}

/** The first step, from the start, that still needs something — and what. Null when all are done. */
export function firstOpenSubmitExpenseStep(
  steps: ReadonlyArray<SubmitExpenseStep>,
  facts: SubmitExpenseFacts,
): { index: number; problem: string } | null {
  for (let index = 0; index < steps.length; index += 1) {
    const problem = submitExpenseStepProblem(steps[index].key, facts);
    if (problem) return { index, problem };
  }
  return null;
}

export type AfterSubmitItem = {
  detail: string;
  key: "submitted" | "stops" | "departure" | "ticket" | "workload" | "validation" | "payroll";
  /** "if-needed" is a step only some trips take (a stop on the way); it never becomes "now". */
  state: "done" | "now" | "next" | "if-needed";
  title: string;
};

/**
 * What is still owed once the claim is in, in order — the screen after Submit. The first item not
 * done is "now"; everything after it is "next".
 *
 * The departure photo leads whenever the trip owes one: that is the step Osama did not know about.
 * A car trip that drives on to another governorate adds its stops BEFORE that last photo, so the
 * stop line sits above it, marked "if needed" — most trips have none, and it never takes "now"
 * (owner, 2026-10-22: "what about the stops we added in expenses"; the rule is chained-journey.ts).
 * The CRM line says visits saved later the same evening are picked up the next morning, because they
 * are (runOutstationWorkloadRestamp, owner 2026-10-22: "fix the stale no-activity stamp").
 */
export function afterSubmitGuidance(input: {
  arrivalPhotoOwed: boolean;
  destination: string | null;
  isCarTrip: boolean;
  isNonTravel: boolean;
  isTicketBased: boolean;
  ticketsAttached: number;
}): AfterSubmitItem[] {
  const place = input.destination?.trim() ? input.destination.trim() : "the destination";
  const items: Array<Omit<AfterSubmitItem, "state"> & { done: boolean; ifNeeded?: boolean }> = [
    {
      detail: input.isNonTravel
        ? "Your claim and its amounts are recorded."
        : input.arrivalPhotoOwed
          ? "Your arrival photo went with it."
          : "Your trip is recorded.",
      done: true,
      key: "submitted",
      title: "Claim submitted",
    },
  ];
  if (input.isCarTrip && !input.isNonTravel) {
    items.push({
      detail:
        "Open this claim under My claims and take the stop photo where you arrive, before the trip's last day ends — up to 6 stops. A drive from one governorate to another over 40 km is paid one way; a stop in the same governorate changes nothing.",
      done: false,
      ifNeeded: true,
      key: "stops",
      title: "Driving on to another governorate? Add a stop there",
    });
  }
  if (input.arrivalPhotoOwed) {
    items.push({
      detail:
        "It waits at the top of this page and on the claim under My claims. Take it on the day the trip ends, before you leave. The claim does not reach payroll without it.",
      done: false,
      key: "departure",
      title: `Take the departure photo before you leave ${place}`,
    });
  }
  if (input.isTicketBased && input.ticketsAttached === 0) {
    items.push({
      detail: "Attach it at the top of this page or on the claim under My claims. Until then the claim is held for review.",
      done: false,
      key: "ticket",
      title: "Attach the ticket",
    });
  }
  if (!input.isNonTravel) {
    items.push({
      detail:
        "Phoenix reads your AM, PM and pharmacy visits for the trip days from Phoenix CRM. Visits you save later the same evening are picked up the next morning.",
      done: false,
      key: "workload",
      title: "Log your visits in Phoenix CRM",
    });
  }
  items.push(
    { detail: "Your approver checks the claim. Nothing for you to do.", done: false, key: "validation", title: "Validation" },
    { detail: "Once validated, the claim is paid with the next payroll.", done: false, key: "payroll", title: "Payroll" },
  );

  let nowGiven = false;
  return items.map(({ done, ifNeeded, ...item }) => {
    if (done) return { ...item, state: "done" as const };
    if (ifNeeded) return { ...item, state: "if-needed" as const };
    if (nowGiven) return { ...item, state: "next" as const };
    nowGiven = true;
    return { ...item, state: "now" as const };
  });
}
