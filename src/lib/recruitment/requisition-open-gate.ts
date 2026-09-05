// What a requisition must be able to say before it opens a hire.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────────
//
// It is not a budget approval. `salary_band_min` and `salary_band_max` are NULL on every one of the
// six requisitions in production — nobody uses them — so a gate built on them would refuse
// everything on day one and be switched off by the afternoon.
//
// It is not an org-structure change either. The Organogram / AU seat model is the owner's stated
// source of truth for vacancies, and the skeleton is changed only by his own intent. This reads
// that model; it never writes to it.
//
// ── WHAT IT IS ──────────────────────────────────────────────────────────────────────────────────
//
// A requisition opens a real hire against real money. Two things must therefore be true, and both
// are answerable from data the requisition already carries:
//
//   1. It asks for at least one person. A headcount of 0 opens a hire for nobody.
//   2. A REPLACEMENT names the person it replaces, and that person has actually left. Opening a
//      replacement for somebody still employed is either a seat counted twice or a resignation
//      nobody recorded — and both look identical to a healthy requisition on screen.
//
// Measured on production 2026-09-05: all four replacement requisitions name a real person and every
// one of them is `resigned`. So this refuses nothing that exists today; it is a floor, not a sweep.
//
// ── THE THIRD CHECK IS DELIBERATELY ABSENT ──────────────────────────────────────────────────────
//
// One open requisition — Office Coordinator, REQ-2026-61D5A3 — is an EXPANSION with no vacancy_id:
// a hire against no seat in the organogram. That may be exactly right (a genuinely new role), or it
// may be a seat somebody forgot to create. Which of those it is, and who is allowed to add headcount
// that way, is the owner's decision and not a rule to infer from one row. It is left unguarded and
// unblocked rather than guessed at.

import type { Requisition } from "@/lib/recruitment/types";

export type RequisitionOpenBlock = {
  code: "no_headcount" | "replacement_unnamed" | "replacement_still_employed";
  message: string;
};

/** An employment status that means the person has gone. */
function hasLeft(employmentStatus: string | null | undefined): boolean {
  const value = String(employmentStatus ?? "").trim().toLowerCase();
  if (!value) return false;
  // Named rather than inverted from "active": a status this code has never seen must NOT quietly
  // read as "has left", because that is the direction that lets a duplicate seat through.
  return ["resigned", "terminated", "inactive", "left", "exited", "retired"].includes(value);
}

export function isReplacementRequisition(headcountType: string | null | undefined): boolean {
  return String(headcountType ?? "").trim().toLowerCase() === "replacement";
}

/**
 * Why this requisition may not open yet, or null if it may.
 *
 * Takes the replacement's employment status as an argument rather than reading it, so the rule can
 * be tested without a database and so the caller decides how the person is looked up — HR ids are
 * mixed case and the lookup must be casing-blind, which is the caller's existing concern.
 */
export function requisitionOpenBlock(
  requisition: Pick<Requisition, "headcount" | "headcountType" | "replacementForHrId">,
  replacementEmploymentStatus: string | null | undefined,
): RequisitionOpenBlock | null {
  const headcount = Number(requisition.headcount ?? 0);
  if (!Number.isFinite(headcount) || headcount < 1) {
    return {
      code: "no_headcount",
      message: "This requisition asks for no one — set a headcount of at least 1 before opening it.",
    };
  }

  if (!isReplacementRequisition(requisition.headcountType)) return null;

  const replacing = String(requisition.replacementForHrId ?? "").trim();
  if (!replacing) {
    return {
      code: "replacement_unnamed",
      message:
        "This is a replacement requisition but it does not say who it replaces. Name the person, or "
        + "change it to an expansion if it is a new seat.",
    };
  }

  if (!hasLeft(replacementEmploymentStatus)) {
    return {
      code: "replacement_still_employed",
      message:
        `This replaces ${replacing}, who is still employed. Opening it now either counts their seat `
        + "twice or means their exit was never recorded — settle which before hiring against it.",
    };
  }

  return null;
}
