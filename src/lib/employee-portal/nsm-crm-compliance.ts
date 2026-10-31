import { getLatestSuccessfulSyncRunFor } from "@/lib/crm/admin";
import { extractCampaignAccounts } from "@/lib/crm/campaign-account";
import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
import { getCrmCutoverSetting, isOnOrAfterCrmCutover, vendorSyncStandDownReason } from "@/lib/crm/cutover";
import { cairoTodayIso } from "@/lib/crm/dates";
import { loadStartedRepWindows } from "@/lib/crm/phoenix-started-reps";
import { startedWindowCovers, type StartedRepWindow } from "@/lib/crm/phoenix-team-starts";
import {
  CRM_DOUBLE_VISIT_TYPE_CODES,
  queryCheckins,
  queryVisits,
  resolveVisitTime,
  type VisitTimeSource,
} from "@/lib/crm/reads";
import { resolveVisitTypeLabel } from "@/lib/crm/visit-types";

// NSM "first CRM visit" compliance for the recurring iReports360 sync (3x/day plus a live
// 8:30 AM-12:01 PM morning window — see the ireports360-visits-* cron routes): who on the NSM's
// line has / hasn't submitted a real field visit today, plus the earliest submitters
// ("early birds"). Read-only; the caller supplies the line-scoped rosters (already
// permission-scoped), so this never widens access.

export type CrmPerson = { hrId: string; name: string };

/** How many earliest submitters the board ranks. Exported so the UI can state the cap out loud
 * rather than silently showing a truncated list (a bare N chips cannot be told apart from
 * "only N people submitted"). */
export const EARLY_BIRD_LIMIT = 10;

export type CrmEarlyBird = {
  hrId: string;
  name: string;
  role: "Med Rep" | "DSM";
  /** ISO instant of this person's earliest visit today, or null when the winning row carries no
   * real clock (the vendor writes a midnight placeholder on ~3% of `crm_save_date` values). Such a
   * person still ranks — they DID submit — they just rank last and show no time, instead of being
   * dropped from the board entirely while their teammates with a clock are shown. */
  at: string | null;
  /** GPS check-in time vs. self-reported save time — see resolveVisitTime (crm/reads.ts). Shown
   * on the chip, because a save time is rep-controlled and is not comparable to a GPS arrival. */
  source: VisitTimeSource;
  /** Compact label of the visit that produced `at` ("Regular", "Campaign"). */
  visitType: string;
  /** The account that first captured visit was logged at, or null when none could be established. */
  account: string | null;
  /** The winning visit's own free-text note. Carried because Campaign visits have no account
   * column at all and the note is the only place one can come from — {@link getNsmCrmCompliance}
   * reads it there after the pure build. Never rendered. */
  comment: string | null;
};

export type NsmCrmComplianceData = {
  /** Africa/Cairo calendar day the check is computed for (YYYY-MM-DD). */
  date: string;
  /** Most recent CRM sync timestamp among today's mirrored ROWS (ISO), or null. This is "when data
   * last moved", not "when we last looked" — it does not advance on a sync that found nothing. */
  lastSyncAt: string | null;
  /** When this day was last CHECKED: completed_at of the newest successful sync run covering it.
   * This is what the UI shows, because it moves even when a sync finds no new visits — otherwise a
   * perfectly successful Sync press leaves the label frozen and reads as a broken button. */
  lastSyncRunAt: string | null;
  /** True once a sync run has covered this day at all. Distinguishes "nobody has looked yet" from
   * "we looked and nobody on your roster has submitted", which `synced: false` alone conflates. */
  polled: boolean;
  /** True once at least one visit for `date` has been mirrored (i.e. the sync has landed). */
  synced: boolean;
  /** `missing` is ONLY people with no real field visit mirrored today. Anyone who submitted
   * leaves this list whether or not they made the early-bird cut — the two lists answer
   * different questions ("who is first" vs "who has not started"). */
  reps: { total: number; submitted: number; missing: CrmPerson[] };
  dsms: { total: number; submitted: number; missing: CrmPerson[] };
  /** Earliest submitters across the roster, soonest first, capped at the caller's `limit`
   * ({@link EARLY_BIRD_LIMIT} for the line/region board, uncapped for a District Manager's own
   * team). Everyone who submitted is a candidate; those with no resolvable clock rank last. */
  earlyBirds: CrmEarlyBird[];
  /** True only when the underlying fetch itself failed (see nsmCrmComplianceUnavailable) — lets
   * the UI tell a real outage apart from the ordinary "nothing mirrored yet today" state, which
   * looks identical otherwise (synced: false in both). Absent/false in the normal paths below. */
  error?: boolean;
};

/** Exported so the Early Birds fortnightly scorer replays this exact board day by day, off one
 * shared row shape rather than a structurally-duplicated copy that could drift from it. */
export type NsmCrmVisitRow = {
  agent_hr_id: string | null;
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  double_hr_id: string | null;
  /** The chain visit's SECOND manager. Slot 1 is `coalesce(manager, product_manager, senior)`, so a
   * row that carries somebody here carries somebody there too — the two never hold one person. */
  double2_hr_id: string | null;
  crm_save_date: string | null;
  synced_at: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  contact_name: string | null;
  customer_name: string | null;
  comment: string | null;
};

type VisitRow = NsmCrmVisitRow;

export type NsmCrmCheckinRow = {
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  check_date: string | null;
};

type CheckinRow = NsmCrmCheckinRow;

// Collapse HR IDs to a hyphen-insensitive, case-insensitive key so canonical
// ("B100") and stored ("B-100") forms always match (guards the hr-id hyphen trap).
const matchKey = (value?: string | null): string => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// iReports360 counts Regular (0) and Campaign (-8) as real field visits; -4 is vacation and other
// negatives are administrative — never a submitted visit. This reuses the canonical fieldwork code
// list rather than restating it: the local predicate used to read `visitType >= 0 || -8`, which
// accepts any positive code and so could silently diverge from every other CRM surface the day the
// vendor adds one (production carries no positive code today — verified 2026-08-08).
const REAL_VISIT_TYPES = new Set<number>(CRM_DOUBLE_VISIT_TYPE_CODES);
const isRealVisit = (visitType: number | null | undefined): boolean =>
  visitType != null && REAL_VISIT_TYPES.has(visitType);

// Compact labels so a chip stays one short line (owner rule: never wrap, never ellipsize). The
// vendor's own description is the fallback; production carries exactly "Regular Visit" (0) and
// "Campaign (Prospection)" (-8), both too long to sit inside a chip beside a name and a clock.
const VISIT_TYPE_LABELS = new Map<number, string>([
  [0, "Regular"],
  [-8, "Campaign"],
]);

// VISIT_TYPE_LABELS above is deliberately compact for this board ("Regular", not the vendor's
// longer "Regular Visit") and is pinned by tests/nsm-crm-compliance.test.ts — it stays.
// What changed is the fallback: it used to print the vendor description verbatim, which is the
// literal string "Unknown" for the seven codes iReports360 never documented. Those now go
// through the CRM domain resolver, so this board names a code the same way the rest of Phoenix
// does instead of showing a rep "Unknown" for their own public holiday.
function visitTypeLabel(
  visitType: number | null | undefined,
  description: string | null | undefined,
  comment: string | null | undefined,
): string {
  const known = visitType == null ? undefined : VISIT_TYPE_LABELS.get(visitType);
  if (known) return known;
  if (visitType == null && !(description ?? "").trim()) return "Visit";
  return resolveVisitTypeLabel(visitType, description, comment);
}

/**
 * The account a visit was captured at.
 *
 * Measured live against production 2026-08-08: `contact_name` carries the account on Regular
 * visits (79,744 of 79,798 rows). Campaign/Prospection visits carry NO account at all — 0 of
 * 30,367 rows have either column populated — so they legitimately resolve to null and the board
 * shows a dash. That is the vendor feed, not a bug here; do not "fix" it by falling back to the
 * customer/agent name, which would invent an account the rep never logged.
 *
 * `customer_name` exists in the mirror but is an empty string on every row today (beware: a bare
 * `count(customer_name)` counts those empties and reads as 30k populated rows). It stays in the
 * waterfall as a defensive fallback for the day the vendor starts filling it, not because it
 * currently holds anything.
 */
function accountName(row: { contact_name: string | null; customer_name: string | null }): string | null {
  const contact = row.contact_name?.trim();
  if (contact) return contact;
  const customer = row.customer_name?.trim();
  return customer && customer.length > 0 ? customer : null;
}

async function fetchVisitsForDate(date: string): Promise<VisitRow[]> {
  // One day of company-wide visits via the CRM read layer — a full-coverage keyset scan, so a
  // busy day never silently drops rows and mislabels reps as non-submitters.
  return queryVisits<VisitRow>({
    dateFrom: date,
    dateTo: date,
    columns:
      "agent_hr_id, agent_crm_id, contact_crm_id, double_hr_id, double2_hr_id, crm_save_date, " +
      "synced_at, visit_type, visit_type_description, contact_name, customer_name, comment",
  });
}

async function fetchCheckinsForDate(date: string): Promise<CheckinRow[]> {
  // Same single-day scope as fetchVisitsForDate, so GPS correlation below never reaches outside
  // the day being checked. Cheap: one day, not the Visits Report's multi-week window.
  return queryCheckins<CheckinRow>({
    dateFrom: date,
    dateTo: date,
    // agent_hr_id: a rep with no CRM id matches his check-ins on it (see checkin-match.ts).
    columns: "agent_crm_id, agent_hr_id, contact_crm_id, check_date",
    // The first-visit board sits on the District, Regional and National Sales Managers' home pages only —
    // no rep reaches it, so a started Phoenix CRM team's visits count as its check-ins here (owner,
    // 2026-10-02; src/lib/crm/phoenix-team-starts.ts lists every reader that asks).
    includePhoenixVisits: true,
  });
}

/** Built by the caller's catch handler when getNsmCrmCompliance itself throws (a real fetch
 * failure), so the UI can distinguish that from the ordinary "not synced yet" state instead of
 * both collapsing to the same silent-looking empty board. */
export function nsmCrmComplianceUnavailable(input: { reps: CrmPerson[]; dsms: CrmPerson[]; date?: string }): NsmCrmComplianceData {
  return {
    date: input.date ?? cairoTodayIso(),
    lastSyncAt: null,
    lastSyncRunAt: null,
    polled: false,
    synced: false,
    error: true,
    reps: { total: input.reps.length, submitted: 0, missing: [...input.reps] },
    dsms: { total: input.dsms.length, submitted: 0, missing: [...input.dsms] },
    earlyBirds: [],
  };
}

/**
 * Whether EVERY person on this roster is counted from Phoenix CRM on `date` (owner, 2026-10-31: "any
 * data anywhere depending on data from ireports must shift to pulling its data from phoenix crm").
 * Such a roster records its visits in Phoenix itself, so the board has nothing to wait for from the
 * iReports360 pull and the day counts as checked now. A MIXED roster keeps the vendor ledger: one rep
 * still on iReports360 is still waiting for it. An empty roster is never "counted from Phoenix".
 */
export function rosterCountedFromPhoenix(
  windows: readonly StartedRepWindow[],
  people: readonly CrmPerson[],
  date: string,
): boolean {
  return people.length > 0 && people.every((person) => startedWindowCovers(windows, { hrId: person.hrId, crmId: null }, date));
}

export async function getNsmCrmCompliance(input: {
  reps: CrmPerson[];
  dsms: CrmPerson[];
  date?: string;
  /** How many early birds to keep. Defaults to {@link EARLY_BIRD_LIMIT} for the line/region board;
   * the District Manager board passes Infinity so that on a team of a dozen reps nobody who
   * submitted ever drops off the ranking. */
  limit?: number;
}): Promise<NsmCrmComplianceData> {
  const date = input.date ?? cairoTodayIso();
  // The run ledger rides along in the same Promise.all, so "when did we last check" costs a round
  // trip rather than a wait. It must never fail the board: a missing ledger is a missing label.
  const [visits, checkins, lastSyncRunAt] = await Promise.all([
    fetchVisitsForDate(date),
    fetchCheckinsForDate(date),
    // THE CRM CUTOVER. On or after the cutover day, or once the vendor sync is stood down, Phoenix
    // records visits itself and the reads above are live — there is no pull to wait for, so the day
    // counts as checked NOW. Reading the vendor ledger instead left `polled` false all day, and the
    // board said "Awaiting today's first CRM sync" in place of "nobody on your roster has submitted".
    // An unreadable setting falls back to the ledger, exactly as before.
    getCrmCutoverSetting()
      .then((setting) =>
        vendorSyncStandDownReason(setting) || isOnOrAfterCrmCutover(setting, date) ? new Date().toISOString() : null,
      )
      .catch(() => null)
      // A roster wholly on started Phoenix CRM teams is checked NOW too — the global cutover is never
      // set by a per-team start, so without this a started team waited all day on the vendor's pull.
      .then(async (phoenixCheckedAt) =>
        phoenixCheckedAt ??
        (rosterCountedFromPhoenix(await loadStartedRepWindows(), [...input.reps, ...input.dsms], date)
          ? new Date().toISOString()
          : null),
      )
      .catch(() => null)
      .then((phoenixCheckedAt) => phoenixCheckedAt ?? getLatestSuccessfulSyncRunFor(date).catch(() => null)),
  ]);
  const data = buildNsmCrmCompliance({
    date,
    reps: input.reps,
    dsms: input.dsms,
    visits,
    checkins,
    limit: input.limit,
    lastSyncRunAt,
  });
  return withCommentDerivedAccounts(data);
}

/**
 * Fill in the account for ranked visits that arrived without one. Campaign/Prospection rows are
 * the reason this exists — iReports360 sends no account column for them at all, only the rep's own
 * free-text note, which often names the customer they saw.
 *
 * Runs HERE and not inside {@link buildNsmCrmCompliance} on purpose: the builder is pure and
 * synchronous so the ranking rule stays testable against fixed rows, and this step is neither. It
 * only ever upgrades a null account to a real one, so the board is identical-or-better when the
 * resolver is unavailable — {@link extractCampaignAccounts} swallows its own failures and returns
 * an empty map rather than throwing into a dashboard render.
 */
async function withCommentDerivedAccounts(data: NsmCrmComplianceData): Promise<NsmCrmComplianceData> {
  const unresolved = data.earlyBirds.filter((bird) => bird.account === null && bird.comment);
  if (unresolved.length === 0) return data;

  const accounts = await extractCampaignAccounts(unresolved.map((bird) => bird.comment as string));
  if (accounts.size === 0) return data;

  return {
    ...data,
    earlyBirds: data.earlyBirds.map((bird) =>
      bird.account === null && bird.comment ? { ...bird, account: accounts.get(bird.comment) ?? null } : bird,
    ),
  };
}

/**
 * The whole compliance + early-bird rule, as a pure function of the day's rows and the rosters —
 * {@link getNsmCrmCompliance} is only the fetch around it. Split out so the ranking can be tested
 * against fixed rows without standing up Supabase; before this split the rule had no test at all,
 * which is how the GPS-correlation and canonical-visit-time defects (#1192, #1207) both reached
 * production.
 */
export function buildNsmCrmCompliance(input: {
  date: string;
  reps: CrmPerson[];
  dsms: CrmPerson[];
  visits: VisitRow[];
  checkins: CheckinRow[];
  limit?: number;
  /** completed_at of the newest successful sync run covering `date`, when the caller has read it. */
  lastSyncRunAt?: string | null;
}): NsmCrmComplianceData {
  const { date, visits: rows, checkins } = input;
  const limit = input.limit ?? EARLY_BIRD_LIMIT;
  const lastSyncRunAt = input.lastSyncRunAt ?? null;
  const notSynced: NsmCrmComplianceData = {
    date,
    lastSyncAt: null,
    lastSyncRunAt,
    polled: lastSyncRunAt !== null,
    synced: false,
    reps: { total: input.reps.length, submitted: 0, missing: [...input.reps] },
    dsms: { total: input.dsms.length, submitted: 0, missing: [...input.dsms] },
    earlyBirds: [],
  };

  if (rows.length === 0) return notSynced;

  // Same GPS-first waterfall as the CRM master table / Visits Report (resolveVisitTime,
  // crm/reads.ts): GPS check-in time -> save time -> none. Ranking purely by crm_save_date (the
  // rep's own submission/paperwork time) previously let a rep who merely logged fast outrank one
  // who genuinely arrived earlier but saved later — the exact distortion #1192 fixed for the
  // Master table and Visits Report but had left this board still doing.
  const checkinIndex = indexCheckinsByAgentContactDay(checkins);

  type Best = {
    when: number;
    source: VisitTimeSource;
    visitType: string;
    account: string | null;
    comment: string | null;
  };
  const agentEarliest = new Map<string, Best>(); // match key -> earliest resolved visit (as visiting agent)
  const doubleEarliest = new Map<string, Best>(); // match key -> earliest resolved visit (as double-visit partner)
  let lastSync = 0;

  for (const row of rows) {
    if (row.synced_at) {
      const synced = Date.parse(row.synced_at);
      if (Number.isFinite(synced) && synced > lastSync) lastSync = synced;
    }
    if (!isRealVisit(row.visit_type)) continue;

    // Never anchored on visit_date_time (a fixed midnight placeholder) or synced_at (the sync
    // clock, not the rep's own visit) — see resolveVisitTime's own contract. A row that resolves to
    // no real time sorts last (MAX_SAFE_INTEGER) but still ranks: the person submitted, so the
    // board owes them a chip. It used to drop them silently, which read as "never submitted".
    const match = pickCheckinForVisit(
      {
        agentCrmId: row.agent_crm_id,
        agentHrId: row.agent_hr_id,
        contactCrmId: row.contact_crm_id,
        visitDay: date,
        crmSaveDate: row.crm_save_date,
      },
      checkinIndex,
    );
    const resolved = resolveVisitTime({ nearestCheckinTime: match?.check_date ?? null, crmSaveDate: row.crm_save_date });
    const parsed = resolved.time ? Date.parse(resolved.time) : NaN;
    const when = Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    const best: Best = {
      when,
      source: resolved.source,
      visitType: visitTypeLabel(row.visit_type, row.visit_type_description, row.comment),
      account: accountName(row),
      comment: row.comment?.trim() || null,
    };

    const agent = matchKey(row.agent_hr_id);
    if (agent) {
      const cur = agentEarliest.get(agent);
      if (cur === undefined || when < cur.when) agentEarliest.set(agent, best);
    }
    // Both partner slots earn the ride, and crediting both cannot double-count: slot 1 is
    // `coalesce(manager, product_manager, senior)`, so a chain visit's two slots hold two people.
    for (const partner of [row.double_hr_id, row.double2_hr_id]) {
      const dbl = matchKey(partner);
      if (!dbl) continue;
      const cur = doubleEarliest.get(dbl);
      if (cur === undefined || when < cur.when) doubleEarliest.set(dbl, best);
    }
  }

  // `when` is kept alongside each candidate purely to sort, so a null `at` (no real clock) does
  // not have to be re-parsed back out of the ISO string it never had.
  type Ranked = CrmEarlyBird & { when: number };
  const ranked: Ranked[] = [];
  const toRanked = (person: CrmPerson, best: Best, role: CrmEarlyBird["role"]): Ranked => ({
    at: best.when === Number.MAX_SAFE_INTEGER ? null : new Date(best.when).toISOString(),
    hrId: person.hrId,
    name: person.name,
    role,
    source: best.source,
    visitType: best.visitType,
    account: best.account,
    comment: best.comment,
    when: best.when,
  });

  const repMissing: CrmPerson[] = [];
  let repSubmitted = 0;
  for (const person of input.reps) {
    const best = agentEarliest.get(matchKey(person.hrId));
    if (best !== undefined) {
      repSubmitted += 1;
      ranked.push(toRanked(person, best, "Med Rep"));
    } else {
      repMissing.push(person);
    }
  }

  const dsmMissing: CrmPerson[] = [];
  let dsmSubmitted = 0;
  for (const person of input.dsms) {
    const key = matchKey(person.hrId);
    // A DSM "submits" either by a solo visit (agent) or by accompanying a rep (double).
    const asAgent = agentEarliest.get(key);
    const asDouble = doubleEarliest.get(key);
    const best =
      asAgent === undefined ? asDouble : asDouble === undefined ? asAgent : asAgent.when <= asDouble.when ? asAgent : asDouble;
    if (best !== undefined) {
      dsmSubmitted += 1;
      ranked.push(toRanked(person, best, "DSM"));
    } else {
      dsmMissing.push(person);
    }
  }

  // Name then HR ID break a tie explicitly. Sorting on the clock alone left equal timestamps in
  // roster order — which is achievement-sorted, so two people who submitted in the same second
  // were ranked by their sales figures, and the same pair could swap places between two renders.
  ranked.sort((a, b) => a.when - b.when || a.name.localeCompare(b.name) || a.hrId.localeCompare(b.hrId));

  return {
    date,
    lastSyncAt: lastSync ? new Date(lastSync).toISOString() : null,
    lastSyncRunAt,
    polled: lastSyncRunAt !== null,
    synced: true,
    reps: { total: input.reps.length, submitted: repSubmitted, missing: repMissing },
    dsms: { total: input.dsms.length, submitted: dsmSubmitted, missing: dsmMissing },
    earlyBirds: ranked.slice(0, limit).map(({ when: _when, ...bird }) => bird),
  };
}
