import type {
  DirectOrderPharmacyDistributorCode,
  DirectOrderPharmacyVerificationStatus,
} from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// Should this direct order park in the HELD lane? (owner rule, 2026-08-08)
//
// THE INSIGHT THIS ENCODES: the Sato pharmacy code (DOP-000123) is only Phoenix's own internal
// reference — it proves nothing. The DISTRIBUTOR customer code is the real evidence, because a code
// the distributor's own master database recognises is proof the pharmacy exists.
//
// Before this module the fork was one line:
//
//     const submitAsHeld = pharmacy.verificationStatus === "pending_review";
//
// `verification_status` was the SOLE input. A hand-typed pharmacy whose code resolved perfectly and
// one with no code at all routed IDENTICALLY — both frozen outside the approval chain, both waiting
// on a photo and an admin, both dying on the 14-day clock. Eight live orders worth 243,871.75 EGP
// sat in that lane on the day this was written.
//
// RELEASING IS NOT SKIPPING REVIEW. buildApprovalChain always puts the SFE Manager rung FIRST, so a
// released order still reaches SFE — it simply enters the chain as work somebody owns, instead of a
// side-lane nobody is assigned. The final-approval backstop still refuses to finalize while the
// pharmacy is `pending_review`, and `verification_status` is never written by any release path.
//
// WHY BRICK AND NOT AREA (owner decision, 2026-08-08): the owner chose the strictest of three
// options. A code that resolves to a DIFFERENT brick than the request declares stays held, even
// though its area may agree. This is the property the old code's comment defended — "deriving from
// the codes would have let a hand-typed pharmacy whose code happened to collide with a real one
// skip review entirely" — and brick equality is a strictly tighter guard than area equality.
//
// Pure and dependency-free ON PURPOSE: the test runner executes this rule directly rather than
// reading the source and hoping. Same trade-off cancel-visibility.ts makes.
// ─────────────────────────────────────────────────────────────────────────────

/** Why an order is (or is not) held. Every value is a distinct, testable branch. */
export type DirectOrderHoldGround =
  | "verified"
  | "code_proven"
  | "admin_released"
  | "unproven"
  | "code_conflict"
  | "pharmacy_rejected";

/** A resolving code that nonetheless failed the release test, and the reason. */
export type DirectOrderHoldConflict = {
  distributorCode: string;
  customerCode: string;
  kind: "brick_mismatch" | "owned_by_another_pharmacy";
  mappedBrickId: string | null;
  declaredBrickId: string | null;
};

export type DirectOrderHoldDecision = {
  hold: boolean;
  ground: DirectOrderHoldGround;
  /** The pair that proved the pharmacy, when `ground === "code_proven"`. */
  provenBy: { distributorCode: string; customerCode: string } | null;
  conflicts: DirectOrderHoldConflict[];
};

/** A code row plus the one fact the pharmacy row cannot supply: who else already owns it. */
export type DirectOrderHoldCandidateCode = DirectOrderPharmacyDistributorCode & {
  /** Another Phoenix pharmacy already holding this exact (distributor, customer code) pair. */
  ownedByOtherPharmacyId?: string | null;
};

export type DirectOrderHoldInput = {
  verificationStatus: DirectOrderPharmacyVerificationStatus;
  /** Brick declared on the request/pharmacy — the claim being tested. */
  declaredBrickId: string | null;
  distributorCodes: ReadonlyArray<DirectOrderHoldCandidateCode>;
  /** Persisted System Admin decision, when one was recorded. */
  holdReleaseGround: string | null;
};

/**
 * Customer codes, compared the way the master database actually stores them.
 *
 * The distributor directory pads ("0001573270") while a human types bare ("1573270"). Verified
 * across 52,510 active customer-map rows / 16 distributors: stripping leading zeros produces ZERO
 * collisions within a distributor, so this is an identity, not a guess.
 *
 * Returns null for anything non-numeric, which keeps junk like "brgthyrhyuj" out of every matching
 * path. All-zero input collapses to "0" — that is what stops the live placeholder codes "000000"
 * and "00000" from ever being treated as proof of anything.
 */
export function normalizeCustomerCode(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return raw.replace(/^0+/, "") || "0";
}

/**
 * Do two customer codes denote the same customer?
 *
 * FULL-STRING equality after zero-stripping, never a suffix match: "31573270" must NOT match
 * "1573270". A suffix comparison is the specific trap that makes a longer code look like a shorter
 * one, and it is cheap to get wrong with `.ilike('%code')`.
 */
export function customerCodesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeCustomerCode(a);
  const right = normalizeCustomerCode(b);
  // "0" is the collapsed placeholder — it denotes no customer, so it matches nothing, not even itself.
  if (left === null || right === null || left === "0" || right === "0") return false;
  return left === right;
}

/** Brick codes agree, compared case- and whitespace-insensitively. */
function bricksAgree(declared: string | null, mapped: string | null): boolean {
  const left = String(declared ?? "").trim().toUpperCase();
  const right = String(mapped ?? "").trim().toUpperCase();
  if (!left || !right) return false;
  return left === right;
}

/**
 * The single rule deciding whether a submitted direct order freezes in the held lane.
 *
 * Evaluation order matters and each branch is a test case — see tests/direct-orders-hold-release.
 */
export function decideDirectOrderHold(input: DirectOrderHoldInput): DirectOrderHoldDecision {
  const none: Pick<DirectOrderHoldDecision, "provenBy" | "conflicts"> = { provenBy: null, conflicts: [] };

  // 1. A pharmacy examined and found NOT to be real can never be released by any later rule.
  //    Defensive — rejected pharmacies are deactivated — but a release path must never resurrect
  //    one, the same way markDirectOrderPharmacyVerified already refuses.
  if (input.verificationStatus === "rejected") {
    return { hold: true, ground: "pharmacy_rejected", ...none };
  }

  // 2. Already confirmed by a human. This is today's behaviour, byte-identical.
  if (input.verificationStatus === "verified") {
    return { hold: false, ground: "verified", ...none };
  }

  // 3. A System Admin looked at an unprovable code and decided to let it through anyway (spec:
  //    Nermeen's placeholder-code case). Recorded on the pharmacy, so it covers sibling orders.
  if (input.holdReleaseGround === "admin_released") {
    return { hold: false, ground: "admin_released", ...none };
  }

  // 4. THE RELEASE TEST. A code that resolves in the master database, whose brick agrees with the
  //    brick declared here, and which no other Phoenix pharmacy already owns, is proof enough.
  const conflicts: DirectOrderHoldConflict[] = [];
  for (const pair of input.distributorCodes) {
    // An unresolved code is not evidence either way — it contributes no proof and no conflict.
    if (!pair.mappedBrickId) continue;
    // A placeholder ("000000") never resolves, but guard the code shape too so a mapped row with a
    // junk code can never be read as proof.
    if (normalizeCustomerCode(pair.customerCode) === null) continue;

    if (pair.ownedByOtherPharmacyId) {
      conflicts.push({
        distributorCode: pair.distributorCode,
        customerCode: pair.customerCode,
        kind: "owned_by_another_pharmacy",
        mappedBrickId: pair.mappedBrickId,
        declaredBrickId: input.declaredBrickId,
      });
      continue;
    }
    if (!bricksAgree(input.declaredBrickId, pair.mappedBrickId)) {
      conflicts.push({
        distributorCode: pair.distributorCode,
        customerCode: pair.customerCode,
        kind: "brick_mismatch",
        mappedBrickId: pair.mappedBrickId,
        declaredBrickId: input.declaredBrickId,
      });
      continue;
    }
    return {
      hold: false,
      ground: "code_proven",
      provenBy: { distributorCode: pair.distributorCode, customerCode: pair.customerCode },
      conflicts: [],
    };
  }

  // 5. A code resolved but failed the test — the interesting failure, worth naming separately from
  //    "no code at all" because it means somebody typed something real that does not fit.
  if (conflicts.length > 0) {
    return { hold: true, ground: "code_conflict", provenBy: null, conflicts };
  }

  // 6. Nothing to go on.
  return { hold: true, ground: "unproven", ...none };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-LINK: when the match is unambiguous, write it — do not wait for a click (owner, 2026-08-08)
//
// The original design surfaced a found-but-unlinked code and required a System Admin to click Link.
// The owner overruled that: "if the pharmacy matches automatic link". He is right that a click is
// not a safety mechanism — nobody re-derives the match by hand before clicking, so the click adds
// latency and nothing else. The real safety belongs in the MATCH CONDITION, which is where it now
// lives: this refuses on every shape of doubt and links only when there is exactly one answer.
//
// Five refusals, each a live failure mode rather than a hypothetical:
//   - name_is_not_a_code        the name is a name; there is nothing to move out of the wrong box
//   - already_linked            never overwrite a link a human made — repair is not replacement
//   - no_candidate              the digits match nothing in the master (Nermeen's "000000" lands here)
//   - ambiguous_candidates      the same digits are a customer at two distributors: different code
//                               spaces, so this is a coincidence, not one pharmacy. A human picks.
//   - owned_by_another_pharmacy another Phoenix pharmacy already holds this exact pair. Linking would
//                               point two pharmacies at one customer and split its sales in two.
//
// The rename rides along deliberately. The trigger for the whole rule is that the NAME is a code, so
// leaving it would half-fix the record: the code reaches its proper column while every list, report
// and email still reads "1573270". The original name is preserved in the audit event, so it is
// reversible — but it was never a name to begin with.
// ─────────────────────────────────────────────────────────────────────────────

/** A distributor customer the pharmacy's digit-shaped name resolved to. */
export type DirectOrderAutoLinkCandidate = {
  distributorCode: string;
  distributorName: string;
  customerCode: string;
  customerName: string | null;
  areaCode: string | null;
  brickId: string | null;
  /** Another Phoenix pharmacy already holding this exact (distributor, customer code) pair. */
  ownedByOtherPharmacyId?: string | null;
};

export type DirectOrderAutoLinkRefusal =
  | "name_is_not_a_code"
  | "already_linked"
  | "no_candidate"
  | "ambiguous_candidates"
  | "owned_by_another_pharmacy";

export type DirectOrderAutoLinkDecision =
  | {
      link: true;
      candidate: DirectOrderAutoLinkCandidate;
      /** The master's own name for this customer, when it is a real name. Null leaves the name alone. */
      renameTo: string | null;
    }
  | { link: false; refusal: DirectOrderAutoLinkRefusal; candidates: ReadonlyArray<DirectOrderAutoLinkCandidate> };

export type DirectOrderAutoLinkInput = {
  pharmacyName: string | null;
  /** Codes already on the pharmacy. ANY existing link means hands off. */
  existingCodes: ReadonlyArray<{ distributorCode: string; customerCode: string }>;
  candidates: ReadonlyArray<DirectOrderAutoLinkCandidate>;
};

/** A name that is really a code: four or more digits and nothing else. Mirrors the matcher's own gate. */
function nameIsMisplacedCode(pharmacyName: string | null | undefined): boolean {
  const typed = String(pharmacyName ?? "").trim();
  if (!/^\d{4,}$/.test(typed)) return false;
  // "000000" is a placeholder, not a code — it must never trigger a link. Same guard as the hold rule.
  return normalizeCustomerCode(typed) !== "0";
}

/** A master client name worth adopting: present, and not itself just a code. */
function usableCustomerName(customerName: string | null | undefined): string | null {
  const name = String(customerName ?? "").trim();
  if (!name || /^\d+$/.test(name)) return null;
  return name;
}

/**
 * Should this pharmacy's distributor code be linked automatically?
 *
 * Pure and total: every path returns a decision, and every refusal names itself so the screen can
 * say WHY it declined rather than falling silent — the same reason "Not flagged" had to die.
 */
export function decideDirectOrderAutoLink(input: DirectOrderAutoLinkInput): DirectOrderAutoLinkDecision {
  const none: ReadonlyArray<DirectOrderAutoLinkCandidate> = [];

  if (!nameIsMisplacedCode(input.pharmacyName)) {
    return { link: false, refusal: "name_is_not_a_code", candidates: none };
  }

  // A pair a human already put there outranks anything derived. Repair the empty case only.
  const alreadyLinked = input.existingCodes.some(
    (pair) => String(pair.distributorCode ?? "").trim() !== "" && normalizeCustomerCode(pair.customerCode) !== null,
  );
  if (alreadyLinked) {
    return { link: false, refusal: "already_linked", candidates: none };
  }

  // FULL-STRING match after zero-stripping — customerCodesMatch, never a suffix compare, or
  // "31573270" would auto-link itself to customer "1573270" and silently steal its sales.
  const matches = input.candidates.filter(
    (candidate) =>
      customerCodesMatch(candidate.customerCode, input.pharmacyName) &&
      String(candidate.distributorCode ?? "").trim() !== "",
  );
  if (matches.length === 0) {
    return { link: false, refusal: "no_candidate", candidates: none };
  }

  const distributors = new Set(matches.map((candidate) => candidate.distributorCode.trim().toUpperCase()));
  if (distributors.size > 1) {
    return { link: false, refusal: "ambiguous_candidates", candidates: matches };
  }

  const candidate = matches[0];
  if (candidate.ownedByOtherPharmacyId) {
    return { link: false, refusal: "owned_by_another_pharmacy", candidates: matches };
  }

  return { link: true, candidate, renameTo: usableCustomerName(candidate.customerName) };
}

/** One sentence for the screen — never a bare refusal code. */
export function describeDirectOrderAutoLinkRefusal(refusal: DirectOrderAutoLinkRefusal): string {
  switch (refusal) {
    case "name_is_not_a_code":
      return "The pharmacy name is a name, so there is no misplaced code to move.";
    case "already_linked":
      return "This pharmacy already has a distributor code on file — an automatic link never overwrites one.";
    case "no_candidate":
      return "These digits match no customer in any distributor's master database, so there is nothing to link.";
    case "ambiguous_candidates":
      return "These digits are a customer at more than one distributor. Distributors use separate code spaces, so this is a coincidence rather than one pharmacy — pick the right one below.";
    case "owned_by_another_pharmacy":
      return "Another Phoenix pharmacy already holds this exact distributor customer. Linking it here would point two pharmacies at one customer and split its sales between them.";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Which products may a viewer see in a pharmacy's sales history? (owner rule, 2026-08-08)
//
// Lives here, pure and executable, rather than inline in service.ts — because a source-text test
// cannot tell `if (isHeadOfficeLine(line))` from `if (false && isHeadOfficeLine(line))`. That was
// found by running the prove-it-fails check on the inline version: the guard was disabled and every
// assertion still passed. A confidentiality rule that cannot be executed in a test is not guarded.
//
// TWO exclusions, and NEITHER subsumes the other:
//   - the restricted product CODES (LA003 / LA004 / SS001), by code, and
//   - the Head Office LINE, which carries RY001 — a product that is NOT in that code list, and
//     which reached an SFE Manager's screen once through exactly this gap.
// A restricted code can also sit on a non-Head-Office line, so both run, always.
//
// Applied to EVERY role including CEO and Super Admin — deliberately stricter than the app's own
// `canViewRestrictedProducts`, which would re-admit those two.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectOrderProductVisibilityInput = {
  productCode: string;
  /** The product's line, for the Head Office lock. "" when unknown. */
  line: string;
  /** Upper-cased restricted codes. */
  restrictedCodes: ReadonlySet<string>;
  isHeadOfficeLine: (line: string) => boolean;
  /**
   * The viewer's own line, lower-cased. `null` = sees every line (Super Admin / SFE Manager / CEO).
   * `""` = a restricted role whose line could not be resolved — must see NOTHING, never everything.
   */
  viewerLine: string | null;
};

export function isDirectOrderHistoryProductVisible(input: DirectOrderProductVisibilityInput): boolean {
  const code = String(input.productCode ?? "").trim().toUpperCase();
  if (!code) return false;
  if (input.restrictedCodes.has(code)) return false;
  const line = String(input.line ?? "");
  if (input.isHeadOfficeLine(line)) return false;
  if (input.viewerLine === null) return true;
  // FAILS CLOSED, matching resolveDirectOrderRequesterLineName's own contract: a restricted role
  // with no resolvable line matches nothing rather than seeing the whole company.
  if (input.viewerLine === "") return false;
  return line.trim().toLowerCase() === input.viewerLine;
}

/** Approver-facing sentence for a hold ground. Never a bare code — the screen must read as prose. */
export function describeDirectOrderHoldGround(decision: DirectOrderHoldDecision): string {
  switch (decision.ground) {
    case "verified":
      return "The pharmacy is confirmed, so this order enters the approval chain normally.";
    case "code_proven": {
      const pair = decision.provenBy;
      return pair
        ? `The distributor customer code ${pair.customerCode} is in the master database and its brick matches this request, so the pharmacy is proven real and the order enters the chain at the SFE rung.`
        : "The distributor customer code is in the master database, so the order enters the chain at the SFE rung.";
    }
    case "admin_released":
      return "A System Admin judged this pharmacy and released it into the approval chain.";
    case "code_conflict": {
      const first = decision.conflicts[0];
      if (first?.kind === "owned_by_another_pharmacy") {
        return `The code ${first.customerCode} is real but already belongs to a different Phoenix pharmacy, so this order stays held until someone resolves which pharmacy it is.`;
      }
      return first
        ? `The code ${first.customerCode} is real but the master database places it in brick ${first.mappedBrickId ?? "—"}, not the ${first.declaredBrickId ?? "—"} declared here. It stays held until the geography is settled.`
        : "A submitted code is real but does not fit this request, so the order stays held.";
    }
    case "pharmacy_rejected":
      return "This pharmacy was examined and found not to be real. Nothing releases it.";
    case "unproven":
    default:
      return "No distributor customer code proves this pharmacy exists, so the order is held until it passes validation or a System Admin decides.";
  }
}
