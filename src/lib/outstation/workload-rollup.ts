/**
 * Whose field work counts as a MANAGER's workload on a trip day.
 *
 * A manager in the field does not log his own visits — he rides along, and the visit is recorded
 * against the person he is with. So "did this manager work?" cannot be answered from his own
 * rows alone.
 *
 * Owner's rule (2026-08-04), in his words:
 *   - District Manager: "you will find his visits in double visits with medical reps in his team"
 *   - National Sales Manager: "you will find his visits with the district manager, and you will
 *     find the district manager visits with the medical rep of his team, so you will map the
 *     medical rep of his team to the national sales manager"
 *
 * And his scoping decision, same date: count only the reps who were present ON HIS DM DAYS —
 * the NSM's own double-visits with a DM, plus the rep visits under that same DM on that same
 * day. NOT every rep under that DM across the whole trip window. The distinction matters: the
 * wider reading credits an NSM with work done by people he was nowhere near.
 *
 * That makes this a bounded walk outward from the manager, per day:
 *
 *   DM   → 0 hops. His ride-alongs with reps are ALREADY counted as his own, because
 *          getRepTripVisitWorkload counts a visit where the person is the double-visit PARTNER,
 *          not only where they are the agent. Adding a hop here would double-count them.
 *   NSM  → 1 hop. Out to the DMs he was with, then to the reps those DMs were with that day.
 *
 * Pure. The counting rule that decides an expense is asserted without a CRM.
 */

/**
 * One person's AM · PM · Pharmacies count on one date. THE AM · PM · PHARMACIES GOLDEN RULE (owner,
 * 2026-09-21): a pharmacy visit is in `pharmacies` only, never inside `am` or `pm` — the split comes
 * from visitCountBucket (src/lib/crm/visit-count-buckets.ts), never from the period alone.
 */
export type WorkloadDayCount = { am: number; date: string; pharmacies: number; pm: number };

/** Per person (HR ID) → per date → who they were recorded out with that date. */
export type PartnersByPersonDate = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

/** Per person (HR ID) → their own per-date counts. */
export type WorkloadByPerson = Readonly<Record<string, readonly WorkloadDayCount[]>>;

export type RolledUpWorkloadDay = {
  am: number;
  /** Everyone whose visits were counted into this day, root first. For the audit trail. */
  countedHrIds: string[];
  date: string;
  /** The employee recorded a meeting that day (set by the capture, never by the rollup). */
  meeting?: boolean;
  pharmacies: number;
  pm: number;
};

export type RolledUpWorkload = {
  amWorkload: number;
  days: RolledUpWorkloadDay[];
  pharmacyWorkload: number;
  pmWorkload: number;
};

/**
 * The verdict a captured trip workload is stamped with. Owner decision (2026-09-21): pharmacy
 * visits are the third figure AND field work, so a trip whose only visits were pharmacies is
 * "matched" — never "no activity", which is what an approver reads as "he did nothing".
 */
export function capturedWorkloadMatchStatus(workload: {
  amWorkload: number;
  /** The employee's own recorded meetings (trip-day-meetings.ts). Absent = none. */
  meetingDates?: readonly string[];
  pharmacyWorkload: number;
  pmWorkload: number;
}): "matched" | "no_activity" {
  // A recorded meeting is the day's work, not a visit (owner, 2026-11-07): it never adds to the three
  // figures, but a trip whose only entry was a meeting is never stamped "no activity".
  if ((workload.meetingDates?.length ?? 0) > 0) return "matched";
  return workload.amWorkload + workload.pmWorkload + workload.pharmacyWorkload > 0 ? "matched" : "no_activity";
}

/**
 * How far out to walk from a given seat. Anything not listed counts only its own visits, which
 * is the correct default: a Medical Rep logs his own work, so a hop would credit him with his
 * colleagues'.
 *
 * Regional Manager sits between NSM and DM in this org, and is given the same 1 hop as an NSM
 * for the same reason — he rides with DMs, who ride with reps.
 */
const HOPS_BY_ROLE: Readonly<Record<string, number>> = {
  "district manager": 0,
  "acting district manager": 0,
  "national sales manager": 1,
  "regional manager": 1,
};

export function rollupHopsForRole(role: string | null | undefined): number {
  return HOPS_BY_ROLE[String(role ?? "").trim().toLowerCase()] ?? 0;
}

function key(hrId: string | null | undefined): string {
  return String(hrId ?? "").trim().toUpperCase();
}

/** Index a person's day list for O(1) lookup by date. */
function byDate(days: readonly WorkloadDayCount[] | undefined): Map<string, WorkloadDayCount> {
  const index = new Map<string, WorkloadDayCount>();
  for (const day of days ?? []) index.set(day.date, day);
  return index;
}

/**
 * Roll a manager's trip workload up from the people he was actually out with.
 *
 * Each person is counted AT MOST ONCE per day, however many paths reach them — an NSM out with
 * two DMs who were both with the same rep must not count that rep twice. That dedupe is per DAY,
 * not per trip: the same rep on two different days is two days of real work.
 */
export function rollUpManagerTripWorkload(input: {
  dates: readonly string[];
  hops: number;
  partnersByPersonDate: PartnersByPersonDate;
  rootHrId: string;
  workloadByPerson: WorkloadByPerson;
}): RolledUpWorkload {
  const root = key(input.rootHrId);
  const hops = Math.max(0, Math.trunc(input.hops));

  const workloadIndex = new Map<string, Map<string, WorkloadDayCount>>();
  for (const [hrId, days] of Object.entries(input.workloadByPerson)) {
    workloadIndex.set(key(hrId), byDate(days));
  }

  const partnersIndex = new Map<string, Readonly<Record<string, readonly string[]>>>();
  for (const [hrId, perDate] of Object.entries(input.partnersByPersonDate)) {
    partnersIndex.set(key(hrId), perDate);
  }

  const days: RolledUpWorkloadDay[] = [];

  for (const date of input.dates) {
    // Breadth-first from the root, one ring per hop. `counted` is what stops a person being
    // added twice AND stops a cycle (A partnered with B, B partnered with A) from looping.
    const counted = new Set<string>([root]);
    let ring: string[] = [root];

    for (let hop = 0; hop < hops; hop += 1) {
      const nextRing: string[] = [];
      for (const person of ring) {
        const partners = partnersIndex.get(person)?.[date] ?? [];
        for (const partner of partners) {
          const partnerKey = key(partner);
          if (!partnerKey || counted.has(partnerKey)) continue;
          counted.add(partnerKey);
          nextRing.push(partnerKey);
        }
      }
      if (nextRing.length === 0) break;
      ring = nextRing;
    }

    let am = 0;
    let pharmacies = 0;
    let pm = 0;
    for (const person of counted) {
      const day = workloadIndex.get(person)?.get(date);
      if (!day) continue;
      am += Math.max(0, day.am);
      pharmacies += Math.max(0, day.pharmacies);
      pm += Math.max(0, day.pm);
    }

    days.push({
      am,
      // Root first, then the rest in stable alphabetical order — a Set's insertion order would
      // make the audit trail depend on traversal order, which is not a fact about the trip.
      countedHrIds: [root, ...Array.from(counted).filter((id) => id !== root).sort()],
      date,
      pharmacies,
      pm,
    });
  }

  return {
    amWorkload: days.reduce((sum, day) => sum + day.am, 0),
    days,
    pharmacyWorkload: days.reduce((sum, day) => sum + day.pharmacies, 0),
    pmWorkload: days.reduce((sum, day) => sum + day.pm, 0),
  };
}
