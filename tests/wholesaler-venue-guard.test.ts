import assert from "node:assert/strict";

import {
  WHOLESALER_VENUE_REFUSED_MESSAGE,
  isCertainWholesalerVenue,
  suspectedWholesalerFlag,
  suspectedWholesalerNote,
} from "../src/lib/venues/wholesaler-venue-guard.ts";

/**
 * Owner rule 2026-09-22 ("never never never"): a wholesaler / makhzan is never shown as a matchable
 * venue and never validated as one, in both the direct-order and the marketing flows. The detector
 * is two-tier (owner decision, asked in chat, "block certain, flag فارما"): the unmistakable
 * warehouses are HARD-BLOCKED, the ambiguous store words are FLAGGED for a human, never refused.
 *
 * BREAK-THE-FIX HEADLINE: the first assertion in the "certain" loop —
 * `isCertainWholesalerVenue("مخزن نيو سيتي") === true`. Delete the مخزن/جملة line in
 * `wholesaler-venue-guard.ts` (`normalized.includes(MAKHZAN_STEM) || …`) and this assertion fires,
 * because that live DO makhzan then reads as an ordinary venue again.
 */
export function runWholesalerVenueGuardTests() {
  // ── CERTAIN — hard-blocked from every picker and refused at every write path ──
  // Production spellings. Each is unmistakably a distributor's warehouse.
  const certainBlocked: ReadonlyArray<readonly [string, string]> = [
    ["مخزن نيو سيتي", "makhzan (the one live validated DO venue today)"],
    ["مخزن العربية", "makhzan"],
    ["مخزن رضا محمد علم الدين", "makhzan"],
    ["التوأمان فارم لتجارةوتوزيع الادوية", "medicines trade phrase"],
    ["الحجاز فارما لتجارة وتوزيع الادوية", "medicines trade phrase"],
    ["الدوائية لتجارة وتوزيع الادوية", "medicines trade phrase"],
    ["شركة النور جملة", "جملة / wholesale"],
    ["م - سمارت", "EPDA warehouse prefix «م - »"],
    ["الفرسان انترناشيونال جروب", "owner's named-wholesaler roster"],
  ];
  for (const [name, why] of certainBlocked) {
    assert.equal(
      isCertainWholesalerVenue(name),
      true,
      `"${name}" must be a CERTAIN wholesaler (hard-blocked) — ${why}`,
    );
    // A certain wholesaler is already blocked, so it is never ALSO surfaced as merely suspected —
    // otherwise a desk would show an advisory flag on something the pickers already dropped.
    assert.equal(
      suspectedWholesalerFlag(name),
      false,
      `"${name}" is hard-blocked, so it is not additionally flagged as suspected`,
    );
    assert.equal(
      suspectedWholesalerNote(name),
      null,
      `"${name}" is hard-blocked, so there is no advisory note to render`,
    );
  }

  // El Qema (QM) is a wholesale-only distributor — every non-protected customer of it is a warehouse.
  assert.equal(
    isCertainWholesalerVenue("اي شركة", "999", "QM"),
    true,
    "any El Qema (QM) customer is a certain wholesaler, whatever its name reads",
  );

  // ── PROTECTED — an owner pharmacy-ruling is never blocked and never even flagged ──
  // Proves the detector inherits the closing's pharmacy-overrides: a real pharmacy whose name
  // carries a warehouse word (مخزن الطرشوبى is the owner's own example) stays a pharmacy.
  const protectedNames: ReadonlyArray<readonly [string, string]> = [
    ["مخزن الطرشوبى للادويه", "الطرشوبى is an owner pharmacy-override despite مخزن"],
    ["صيدلية آدم فارما", "صيدلية (never-store) beats فارم"],
    ["مخازن الصحة العامة", "government depot مخازن (plural), not the singular مخزن"],
  ];
  for (const [name, why] of protectedNames) {
    assert.equal(
      isCertainWholesalerVenue(name),
      false,
      `"${name}" is a protected pharmacy, never hard-blocked — ${why}`,
    );
    assert.equal(
      suspectedWholesalerFlag(name),
      false,
      `"${name}" is protected, so it is never even flagged — ${why}`,
    );
  }

  // ── AMBIGUOUS — never hard-blocked, but FLAGGED for a human (the فارما decision) ──
  // A field venue branded "X فارما / Pharma" may be a real retail pharmacy, so it must never be
  // silently refused; the desk sees an advisory warning and decides.
  const ambiguousFlagged: ReadonlyArray<readonly [string, string]> = [
    ["سمارت فارما", "bare فارما"],
    ["بدر فارما", "bare فارما"],
    ["كيور فارم - الزقازيق", "bare فارم"],
    ["الجمعيه التعاونيه بتروجاس", "الجمعيه cooperative"],
    ["الشركة المصرية للأدوية", "الشركة"],
  ];
  for (const [name, why] of ambiguousFlagged) {
    assert.equal(
      isCertainWholesalerVenue(name),
      false,
      `"${name}" is AMBIGUOUS — never hard-blocked (a real pharmacy may be branded this way) — ${why}`,
    );
    assert.equal(
      suspectedWholesalerFlag(name),
      true,
      `"${name}" is AMBIGUOUS — flagged for a human to check — ${why}`,
    );
    assert.ok(
      (suspectedWholesalerNote(name) ?? "").length > 0,
      `"${name}" carries an advisory note for the validator — ${why}`,
    );
  }

  // ── NEITHER — an ordinary pharmacy or clinic is untouched by both tiers ──
  for (const name of ["صيدلية النور", "عيادة دكتور محمد بدوي", "Pharmacy A"]) {
    assert.equal(isCertainWholesalerVenue(name), false, `"${name}" is an ordinary venue, not blocked`);
    assert.equal(suspectedWholesalerFlag(name), false, `"${name}" is an ordinary venue, not flagged`);
  }

  // A blank or missing name can never be a wholesaler (there is nothing to read).
  for (const empty of ["", "   ", null, undefined] as ReadonlyArray<string | null | undefined>) {
    assert.equal(isCertainWholesalerVenue(empty), false, "a blank name is never a certain wholesaler");
    assert.equal(suspectedWholesalerFlag(empty), false, "a blank name is never flagged");
  }

  // The shared refusal message names the rule and points at the override escape hatch, so every
  // capture point and desk refuses a wholesaler in the same words.
  assert.ok(WHOLESALER_VENUE_REFUSED_MESSAGE.length > 0, "the refusal message is non-empty");
  assert.match(
    WHOLESALER_VENUE_REFUSED_MESSAGE,
    /wholesaler|makhzan|warehouse/i,
    "the refusal message names what it refuses",
  );
}
