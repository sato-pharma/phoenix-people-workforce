/**
 * Phoenix insights — the odd things about one contact's record, one short sentence each.
 *
 * The owner asked for this on 2026-09-01: "any weird thing, like same full match about forty
 * kilometre away — highlight it... you can put beside each contact name Phoenix insights, and when
 * anyone presses on it you show the insights. But be simple, use clear English, be to the point,
 * and don't prolong."
 *
 * So this is deliberately NOT a score and NOT a report. Each insight names one thing that looks
 * wrong about the row and says it in a sentence a manager can act on, and a row with nothing odd
 * carries no chip at all — which is most rows.
 *
 * ## Every threshold here exists to keep the chip rare, and every one was measured
 *
 * Production, 2026-09-01, 9,518 contacts. The obvious rules are far too common to mean "weird":
 *
 *  | rule                                    | rows it would mark |
 *  | --------------------------------------- | ------------------ |
 *  | same name, another rep, over 200 m      | 1,007              |
 *  | same name, another rep, over 5 km       | 785                |
 *  | own check-ins spread over 5 km          | 1,596              |
 *
 * A chip on one row in six is wallpaper, and the owner's standing constraint on this board is that
 * a marking must not make the page noisy. Three decisions make these rules discriminate instead:
 *
 *  - A NAME MATCH ONLY COUNTS WHEN THE NAME IS RARE. Egyptian names repeat constantly, so two
 *    doctors 40 km apart sharing a common name are simply two doctors, and saying otherwise on a
 *    thousand rows would teach the reader to ignore the chip. Requiring the name to be carried by
 *    at most three contacts company-wide cuts 785 rows to 390, and what survives is exactly the
 *    shape the owner described: a distinctive full name appearing twice, in two cities.
 *  - AND THE NAME ALONE STILL DOES NOT DECIDE IT. The owner's second instruction, the same day:
 *    "you must also check the speciality, check the brick, check the phone number — so I have many
 *    ways to tell that this is a fraud or this is normal." Something other than the name has to
 *    agree before the pair is remarked on, and the sentence names which. See `agreementsBetween`
 *    for the measurement; it takes the company from 585 flagged contacts to 319, and turns the
 *    other 266 from a question nobody can answer into silence.
 *  - THE DISTANCE HAS TO BE ABSURD, not merely large. 50 km between check-ins on one contact is not
 *    a doctor with two clinics, it is a wrong pin — 113 contacts, against 1,596 at 5 km. The 5 km
 *    case is already explained next door, by the confidence popup's "what is pulling the score
 *    down" line, and this file never repeats what that one already says.
 *
 * ## What it actually marks
 *
 * 703 of 9,518 contacts, 7.4% — distant twin 319, duplicate row 192, shared phone 104, scattered
 * visits 104. The gates above halved that from 1,408, and the reason to keep measuring per REP
 * rather than per company is that the average lies: one rep's list sat at 102 of 110 flagged on
 * the un-capped phone rule while the company average looked harmless at 7%. That same list now
 * carries two chips, and both are worth opening.
 *
 * ## This is the class the sharing highlight deliberately drops
 *
 * `findSharedCustomers` only calls two rows the same customer within SAME_CUSTOMER_M (200 m), for
 * good reason — 69% of same-name cross-rep pairs are over 5 km apart and are strangers. That test
 * is right for a highlight, but it means a same-name pair 40 km apart is currently INVISIBLE: too
 * far to be shared, and nothing else looks at it. It is also the owner's own example of a weird
 * thing. So the two rules meet at 200 m and never overlap: under it the row is a shared customer,
 * far over it the row gets an insight.
 */

import {
  formatDistance,
  MAX_CONTACTS_PER_SHARED_PHONE,
  metresBetween,
  type RosterEntry,
} from "./location-confidence";

/**
 * Metres. Two same-named contacts under different reps further apart than this are worth a look.
 *
 * Well clear of SAME_CUSTOMER_M (200 m) rather than adjacent to it, so the gap between "the same
 * customer" and "something is wrong here" is not a rounding error. Between the two the pair is
 * simply not remarked on: a name match 800 m away is a rep who pinned the next street.
 */
export const DISTANT_TWIN_M = 5_000;

/**
 * How many contacts may carry a name before a match on it means nothing.
 *
 * Three, measured. Of the same-name cross-rep pairs over 5 km apart, restricting to names carried
 * by at most two contacts leaves 390 rows and at most three leaves 473 — while dropping the gate
 * entirely leaves 785, most of them common names shared by unrelated doctors.
 */
export const RARE_NAME_MAX = 3;

/** Below this many characters a name key is too short to identify anybody. */
export const MIN_NAME_KEY = 4;

/**
 * Above this many contacts, a shared phone stops being a fact about THIS contact.
 *
 * Measured the hard way. The rule started at "more than three contacts share it", which is right
 * for deciding whether a phone proves two records are one customer — and catastrophic as an
 * insight: one rep's list came back with 102 of its 110 rows flagged, because a single number sits
 * on 101 of their contacts. A chip on 93% of a list is wallpaper, and it buried the six distant
 * twins and one scattered contact on that same list, which are the findings worth having.
 *
 * The company-wide average hid this completely — 664 contacts, 7%, looks harmless until you see
 * that they are concentrated on a handful of reps. So the rule now covers only the band where the
 * number says something about the doctor: four to ten contacts is a clinic line or a mistake worth
 * checking, while a number on dozens is a hospital switchboard or a placeholder such as 000000000.
 * That is a REP-level fact about the whole list, and repeating it on a hundred rows is the wrong
 * shape for it.
 */
export const OBVIOUS_SWITCHBOARD_AT = 10;

/**
 * Metres. A contact whose own check-ins reach further than this from the pin cannot be one place.
 *
 * 50 km is a different claim from "the visits disagree" — at this range it is two governorates, so
 * either the pin or the check-in belongs to another contact entirely. 113 contacts qualify.
 */
export const SCATTERED_M = 50_000;

/** One odd thing about one contact. `title` is the heading; `detail` is a single sentence. */
export type PhoenixInsight = {
  detail: string;
  kind: "distant twin" | "duplicate row" | "scattered visits" | "shared phone line";
  title: string;
};

/**
 * Which of the other CRM fields two same-named records agree on, strongest first.
 *
 * The owner asked for this on 2026-09-01: "you must also check if the same doctor name — check the
 * speciality, check the brick, check the phone number. So I have many ways to tell that this is a
 * fraud or this is normal."
 *
 * He is right, and the measurement is emphatic. Of the 662 same-name cross-rep pairs over 5 km
 * apart in production:
 *
 *  | field       | agrees | disagrees | unknown |
 *  | ----------- | ------ | --------- | ------- |
 *  | speciality  |    338 |       324 |       0 |
 *  | CRM area    |     32 |       630 |       0 |
 *  | phone       |      4 |        44 |     614 |
 *
 * Speciality splits the set almost exactly in half and is never missing, so it carries most of the
 * verdict. Phone is nearly always unknown but decisive when present. The area is the sharpest of
 * the three when it agrees: one locality, pinned kilometres apart, is a contradiction on its face.
 *
 * Returned in that order because the sentence reads them in order, and the reader should meet the
 * strongest evidence first.
 */
function agreementsBetween(mine: RosterEntry, other: RosterEntry): string[] {
  const agrees: string[] = [];
  if (mine.phoneKey && mine.phoneKey === other.phoneKey) agrees.push("phone number");
  if (mine.regionKey && mine.regionKey === other.regionKey) agrees.push("area");
  const speciality = mine.speciality?.trim().toLowerCase();
  if (speciality && speciality === other.speciality?.trim().toLowerCase()) agrees.push("speciality");
  return agrees;
}

/** "phone number and speciality" — an English list, so the sentence stays a sentence. */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** One of the rep's rows, reduced to what the insights need. */
export type InsightRow = {
  agentCrmId: number;
  contactCrmId: number;
  /** Every check-in filed against THIS contact row. Partner rows are deliberately not folded in. */
  points: readonly { lat: number; lon: number }[];
};

/**
 * What looks wrong about each of one rep's contacts.
 *
 * Returns a map keyed by contact id holding ONLY the rows that have something to say, so a row with
 * no entry needs no chip and no thought — the same shape `findNeighbours` uses next door.
 *
 * `roster` is the whole company's contacts, because three of the four rules are about a row's
 * relationship to records the rep cannot see. `pins` is the location the board shows for a contact,
 * which is its newest check-in.
 */
export function buildPhoenixInsights(
  rows: readonly InsightRow[],
  roster: readonly RosterEntry[],
  pins: ReadonlyMap<number, { lat: number; lon: number }>,
  repNames: ReadonlyMap<number, string>,
): Map<number, PhoenixInsight[]> {
  const byId = new Map<number, RosterEntry>();
  const byName = new Map<string, RosterEntry[]>();
  const byPhone = new Map<string, RosterEntry[]>();
  for (const entry of roster) {
    byId.set(entry.contactCrmId, entry);
    if (entry.nameKey.length >= MIN_NAME_KEY) {
      const list = byName.get(entry.nameKey);
      if (list) list.push(entry);
      else byName.set(entry.nameKey, [entry]);
    }
    if (entry.phoneKey) {
      const list = byPhone.get(entry.phoneKey);
      if (list) list.push(entry);
      else byPhone.set(entry.phoneKey, [entry]);
    }
  }

  const found = new Map<number, PhoenixInsight[]>();
  for (const row of rows) {
    const mine = byId.get(row.contactCrmId);
    if (!mine) continue;
    const myPin = pins.get(row.contactCrmId) ?? null;
    const sameName = byName.get(mine.nameKey) ?? [];
    const insights: PhoenixInsight[] = [];

    // ORDERED MOST CERTAIN FIRST. A duplicate on one rep's own list is a fact about two records;
    // a distant twin is a question; the last two are data quality. A reader who stops after the
    // first line has read the one most likely to be actionable.

    // 1. THE SAME NAME TWICE ON ONE REP'S OWN LIST. Two rows, one rep, one name — the CRM's own
    //    duplicate, not sharing, which is why `findSharedCustomers` skips it by design.
    const duplicates = sameName.filter(
      (other) => other.agentCrmId === row.agentCrmId && other.contactCrmId !== row.contactCrmId,
    );
    if (duplicates.length > 0) {
      const times = duplicates.length + 1;
      let apart: number | null = null;
      if (myPin) {
        for (const other of duplicates) {
          const otherPin = pins.get(other.contactCrmId);
          if (!otherPin) continue;
          const metres = metresBetween(myPin.lat, myPin.lon, otherPin.lat, otherPin.lon);
          if (apart == null || metres > apart) apart = metres;
        }
      }
      insights.push({
        detail:
          `The same name is on this rep's own list ${times === 2 ? "twice" : `${times} times`}` +
          `${apart != null && apart >= 1 ? `, ${formatDistance(apart)} apart` : ""}. One row is probably a duplicate.`,
        kind: "duplicate row",
        title: "On this list twice",
      });
    }

    // 2. THE OWNER'S OWN EXAMPLE — the same full name under another rep, a long way off.
    if (myPin && mine.nameKey.length >= MIN_NAME_KEY && sameName.length <= RARE_NAME_MAX) {
      const twins: { agrees: string[]; metres: number; repName: string }[] = [];
      for (const other of sameName) {
        if (other.agentCrmId === row.agentCrmId) continue;
        const otherPin = pins.get(other.contactCrmId);
        if (!otherPin) continue;
        const metres = metresBetween(myPin.lat, myPin.lon, otherPin.lat, otherPin.lon);
        if (metres <= DISTANT_TWIN_M) continue;
        const repName = repNames.get(other.agentCrmId);
        // No readable name means no way to say whose list it is on, and the standing rule is that a
        // screen never prints a raw id at a reader. Silence beats "also under agent 4412".
        if (!repName) continue;
        // A MATCHING NAME ON ITS OWN IS NOT ENOUGH, and this is the gate the owner asked for. Two
        // rare-named records far apart are either one doctor pinned twice or two strangers, and
        // until something else agrees there is no way to tell which — so saying anything is a
        // coin toss printed as a finding. Requiring one agreement takes the company from 585
        // flagged contacts to 319, and every one that survives can state its own reason.
        const agrees = agreementsBetween(mine, other);
        if (agrees.length === 0) continue;
        twins.push({ agrees, metres, repName });
      }
      if (twins.length > 0) {
        const furthest = twins.reduce((best, twin) => (twin.metres > best.metres ? twin : best));
        const reps = new Set(twins.map((twin) => twin.repName));
        const where =
          reps.size === 1
            ? `This exact name is also on ${furthest.repName}'s list, ${formatDistance(furthest.metres)} away`
            : `This exact name is also on ${reps.size} other reps' lists, the furthest ${formatDistance(furthest.metres)} away`;
        // The phone is the only one of the three that settles it. Two records reachable on one
        // number are one doctor, so the question stops being "who are these people" and becomes
        // "which pin is wrong" — a smaller, answerable question, and worth saying out loud.
        const verdict = furthest.agrees.includes("phone number")
          ? "This is one doctor on two lists, so one of the pins is wrong."
          : "Worth checking which pin is right.";
        insights.push({
          detail: `${where}, with the same ${joinWords(furthest.agrees)}. ${verdict}`,
          kind: "distant twin",
          title: "Same name, far away",
        });
      }
    }

    // 3. CHECK-INS TOO FAR APART TO BE ONE PLACE.
    if (myPin && row.points.length > 1) {
      let furthest = 0;
      for (const point of row.points) {
        const metres = metresBetween(myPin.lat, myPin.lon, point.lat, point.lon);
        if (metres > furthest) furthest = metres;
      }
      if (furthest > SCATTERED_M) {
        insights.push({
          detail: `Visits on this contact are spread over ${formatDistance(furthest)}. They cannot all be the same place.`,
          kind: "scattered visits",
          title: "Visits far apart",
        });
      }
    }

    // 4. A PHONE THAT BELONGS TO A BUILDING, NOT A PERSON. Same threshold the identity matcher uses
    //    to refuse a phone as evidence, so the two never disagree about what a switchboard is.
    if (mine.phoneKey) {
      const sharing = new Set((byPhone.get(mine.phoneKey) ?? []).map((entry) => entry.contactCrmId)).size;
      if (sharing > MAX_CONTACTS_PER_SHARED_PHONE && sharing <= OBVIOUS_SWITCHBOARD_AT) {
        insights.push({
          detail: `This phone number is on ${sharing} different contacts, so it is not this contact's own line.`,
          kind: "shared phone line",
          title: "Phone is not personal",
        });
      }
    }

    if (insights.length > 0) found.set(row.contactCrmId, insights);
  }
  return found;
}
