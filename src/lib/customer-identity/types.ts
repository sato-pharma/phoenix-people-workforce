/**
 * Phoenix CRM Wave 2 — the shapes the customer-identity module works in, with no I/O.
 *
 * One doctor is held under a different id in Phoenix CRM, in the marketing venue register, on a
 * direct order and in the iReports360 mirror, and nothing in this system can currently say "these
 * are one person". This module answers that — but only ever as a SUGGESTION. The owner's ruling
 * (2026-09-30) is that the system suggests and the Super Admin confirms, one by one or in bulk; a
 * link exists because a human made it, never because a score crossed a line.
 *
 * 🔴 IT SITS OUTSIDE `src/lib/phoenix-crm/` ON PURPOSE. The Phoenix CRM boundary test forbids that
 * module from reading marketing or direct-order tables, and this one must read all four worlds at
 * once. Moving it under `phoenix-crm/` would either break that test or force the boundary open.
 *
 * 🔴 AND IT NEVER WRITES BACK. No `phoenix_crm_*`, `marketing_*`, `direct_order_*` or `crm_*` row is
 * touched by anything in this module, and no rep's board is fed from it — a link is an annotation
 * that lives entirely in `customer_identity_*`.
 */

/**
 * Which of the five systems a row comes from.
 *
 * `ireports360` is the vendor mirror the carried-over lists came from; `phoenix_crm` is a rep's own
 * validated customer; `marketing` is the venue register; `direct_order` is the ordering desk's.
 *
 * 🔴 `visit_feedback` IS THE ODD ONE: a pharmacy NAME a rep typed on a visit, not a row in any
 * table (owner, 2026-09-30, asked directly — typed names "become link suggestions like any other
 * source"). It has no id of its own, so its `sourceId` is the folded name and the brick it was
 * typed in, and it carries no coordinates: the only point available is the DOCTOR'S clinic, and
 * the shop is near it, not on it. `typedPharmacyCandidates` in `server/reads.ts` holds the
 * reasoning. Everything downstream treats it like any other source — it is a suggestion, and
 * nothing links until the Super Admin confirms it.
 *
 * 🔴 `marketing_customer` IS A DOCTOR OR AN ACCOUNT, NEVER A PHARMACY (owner, 2026-10-18 — Customer
 * 360 links every validated doctor to everything the system knows about it). A marketing clinic is
 * the doctor's own place and enters as PM; a hospital, an account or anything else enters as AM. A
 * validated one joins a Phoenix CRM doctor in Customer 360 only through its CRM code or a link the
 * Super Admin confirmed here.
 */
export type IdentitySource = "phoenix_crm" | "marketing" | "direct_order" | "ireports360" | "visit_feedback" | "marketing_customer";

/**
 * 🔴 PM, AM AND PHARMACY NEVER MIX (owner, 2026-09-30, asked directly: PM *and* AM customers are
 * both in scope, "each linked only with its own kind"). An AM contact is never folded into a PM
 * one however well the names agree — they are different people doing different jobs who happen to
 * share a name — and a pharmacy is not a contact at all, which is a standing rule of its own.
 */
export type IdentityKind = "PM" | "AM" | "pharmacy";

/**
 * How strong the evidence is that two rows are one person. The bands are the owner's review order,
 * not a score: he works the certain ones first and the speculative ones last, and every band still
 * waits for his confirmation.
 *
 * - `fact`     — a contact id or a recorded transfer ties the two. Nothing is being inferred.
 * - `strong`   — the names match and the two places stand within `STRONG_METRES` of each other.
 * - `likely`   — the names match and they share a brick, or a phone number.
 * - `possible` — the same name in the same region, and nothing else.
 */
export type EvidenceBand = "fact" | "strong" | "likely" | "possible";

/** Ascending certainty, so a pair keeps the best band any rule found for it. */
export const BAND_ORDER: readonly EvidenceBand[] = ["possible", "likely", "strong", "fact"];

/**
 * One distributor's own customer code for a shop, and WHOSE code it is.
 *
 * 🔴 THE TWO HALVES ARE NEVER SEPARATED. Each distributor keeps its own customer numbering, so a
 * bare code is meaningless: `421993` at IS-S and `421993` at EP-PHS are two different shops that
 * happen to share an integer. Carrying them as one value is what makes that impossible to get
 * wrong by accident.
 *
 * 🔴 AND A SHOP CARRIES SEVERAL. Measured on production 2026-09-30: 104 of the 131 direct-order
 * pharmacies have a code, 4 of them have two, across 10 distributors. A single-code field would
 * silently pick one and throw the other away — and the one thrown away is exactly the evidence
 * that would have matched.
 */
export type DistributorCodePair = {
  /** Whose numbering it is — the distributor's own code, e.g. `IS-S`. */
  distributorId: string;
  /** That distributor's customer code for this shop. */
  code: string;
};

/** One row from one of the four systems, as the engine needs to see it. */
export type IdentityCandidate = {
  source: IdentitySource;
  /** The row's own id in its own system, as text — these are uuids in some and integers in others. */
  sourceId: string;
  kind: IdentityKind;
  name: string;
  /** The vendor contact id, where the row carries one. Two rows sharing it are the same row twice. */
  contactCrmId?: number | null;
  speciality?: string | null;
  phone?: string | null;
  brickCode?: string | null;
  regionCode?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** Pharmacies only: every distributor code this shop is known by. Empty for a shop with none. */
  distributorPairs?: readonly DistributorCodePair[];
};

/** A pair the engine offers, with the reason in words a person can check. */
export type IdentitySuggestion = {
  kind: IdentityKind;
  band: EvidenceBand;
  left: IdentityCandidate;
  right: IdentityCandidate;
  /** The ordered key both sides share, so (a, b) and (b, a) are one pair and not two. */
  pairKey: string;
  /** Why this pair is being offered, in plain words — never a score and never a percentage. */
  reason: string;
  /**
   * One sentence of warning that does NOT change the band — or absent when there is nothing to warn
   * about. It is read by a human and refuses nothing, exactly as `suspectedWholesalerFlag` does on
   * the validation desk (AGENTS.md §4.1: that tier "only FLAGS, NEVER refuses").
   */
  caution?: string;
};

/**
 * One group of suggestions reviewed together: the same folded name, one kind.
 *
 * 🔴 IT LIVES HERE, NOT IN THE SERVER MODULE THAT BUILDS IT. The review screen is a client
 * component, and a client file naming `server/reads.ts` — even in an `import type` that TypeScript
 * erases — puts a module that imports the service-role client one refactor away from the browser
 * bundle. Shapes are shared; readers are not.
 */
export type SuggestionCluster = {
  key: string;
  kind: IdentityKind;
  name: string;
  pairs: IdentitySuggestion[];
};


/**
 * Customer 360 — one confirmed identity, as a screen reads it.
 *
 * 🔴 THE SHAPES LIVE HERE AND THE READER DOES NOT, for the reason `SuggestionCluster` gives above:
 * a component naming `server/profile.ts` — even in an `import type` that TypeScript erases — puts
 * a module that imports the service-role client one refactor away from the browser bundle.
 */
export type IdentityProfileRow = IdentityCandidate & {
  band: EvidenceBand;
  confirmedAt: string;
  /** The person who confirmed it, by name — never an HR id on a screen. */
  confirmedBy: string;
  /** True when the row has gone from its own system since it was linked. */
  missing: boolean;
};

export type IdentityProfileEvent = {
  at: string;
  event: string;
  actor: string;
  detail: string | null;
};

export type IdentityProfileRuling = {
  pairKey: string;
  reason: string;
  ruledAt: string;
  ruledBy: string;
};

export type IdentityProfile = {
  masterId: string;
  kind: IdentityKind;
  displayName: string;
  createdAt: string;
  createdBy: string;
  rows: IdentityProfileRow[];
  events: IdentityProfileEvent[];
  /** Live "not the same person" rulings that touch a row on this master. */
  ruledApart: IdentityProfileRuling[];
};

/** One line of the way in, when there is no link to follow. */
export type IdentityMasterSummary = {
  masterId: string;
  kind: IdentityKind;
  displayName: string;
  links: number;
};

/**
 * "Also known as" — the other rows a CONFIRMED master holds, for a page that is showing one of
 * them and would otherwise have no idea the rest exist.
 *
 * 🔴 CONFIRMED ONLY. A suggestion never travels in this shape, and must never be rendered through
 * it: a maybe printed on a page a manager reads becomes a fact the moment he acts on it, and the
 * whole design of this module is that the Super Admin decides each one by hand. The reader returns
 * null when the row sits on no master at all, which is the normal case today.
 *
 * 🔴 IT IS A NOTE, NOT A JOIN. Nothing here merges two rows, moves a figure, or re-points an id:
 * the counterpart is named so a human knows to look, exactly as the owner's treasure rule requires
 * of a customer held on two lines.
 */
export type AlsoKnownAsRow = {
  kind: IdentityKind;
  /** True when the row has gone from its own system since it was linked. */
  missing: boolean;
  name: string;
  source: IdentitySource;
  sourceId: string;
};

export type AlsoKnownAs = {
  displayName: string;
  masterId: string;
  /** Every row on the master EXCEPT the one that was asked about. Never empty when this is non-null. */
  others: AlsoKnownAsRow[];
};
