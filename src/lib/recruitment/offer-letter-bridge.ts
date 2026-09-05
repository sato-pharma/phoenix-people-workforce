import type { OfferFields } from "@/lib/offers/types";

import { offerSendBlockReason } from "./offer-rules";
import type { OfferApprovalTrail, OfferTerms } from "./offer-rules";

/**
 * Carries an APPROVED recruitment offer's agreed terms into the offer-letter composer.
 *
 * Today a recruiter reads the approved terms off one screen and retypes them into another. The
 * two modules sit next to each other and have never exchanged a single value — measured
 * 2026-09-05, zero cross-imports in either direction — so every offer that has ever been written
 * has been written twice, and the second copy is the one somebody signs.
 *
 * ── WHY THIS FILE LIVES IN recruitment/ AND NOT IN offers/ ──────────────────────────────────
 *
 * `src/lib/offers/types.ts` opens with an instruction from the owner: that module is deliberately
 * INDEPENDENT of recruitment, an offer there may be issued to somebody who never entered the ATS,
 * and "the two must not be merged". That instruction is about COUPLING, and coupling has a
 * direction. So the arrow points one way only:
 *
 *   recruitment  ──reads──>  offers        (this file, and only for a TYPE)
 *   offers       ──reads──>  recruitment   (never)
 *
 * Nothing under `src/lib/offers/` learns that a candidate exists. The import below is
 * `import type`, so it vanishes at compile time and cannot even create a runtime edge. An offer
 * can still be issued to a walk-in exactly as before; this only removes the retyping when the
 * person DID come through the ATS.
 *
 * ── WHAT IT REFUSES, AND WHY THAT IS THE POINT ──────────────────────────────────────────────
 *
 * The owner's rule is one approval before anything reaches a candidate. The registry once listed
 * a route from `offer_initiated` straight to `offer_sent`, skipping approval; it was retired in
 * `20260829234500_retire_offer_initiated_send_shortcut.sql`, and `offerSendBlockReason` is why it
 * was never exploitable in the first place — approval is read from `approvedAt`, not inferred
 * from the stage, because the registry is runtime-editable.
 *
 * A pre-filled letter is a way to reach a candidate. So this reuses that exact function rather
 * than writing a second gate beside it: a second gate is a second thing to keep in step, and the
 * one that drifts is always the copy. If `offerSendBlockReason` ever refuses, so does this.
 *
 * ── WHAT IT WILL NOT INVENT ─────────────────────────────────────────────────────────────────
 *
 * The same discipline as `hire-draft.ts`, which carries a hire's known facts into the HR form and
 * says of the money: the offer's agreed figure is carried exactly as it was recorded, and nothing
 * else. Here that means:
 *
 *   - `totalMonthly` is the recorded `monthlyGross`, to the pound. NOTHING is derived from it.
 *     `src/lib/offers/pay.ts` owns the split into basic, transport and cost of living, and it is
 *     explicit that it must not borrow payroll's rate even though the two numbers agree today.
 *     A bridge that pre-computed any of that would be a third opinion on a signed document.
 *   - `costOfLiving`, `contractTerm` and `reportsTo` are per JOB TITLE and live in the offers
 *     module's own title catalogue. The ATS does not know them and does not guess: the composer
 *     resolves them from the title, which is why carrying the title is worth more than carrying
 *     a number the ATS would have to invent.
 *   - `reference`, `dateOfIssue` and `validUntil` are minted by the offers module.
 *
 * Everything it declines to fill is returned in `leftForYou`, named in the words the recruiter
 * reads, so the screen can say what still needs a human instead of presenting a half-filled form
 * as a complete one.
 */

/** The subset of an offer letter the ATS genuinely knows. Every other field stays the composer's. */
export type OfferLetterDraft = Pick<
  OfferFields,
  "candidateEmail" | "candidateName" | "salutationName" | "startDate" | "territory" | "title" | "totalMonthly"
>;

export type OfferLetterBridgeResult =
  | {
      ok: true;
      draft: OfferLetterDraft;
      /** Fields carried across, in the recruiter's words. */
      carried: string[];
      /** Fields the composer must still collect, and why. */
      leftForYou: string[];
    }
  | { ok: false; reason: string };

export type OfferLetterBridgeInput = {
  offer: (OfferTerms & OfferApprovalTrail) | null;
  candidate: {
    fullName: string | null;
    email: string | null;
    preferredAreaName: string | null;
    preferredRegionName: string | null;
  } | null;
};

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * How the letter opens.
 *
 * The letter's own type says this is "how the letter addresses them, not necessarily the legal
 * name" and its example carries an honorific. This does NOT add one: guessing Dr, Mr or Ms from a
 * name means guessing a qualification and a gender, on a document the person keeps, and the three
 * signed letters show the honorific is a deliberate choice rather than a formatting rule. The
 * recruiter edits it in the composer where the whole letter is in front of them.
 */
function salutationFrom(fullName: string): string {
  return fullName;
}

/**
 * Where the letter says they will work.
 *
 * `preferredAreaName` is what the candidate ASKED for, not an assignment — nobody has been posted
 * anywhere at offer time. It is carried because it is right far more often than blank is, and it
 * is named in `leftForYou` as a preference so the recruiter reads it as one thing to confirm
 * rather than as a decision the system has taken.
 */
function territoryFrom(candidate: OfferLetterBridgeInput["candidate"]): string {
  return text(candidate?.preferredAreaName) || text(candidate?.preferredRegionName);
}

/**
 * The approved offer's terms, ready for the composer, or the reason it may not be composed yet.
 *
 * Pure: no database, no clock, no permission check. The route that calls it does the reading and
 * the `assertPermission`, exactly as `hire-draft.ts` is called.
 */
export function buildOfferLetterDraft(input: OfferLetterBridgeInput): OfferLetterBridgeResult {
  // ONE gate, shared with sending. Never a second copy of the approval rule.
  const blocked = offerSendBlockReason(input.offer);
  if (blocked) return { ok: false, reason: blocked };

  // offerSendBlockReason has already established these are present and valid; the guards below
  // are for the type system, not for the logic.
  const offer = input.offer;
  if (!offer) return { ok: false, reason: "There is no offer on this application yet — prepare one first." };

  const fullName = text(input.candidate?.fullName);
  if (!fullName) {
    return {
      ok: false,
      reason: "This candidate has no name on file, so the letter would be addressed to nobody.",
    };
  }

  const title = text(offer.jobTitle);
  const startDate = text(offer.startDate);
  const email = text(input.candidate?.email);
  const territory = territoryFrom(input.candidate);
  const totalMonthly = typeof offer.monthlyGross === "number" ? offer.monthlyGross : 0;

  const carried = [
    "candidate name",
    `job title (${title})`,
    `monthly package (${totalMonthly.toLocaleString("en-GB")} EGP, exactly as approved)`,
    "start date",
  ];
  if (email) carried.push("email address");
  if (territory) carried.push(`territory (${territory})`);

  const leftForYou = [
    "cost of living, contract term and who they report to — these come from the job title's own entry, not from the offer",
    "reference number, date of issue and valid-until — the letter mints these itself",
  ];
  if (!email) {
    leftForYou.unshift("an email address — this candidate has none on file, and the letter cannot be sent without one");
  }
  if (territory) {
    leftForYou.push(`confirm the territory — ${territory} is what the candidate asked for, not a posting anyone has made`);
  } else {
    leftForYou.push("the territory — the candidate stated no preference");
  }

  return {
    ok: true,
    carried,
    leftForYou,
    draft: {
      candidateEmail: email,
      candidateName: fullName,
      salutationName: salutationFrom(fullName),
      startDate,
      territory,
      title,
      totalMonthly,
    },
  };
}
