/**
 * How much a contact's location can be trusted, why, and who else stands next to it.
 *
 * Three related questions the owner asked for on 2026-09-01, all answered from the same two inputs —
 * the pin the board is showing and every check-in any rep has ever made on that contact:
 *
 *  1. CONFIDENCE. "Beside every contact you will add confidence of his location percentage... from
 *     the current location saved here and all check-ins done by any rep to this doctor."
 *  2. SHARED CUSTOMERS. "Any customer or contact who is shared between more than one rep, highlight
 *     and give a color, and add a small line why he is highlighted, who he is shared with."
 *  3. NEIGHBOURS. "In the address column, highlight with a very light color the doctors in the same
 *     brick that are very near to each other."
 *
 * Everything here is PURE — no Supabase import — for two reasons. The client component renders the
 * score and its explanation, so it has to be importable from the browser half; and every threshold
 * below is a judgement call that has to be pinned by fixtures rather than argued about later.
 *
 * ## Every constant in this file was measured, not guessed
 *
 * Production, 2026-09-01, 111,914 check-ins over 15,547 contacts (mean 7.2 each, p99 35, max 616):
 *
 *  - Against the pin the board shows, a mean of 60% of a contact's check-ins fall within 100 m, 66%
 *    within 150 m, 73% within 250 m and 82% within 500 m. So the spread is real and the score has
 *    something to discriminate: of the 13,043 contacts with more than one check-in, 3,953 (30%) have
 *    EVERY check-in inside 150 m, while 3,787 (29%) have under half of them there.
 *  - 2,503 contacts have exactly one check-in. A single observation agrees with itself perfectly, so
 *    scoring it by agreement would hand the least-verified contacts a top mark. It gets its own
 *    branch below.
 *  - Only 7.4% of contacts have been checked in on by more than one rep, so a second observer is a
 *    bonus worth a few points, never a requirement.
 *  - Freshness is not this dataset's problem: the median contact was last seen 34 days ago, 76% in
 *    the last 90 days, and NOT ONE is over nine months stale. Recency is therefore a small tiebreak,
 *    not a major term — weighting it heavily would spread the scores without adding information.
 */

/** Metres. Within this of the shown pin, a check-in is the same address — phone GPS drifts 10-20 m. */
export const NEAR_M = 100;

/** Metres. Within this, the same block — a rep who parked round the corner. Counts for half. */
export const CLOSE_M = 300;

/**
 * Metres. Two contacts this close are at one address.
 *
 * DELIBERATELY TIGHT, because this is the one marking that could swamp the page. The owner's
 * constraint was explicit — "every colour used lightly, I don't want to make the page noisy" — and a
 * highlight that lands on most rows has stopped being a highlight.
 *
 * Measured across the 171 brick groups holding three or more located contacts (2026-09-01), the
 * share of a group that would be marked is: 35% at 15 m, 44% at 30 m, 56% at 60 m. It genuinely
 * discriminates at the low end — only 5 groups are entirely one cluster at 15 m, 9 at 30 m — but a
 * dense urban brick runs well above the average: one Alexandria rep measured 62% at 30 m.
 *
 * 20 m is chosen against that worst case rather than the mean. It is also the honest reading of
 * "very near to each other": phone GPS drifts 10-20 m, so 20 m is about as tight as two fixes on one
 * building ever get, and anything further apart is a walk rather than a shared doorway.
 */
export const NEIGHBOUR_M = 20;

/**
 * Metres. Two same-named contacts under different reps this close are one customer.
 *
 * A NAME ALONE IS NOT AN IDENTITY, and the data says so loudly. 1,144 cross-rep pairs share a
 * normalized name and both have a pin; 787 of them (69%) are more than 5 km apart — different
 * doctors who happen to be called the same thing, which in Egypt is extremely common. Only 214 pairs
 * are within 200 m. Matching on name alone would have highlighted five times too many rows and
 * called strangers the same person.
 */
export const SAME_CUSTOMER_M = 200;

/**
 * A phone on more than this many contacts is a switchboard, not a person.
 *
 * 34 phone numbers are shared across reps. Thirty of them cover two or three contacts — a doctor
 * reachable on one line. The largest covers FIFTY-THREE, which is a hospital reception desk, and
 * treating that as one customer would declare 53 unrelated doctors the same human being.
 */
export const MAX_CONTACTS_PER_SHARED_PHONE = 3;

/** One check-in, reduced to what scoring needs. */
export type CheckinPoint = {
  agentCrmId: number | null;
  /** ISO timestamp. Null is tolerated — it costs only the recency term. */
  at: string | null;
  lat: number;
  lon: number;
};

export type ConfidenceBand = "high" | "medium" | "low" | "unverified";

/** One line of the popup's explanation: what was checked, and what it was worth. */
export type ConfidenceReason = {
  detail: string;
  label: string;
  /** Points this line contributed. Null for a line that explains rather than scores. */
  points: number | null;
};

export type LocationConfidence = {
  band: ConfidenceBand;
  /** Check-ins between NEAR_M and CLOSE_M of the shown pin — half credit. */
  close: number;
  daysSinceLastSeen: number | null;
  /** Check-ins beyond CLOSE_M. These are what pull a score down. */
  far: number;
  /** Check-ins within NEAR_M of the shown pin. */
  near: number;
  /** Distinct reps who have ever checked in on this contact. */
  observers: number;
  reasons: ConfidenceReason[];
  /** 0-100. */
  score: number;
  /** Every check-in considered. */
  total: number;
};

/**
 * Metres between two points, flat-earth. Egypt spans about 7 degrees, and the longest distance this
 * is ever asked for is a few kilometres, where the error against a great-circle result is
 * centimetres. A spherical formula here would cost clarity and buy nothing.
 */
export function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const latMetres = (aLat - bLat) * 111_320;
  const lonMetres = (aLon - bLon) * 111_320 * Math.cos((aLat * Math.PI) / 180);
  return Math.sqrt(latMetres * latMetres + lonMetres * lonMetres);
}

/** Metres in the unit a reader thinks in. Shared, so every screen states a distance the same way. */
export function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/** Recency is a tiebreak worth 5 points at most — see the header on why it is deliberately small. */
function recencyPoints(days: number | null): number {
  if (days == null) return 0;
  if (days <= 90) return 5;
  if (days <= 180) return 3;
  if (days <= 365) return 1;
  return 0;
}

/** More agreeing visits is stronger evidence, with diminishing returns. Worth 20 points at most. */
function corroborationPoints(agreeing: number): number {
  if (agreeing <= 1) return 0;
  if (agreeing === 2) return 8;
  if (agreeing <= 4) return 14;
  if (agreeing <= 9) return 17;
  return 20;
}

function bandFor(score: number, total: number): ConfidenceBand {
  if (total <= 1) return "unverified";
  if (score >= 80) return "high";
  if (score >= 55) return "medium";
  return "low";
}

/**
 * Score the pin the board is showing against every check-in on that contact.
 *
 * `pin` is the location displayed — the newest check-in. The score answers one question: if the reps
 * went back, would they end up here? So each check-in is a vote on the pin, the near ones for and
 * the far ones against, and the popup states the vote count in those words.
 *
 * `now` is injected so the fixtures can pin the recency term instead of drifting a day at a time.
 */
export function scoreLocationConfidence(
  pin: { lat: number; lon: number } | null,
  checkins: readonly CheckinPoint[],
  now: number = Date.now(),
  shared?: {
    count: number;
    repNames: readonly string[];
    /** Reps who share this customer but whose record stands somewhere else — see the reason line. */
    distant?: readonly { metres: number | null; repName: string }[];
  },
): LocationConfidence | null {
  // No pin means nobody has ever checked in, so there is nothing to be confident ABOUT. The board
  // shows the CRM's own address for these and no score at all — a 0% would read as "this location is
  // wrong", when the truth is "no one has been here yet".
  if (!pin || checkins.length === 0) return null;

  const observers = new Set(checkins.map((point) => point.agentCrmId).filter((id) => id != null)).size;
  const lastSeen = checkins.reduce<string | null>(
    (newest, point) => (point.at && (!newest || point.at > newest) ? point.at : newest),
    null,
  );
  const days = daysSince(lastSeen, now);
  const recency = recencyPoints(days);

  // ONE CHECK-IN CANNOT CONFIRM ITSELF. 2,503 contacts are in this state. The rep did stand there, so
  // this is not a bad location — it is an unchecked one, and it is scored and worded as exactly that.
  if (checkins.length === 1) {
    const score = 45 + recency;
    return {
      band: "unverified",
      close: 0,
      daysSinceLastSeen: days,
      far: 0,
      near: 1,
      observers,
      reasons: [
        {
          detail: "A rep did stand here, so the pin is real — but no second visit has ever landed on it.",
          label: "Seen once, never confirmed",
          points: 45,
        },
        recencyLine(days, recency),
      ],
      score,
      total: 1,
    };
  }

  let near = 0;
  let close = 0;
  let far = 0;
  const agreeingObservers = new Set<number>();
  for (const point of checkins) {
    const metres = metresBetween(pin.lat, pin.lon, point.lat, point.lon);
    if (metres <= NEAR_M) {
      near += 1;
      if (point.agentCrmId != null) agreeingObservers.add(point.agentCrmId);
    } else if (metres <= CLOSE_M) {
      close += 1;
      if (point.agentCrmId != null) agreeingObservers.add(point.agentCrmId);
    } else {
      far += 1;
    }
  }

  const total = checkins.length;
  const agreement = (near + close * 0.5) / total;
  const agreementPoints = Math.round(70 * agreement);
  const corroboration = corroborationPoints(near + close);
  const secondObserver = agreeingObservers.size > 1 ? 5 : 0;
  const score = Math.max(0, Math.min(100, agreementPoints + corroboration + secondObserver + recency));

  const reasons: ConfidenceReason[] = [
    {
      detail:
        `${near} of ${total} check-ins landed within ${NEAR_M} m of this pin` +
        (close > 0 ? `, and ${close} more within ${CLOSE_M} m, which counts for half` : "") +
        (far > 0 ? `. ${far} landed somewhere else entirely.` : "."),
      label: "How well the visits agree",
      points: agreementPoints,
    },
    {
      detail:
        near + close === 0
          ? "No visit has confirmed this pin."
          : `${near + close} ${near + close === 1 ? "visit backs" : "visits back"} this pin up. More agreeing visits is stronger evidence.`,
      label: "How many visits back it up",
      points: corroboration,
    },
    {
      detail:
        agreeingObservers.size > 1
          ? `${agreeingObservers.size} different reps have checked in near this pin, so it is not one person's habit.`
          : "Only one rep has ever checked in here, so the visits are not independent of each other.",
      label: "Confirmed by more than one rep",
      points: secondObserver,
    },
    recencyLine(days, recency),
  ];

  // WHEN ANOTHER REP'S VISITS ARE COUNTED, SAY SO. Folding them in is what makes the score describe
  // the customer rather than one rep's row, but it also means the number now rests on an identity
  // JUDGEMENT — that these two rows are the same doctor. A wrong judgement must be legible on the
  // face of the popup instead of quietly lifting the percentage, so the line names the rep and the
  // count, and sits with the reasons that produced the score rather than in a footnote.
  if (shared && shared.count > 0 && shared.repNames.length > 0) {
    const names = shared.repNames;
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    reasons.push({
      detail:
        `${shared.count} of these ${shared.count === 1 ? "visits is" : "visits are"} from ${who}'s own record of ` +
        "the same customer. The CRM gives each rep their own row for one doctor, so their visits are counted here too.",
      label: "Counted from a shared customer",
      points: null,
    });
  }

  // A SHARED ROW WHOSE PARTNER WAS NOT COUNTED MUST SAY WHY, or the popup reproduces the exact
  // contradiction this whole change exists to remove: a violet line naming a second rep sitting
  // above the sentence "only one rep has ever checked in here". That sentence is now literally
  // TRUE for these rows — nobody else has checked in at THIS pin — but a reader cannot see the
  // difference between "the other rep works somewhere else" and "the screen is lying to me", and
  // there are 41 such rows in production. So the gap gets named instead of left to be inferred.
  const distant = shared?.distant ?? [];
  if (distant.length > 0) {
    const names = distant.map((entry) => entry.repName);
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    const nearest = distant.reduce<number | null>(
      (best, entry) => (entry.metres != null && (best == null || entry.metres < best) ? entry.metres : best),
      null,
    );
    const where =
      nearest == null
        ? "has no confirmed location of their own"
        : `stands about ${formatDistance(nearest)} away`;
    reasons.push({
      detail:
        `${who} shares this customer, but their record ${where}, so their visits are not evidence about ` +
        "this pin and are left out of the score. A shared phone can be a clinic switchboard, or one doctor working in two places.",
      label: "Shared, but not the same place",
      points: null,
    });
  }

  if (far > 0) {
    reasons.push({
      detail:
        `${far} of the ${total} check-ins are more than ${CLOSE_M} m away. That is usually a doctor who ` +
        "practises in two places, or a rep who checked in before arriving.",
      label: "What is pulling the score down",
      points: null,
    });
  }

  return { band: bandFor(score, total), close, daysSinceLastSeen: days, far, near, observers, reasons, score, total };
}

function recencyLine(days: number | null, points: number): ConfidenceReason {
  return {
    detail:
      days == null
        ? "No date on the last check-in."
        : days === 0
          ? "Last confirmed today."
          : days === 1
            ? "Last confirmed yesterday."
            : days <= 90
              ? `Last confirmed ${days} days ago.`
              : `Last confirmed ${days} days ago, so it may have moved since.`,
    label: "How recently it was confirmed",
    points,
  };
}

/** The label the chip shows. Percentages read as accuracy to a non-engineer, which is the intent. */
export function confidenceLabel(confidence: LocationConfidence | null): string {
  return confidence ? `${confidence.score}%` : "Not confirmed";
}

/** Another rep holding what is, on the evidence, the same customer. */
export type SharedWith = {
  agentCrmId: number;
  /** Why the two rows were judged the same customer — stated on screen, never left implicit. */
  basis: "name and location" | "shared phone";
  /**
   * The other rep's contact rows that are CONFIRMED TO STAND IN THE SAME PLACE as ours.
   *
   * Carried, never printed — the standing rule is that no raw id reaches a reader. It is here
   * because the other rep's VISITS are filed against these ids, not against ours: the CRM splits one
   * doctor into a row per rep, so a score computed on our row alone cannot see a single one of them.
   * Measured 2026-09-01, that is not a rare shape — 374 contacts the board marks as shared have a
   * partner row carrying its own check-ins, and every one of them used to be told, in the popup,
   * that only one rep had ever been there while the row beside it named the second rep.
   *
   * DELIBERATELY NARROWER THAN THE MATCH ITSELF, and it can be empty on a row that is genuinely
   * shared. A row earns its highlight on a looser test than its score earns another rep's visits —
   * see the note in `consider`, and the 26 phone-sharing pairs measured over 5 km apart.
   */
  contactCrmIds: number[];
  /** Metres between the two pins, when both are located. */
  metres: number | null;
  repName: string;
};

/** A contact standing at effectively the same address, inside the same brick and the same list. */
export type NearbyContact = {
  contactCrmId: number;
  metres: number;
  name: string;
};

/** Digits only. Egyptian numbers arrive with spaces, dashes and a mix of 0/+20 prefixes. */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/[^0-9]/g, "");
  if (digits.length < 9) return null;
  // Compare on the last nine digits so 01001234567, +201001234567 and 1001234567 are one number.
  return digits.slice(-9);
}

/** Case- and punctuation-insensitive name key. Keeps Arabic letters, which are most of these names. */
export function nameKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, "");
}

/**
 * Which contacts inside one already-grouped, already-scoped list stand at the same address.
 *
 * Called per brick group, so "the same brick" is structural rather than a filter — the caller has
 * already decided what a group is. Returns a map keyed by contact id, holding only contacts that
 * actually have a neighbour, so a row with no entry needs no highlight and no thought.
 */
export function findNeighbours(
  rows: readonly { contactCrmId: number; lat: number | null; lon: number | null; name: string }[],
  radius: number = NEIGHBOUR_M,
): Map<number, NearbyContact[]> {
  const located = rows.filter((row) => row.lat != null && row.lon != null);
  const found = new Map<number, NearbyContact[]>();
  for (let i = 0; i < located.length; i += 1) {
    for (let j = i + 1; j < located.length; j += 1) {
      const left = located[i];
      const right = located[j];
      if (left.contactCrmId === right.contactCrmId) continue;
      const metres = metresBetween(left.lat as number, left.lon as number, right.lat as number, right.lon as number);
      if (metres > radius) continue;
      const rounded = Math.round(metres);
      if (!found.has(left.contactCrmId)) found.set(left.contactCrmId, []);
      if (!found.has(right.contactCrmId)) found.set(right.contactCrmId, []);
      found.get(left.contactCrmId)?.push({ contactCrmId: right.contactCrmId, metres: rounded, name: right.name });
      found.get(right.contactCrmId)?.push({ contactCrmId: left.contactCrmId, metres: rounded, name: left.name });
    }
  }
  for (const list of found.values()) list.sort((a, b) => a.metres - b.metres || a.name.localeCompare(b.name));
  return found;
}

/** One row of the company-wide contact roster, reduced to what identity matching needs. */
export type RosterEntry = {
  agentCrmId: number;
  contactCrmId: number;
  name: string;
  nameKey: string;
  phoneKey: string | null;
  /**
   * The CRM's own locality label, lowercased. NOT the brick.
   *
   * The board groups by brick, but a brick is only resolved for the rep being viewed — the
   * customer-level mapping is fetched in chunks of fifty for that rep's contacts alone. Reading it
   * company-wide to answer one question about one row would be roughly 190 more requests. This is
   * the same locality claim from the CRM, it rides on a row already being read, and it costs
   * nothing. Two records placed in one locality yet pinned kilometres apart contradict each other
   * whichever of the two names the place.
   */
  regionKey: string | null;
  /**
   * The CRM speciality, verbatim.
   *
   * A controlled vocabulary, not free text: thirty distinct values across 9,518 contacts, blank on
   * twenty-two of them. That is what makes a DISAGREEMENT meaningful — "Pediatrics" against
   * "Urology" for one name is two doctors, not one typo.
   */
  speciality: string | null;
};

/**
 * Which of this rep's contacts are, on the evidence, the same customer as another rep's.
 *
 * THIS IS AN IDENTITY JUDGEMENT, AND IT IS DELIBERATELY CONSERVATIVE. The CRM gives every rep their
 * own contact row with its own id even when two reps call on the same doctor — measured 2026-09-01,
 * not one of the 9,518 contacts is held by two reps by id, so an id join finds nothing and the
 * board would silently show no sharing at all. The owner knows these customers exist: a doctor
 * carried on two lines is the "treasure" his own standing rule protects from reassignment.
 *
 * So the match is made on the two signals that survived measurement, and no others:
 *
 *  - SAME NAME AND STANDING IN THE SAME PLACE. Name alone fails badly — 69% of same-name cross-rep
 *    pairs are over 5 km apart. Requiring both cuts 1,144 candidate pairs to the 214 that are real.
 *  - THE SAME PHONE, when that number is not a switchboard. See MAX_CONTACTS_PER_SHARED_PHONE.
 *
 * A name match where one side has no pin is NOT accepted. It cannot be checked, and an unchecked
 * name match is exactly the false positive this function exists to avoid.
 */
export function findSharedCustomers(
  rows: readonly { agentCrmId: number; contactCrmId: number }[],
  roster: readonly RosterEntry[],
  pins: ReadonlyMap<number, { lat: number; lon: number }>,
  repNames: ReadonlyMap<number, string>,
): Map<number, SharedWith[]> {
  const byName = new Map<string, RosterEntry[]>();
  const byPhone = new Map<string, RosterEntry[]>();
  const byId = new Map<number, RosterEntry>();
  for (const entry of roster) {
    byId.set(entry.contactCrmId, entry);
    if (entry.nameKey) {
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

  const shared = new Map<number, SharedWith[]>();
  for (const row of rows) {
    const mine = byId.get(row.contactCrmId);
    if (!mine) continue;
    const myPin = pins.get(row.contactCrmId) ?? null;
    // Keyed by the other REP, not the other contact: the owner asked who this customer is shared
    // with, and two of one rep's rows matching is a duplicate in that rep's own list, not sharing.
    const hits = new Map<number, SharedWith>();

    const consider = (other: RosterEntry, basis: SharedWith["basis"], metres: number | null) => {
      if (other.agentCrmId === row.agentCrmId) return;
      if (other.contactCrmId === row.contactCrmId) return;
      const repName = repNames.get(other.agentCrmId);
      // No name means no readable way to say who it is shared with, and the owner's standing rule is
      // that a screen never prints a raw id at the reader. Silence beats "shared with agent 4412".
      if (!repName) return;
      // EVIDENCE NEEDS A TIGHTER TEST THAN A LABEL DOES, and this is where the two part company.
      //
      // Saying "also on Sara's list" is an observation about two records. COUNTING her visits into
      // this pin's score asserts something much stronger — that her record and ours are the same
      // physical place. The name path has always required that (a name alone is not an identity),
      // but the phone path never did, and measured 2026-09-01 it badly needs it: of 72 cross-rep
      // pairs sharing a phone, 42 are over 200 m apart and 26 are over 5 KM apart — a clinic
      // switchboard, a secretary's mobile, or a doctor working in two cities. Folding those visits
      // in would not merely be untidy: they land far from the pin, so they count as disagreement
      // and DRAG THE SCORE DOWN, then explain themselves with a "practises in two places" line
      // about a customer who does not exist. So the label keeps the looser rule and the score gets
      // the strict one.
      const samePlace = metres != null && metres <= SAME_CUSTOMER_M;
      const existing = hits.get(other.agentCrmId);
      if (existing) {
        // One rep can hold the same customer on more than one row of their own, and both rows are a
        // record of the same doctor — so every matched id is kept as evidence even though only one
        // of them decides the wording.
        if (samePlace && !existing.contactCrmIds.includes(other.contactCrmId)) {
          existing.contactCrmIds.push(other.contactCrmId);
        }
        // Phone is the stronger signal, so it wins the label when both fire on the same rep.
        if (!(basis === "shared phone" && existing.basis === "name and location")) return;
        hits.set(other.agentCrmId, { ...existing, basis, metres });
        return;
      }
      hits.set(other.agentCrmId, {
        agentCrmId: other.agentCrmId,
        basis,
        contactCrmIds: samePlace ? [other.contactCrmId] : [],
        metres,
        repName,
      });
    };

    if (mine.phoneKey) {
      const group = byPhone.get(mine.phoneKey) ?? [];
      const distinctContacts = new Set(group.map((entry) => entry.contactCrmId)).size;
      if (distinctContacts <= MAX_CONTACTS_PER_SHARED_PHONE) {
        for (const other of group) {
          const otherPin = pins.get(other.contactCrmId);
          const metres = myPin && otherPin ? Math.round(metresBetween(myPin.lat, myPin.lon, otherPin.lat, otherPin.lon)) : null;
          consider(other, "shared phone", metres);
        }
      }
    }

    if (myPin && mine.nameKey) {
      for (const other of byName.get(mine.nameKey) ?? []) {
        const otherPin = pins.get(other.contactCrmId);
        if (!otherPin) continue;
        const metres = metresBetween(myPin.lat, myPin.lon, otherPin.lat, otherPin.lon);
        if (metres > SAME_CUSTOMER_M) continue;
        consider(other, "name and location", Math.round(metres));
      }
    }

    if (hits.size > 0) {
      shared.set(
        row.contactCrmId,
        [...hits.values()].sort((left, right) => left.repName.localeCompare(right.repName)),
      );
    }
  }
  return shared;
}

/** The small line under a highlighted row: who this customer is shared with, and how it was judged. */
export function describeSharing(shared: readonly SharedWith[]): string {
  if (shared.length === 0) return "";
  const names = shared.map((entry) => entry.repName);
  const who =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const basis = shared.every((entry) => entry.basis === "shared phone")
    ? "same phone number"
    : shared.every((entry) => entry.basis === "name and location")
      ? "same name, same place"
      : "same name and phone";
  return `Also on ${who}'s list — matched by ${basis}`;
}

/**
 * One group's rows, gathered into neighbourhoods.
 *
 * `clusterOf` maps a contact to the number of the neighbourhood it stands in, counted from 0 in the
 * order the rows are returned. A contact standing alone is ABSENT from the map rather than carrying
 * a number of its own — see clusterRows for why that distinction is the whole design.
 */
export type ClusteredRows<T> = { clusterOf: Map<number, number>; rows: T[] };

/**
 * Reorder one group so contacts standing at the same address sit together, and number each
 * neighbourhood so the page can give it its own colour.
 *
 * The owner asked for this on 2026-09-01, right after the highlight itself: "every customer that is
 * very near to each other and having the same colour, make them under each other." A tint scattered
 * down an alphabetical list tells a reader that clusters EXIST; it does not let them read one. Put
 * the members on consecutive rows and the cluster becomes a block that can be worked in one stop,
 * which is the whole use of knowing.
 *
 * ALPHABETICAL ORDER IS KEPT WHEREVER IT SURVIVES, rather than thrown away for a size ranking. Each
 * cluster is placed at the position of its alphabetically-first member, and members are alphabetical
 * inside it. So a reader scanning for a name still finds it roughly where they expect, and the only
 * rows that move are the ones being deliberately gathered.
 *
 * Clusters are CONNECTED COMPONENTS, not "everyone within N metres of me": if A is near B and B is
 * near C, all three are one block even when A and C are further apart than the radius. Anything else
 * would put B in two places at once.
 */
export function clusterRows<T extends { contactCrmId: number; name: string }>(
  rows: readonly T[],
  neighbours: ReadonlyMap<number, NearbyContact[]>,
): ClusteredRows<T> {
  const byId = new Map(rows.map((row) => [row.contactCrmId, row]));
  const seen = new Set<number>();
  const clusters: T[][] = [];

  for (const row of rows) {
    if (seen.has(row.contactCrmId)) continue;
    // Breadth-first from this row: everything reachable through the neighbour map is one cluster.
    const members: T[] = [];
    const queue = [row.contactCrmId];
    seen.add(row.contactCrmId);
    while (queue.length > 0) {
      const id = queue.shift() as number;
      const member = byId.get(id);
      if (!member) continue;
      members.push(member);
      for (const near of neighbours.get(id) ?? []) {
        if (seen.has(near.contactCrmId)) continue;
        // A neighbour outside this group cannot be pulled in — the caller scopes the map to one
        // brick, and reaching past it would gather rows the page has filed under another heading.
        if (!byId.has(near.contactCrmId)) continue;
        seen.add(near.contactCrmId);
        queue.push(near.contactCrmId);
      }
    }
    members.sort((left, right) => left.name.localeCompare(right.name));
    clusters.push(members);
  }

  clusters.sort((left, right) => left[0].name.localeCompare(right[0].name));

  // Number the neighbourhoods in READING ORDER, so the first tint a reader meets going down the
  // column is the palette's first colour and the next block is the next one. Numbering by anything
  // else (size, id, the order BFS happened to find them) would scatter the palette and cost the
  // owner exactly the legibility he asked the colours for.
  //
  // A ONE-MEMBER CLUSTER IS NOT A NEIGHBOURHOOD and is deliberately left out of the map: nobody
  // stands near it, so a tint would be a colour with nothing to compare against — noise, which is
  // the one thing he asked us not to make. Skipping it also keeps the palette from being spent on
  // rows that are not blocks, so a brick's real neighbourhoods stay far apart in colour.
  const clusterOf = new Map<number, number>();
  let index = 0;
  for (const members of clusters) {
    if (members.length < 2) continue;
    for (const member of members) clusterOf.set(member.contactCrmId, index);
    index += 1;
  }

  return { clusterOf, rows: clusters.flat() };
}
