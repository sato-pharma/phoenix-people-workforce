/**
 * Things worth saying about an offer before it is sent.
 *
 * ── Warnings, not errors, and the difference is the point ──
 * Nothing here blocks anything. The route already refuses the handful of things that are genuinely
 * impossible — no name, no title, a package of zero, a cost of living larger than the package it
 * sits inside. What this module catches is the other kind: a letter that will send perfectly and
 * be wrong when it arrives.
 *
 * A start date before the letter's own date is not invalid, it is embarrassing. An offer that
 * expires before it starts is not invalid, it is confusing to the person reading it. A second
 * offer to an address that already has one is sometimes exactly right — a revised package — and
 * sometimes somebody forgetting they already sent it. None of these can be decided by a machine,
 * so all of them are said out loud and left to the person.
 *
 * Pure, so the composer can show them live as the form is filled and a test can pin every one.
 */

import { daysBetween, isIsoDate } from "@/lib/offers/dates";

export type OfferDraftWarning = {
  /** Which input the note belongs beside. Matches the composer's field keys. */
  field: "candidateEmail" | "startDate" | "validUntil";
  message: string;
};

/**
 * Deliberately permissive: one @, something before it, a dot after it.
 *
 * This is a typo check, not an address validator. A stricter pattern rejects real addresses, and
 * an address rejected here is one a candidate never receives their offer at — the expensive
 * direction to be wrong in. The send itself is the real test.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function offerDraftWarnings(input: {
  candidateEmail: string;
  /** Every offer already on file, so a repeat to one address can be spotted. */
  existingEmails: readonly string[];
  /** ISO `yyyy-mm-dd`. Empty or unparseable values are simply not checked. */
  dateOfIssue: string;
  startDate: string;
  validUntil: string;
}): OfferDraftWarning[] {
  const warnings: OfferDraftWarning[] = [];
  const { candidateEmail, dateOfIssue, existingEmails, startDate, validUntil } = input;

  const issueToExpiry = daysBetween(dateOfIssue, validUntil);
  if (issueToExpiry !== null && issueToExpiry <= 0) {
    warnings.push({
      field: "validUntil",
      message:
        issueToExpiry === 0
          ? "This offer expires the same day it is issued, so the candidate has no time to reply."
          : "This offer expires before the date it is issued, so it arrives already expired.",
    });
  }

  const issueToStart = daysBetween(dateOfIssue, startDate);
  if (issueToStart !== null && issueToStart < 0) {
    warnings.push({
      field: "startDate",
      message: "The start date is before the date on the letter, so it asks them to have started already.",
    });
  }

  // NOT CHECKED, deliberately: an acceptance window that runs past the start date.
  //
  // It looks wrong and it is not. Giving somebody a week to decide about a job starting in four
  // days is ordinary, and the composer's own defaults produce exactly that shape — issue today,
  // valid a week, start on the first of next month. A note that fires on the default settings is
  // the note that teaches people to ignore the amber triangle, and the two real problems above are
  // then ignored with it. Caught by this module's own test on the first run.

  const email = candidateEmail.trim();
  if (email && !EMAIL_SHAPE.test(email)) {
    warnings.push({
      field: "candidateEmail",
      message: "That does not look like an email address, and the offer cannot be delivered without one.",
    });
  }

  if (email && EMAIL_SHAPE.test(email)) {
    const seen = existingEmails.some((existing) => existing.trim().toLowerCase() === email.toLowerCase());
    if (seen) {
      warnings.push({
        field: "candidateEmail",
        message: "This address already has an offer on file. Check the Offers list below before sending another.",
      });
    }
  }

  return warnings;
}

/** The warnings for one field, in the order they were raised. */
export function offerWarningsFor(
  warnings: readonly OfferDraftWarning[],
  field: OfferDraftWarning["field"],
): string[] {
  return warnings.filter((warning) => warning.field === field).map((warning) => warning.message);
}

/** True when a value is a date the checks above can actually reason about. */
export function isCheckableDate(value: string): boolean {
  return isIsoDate(value);
}
