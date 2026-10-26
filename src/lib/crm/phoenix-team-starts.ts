/**
 * PHOENIX CRM, COUNTED EVERYWHERE — FROM THE TEAM'S START (owner's rulings, 2026-10-02).
 *
 * "Once a TEAM works in Phoenix CRM, the other screens count its Phoenix visits instead of iReports360
 * from the team's start. Its iReports360 visits after that date are ignored, so nothing is counted
 * twice. Before the start date, iReports360 stays the source." And, after the risk review the same
 * afternoon — "Only when I start it": Delta (1) starts on Saturday 3 October as he ruled; every other
 * team starts only when he presses Start on it, from the Saturday he picks.
 *
 * This is the design note for those rulings. The work is a change at the source — two migrations,
 * `supabase/migrations/20261002123958_phoenix_crm_visits_everywhere.sql` (the starts, the visits door)
 * and `20261002142118_phoenix_crm_plans_everywhere.sql` (the plan door), the views every visit and plan
 * reader in `src/lib/crm/` reads — plus the read-side rules that had to learn what a Phoenix row is (the
 * call rate and Early Birds, below). No screen's own arithmetic was edited to get its numbers.
 *
 * ## Who starts a team, and when
 *
 * `public.phoenix_crm_team_starts`, one row per START of a TEAM. A team is the territories (REP seats)
 * under one district-manager seat — the team `territoryReviewer` / `territoriesOfStartedTeams` mean — and
 * a start is KEYED BY THAT SEAT (`au.seats.parent_seat_id` of the territory), never by the person on it:
 * a new district manager, or a vacant seat, keeps the team and its dates. Every REP seat hangs directly
 * from a DM or ACTING_DM seat (measured 2026-10-02: 108 + 3), so the parent seat IS the team.
 *
 *   - Delta (1)'s three teams (Dina Hamdy · Anti Infective, Mahmoud ElHassanin · CNS, Nermeen Salah ·
 *     Pedia) are SEEDED from the owner's ruling with Saturday 3 October 2026 — never the week of 26
 *     September, never anything that drops their iReports360 visits of 30 September.
 *   - Every other team starts ONLY when the Super Admin presses Start on the CRM hub (`/admin/crm`,
 *     "Teams counted from Phoenix CRM"), from the Saturday he picks. NOTHING ELSE starts a team: every
 *     line has been open in the module since 18 September, so a stray draft plan or one visit by anyone
 *     must never drop a whole team's iReports360 visits — those days would read idle, and the CRM
 *     no-activity candidates publish unless someone clears them.
 *   - THE MONTH FLOOR: no start and no stop reaches back before the first day of the current Cairo
 *     month, so a published or collected month is never restated.
 *   - STOP ends a running start from a Saturday (under the same floor), or takes back a start not reached
 *     yet. A stop sticks: nothing but the Super Admin starts a team again, and a new start begins on or
 *     after the last stop, so a day is never in two starts.
 *   - The first time a REAL weekly plan is SENT on a territory whose team has no start, the Super Admin
 *     is told once per team — in-app, Telegram and the phone, never email — naming the team, the rep and
 *     the week (`phoenix-team-start-notice.ts`).
 *
 * The one writer is `public.phoenix_crm_set_team_start` (service role only), behind
 * `app/api/crm/phoenix-team-starts/route.ts` — Super Admin only, the permission asserted before the
 * write, every change audited.
 *
 * ## How the visits door works (`crm_visits_unified`)
 *
 * It keeps its 30 columns (names, types, order) and gains one at the end, `phoenix_customer_validated`
 * (null on every other row). Three branches:
 *   1. iReports360, exactly as before, minus the rows of the people who SAT ON a started team's
 *      territories — and of the district manager who held the team's own seat (owner, 2026-10-02: "Yes,
 *      the whole team") — for the days they sat there within a start (`au.occupancy_history`, the same
 *      rule for the manager as for his reps, never a list of names) — matched on the hr id, or on the CRM
 *      id when the vendor row carries no hr id (the sync leaves a few blank). A rep who joins a started
 *      team keeps every iReports360 day from before he joined; one who leaves gets his vendor rows back
 *      from the day he left; a stop gives them all back from its Saturday.
 *      ▸ PHOENIX WINS THE DAY (owner, 2026-10-16, superseding "ignored from the start" for REPS): these
 *      rows are dropped only on a DAY the rep also has a Phoenix entry — a countable visit or a recorded
 *      day activity of a counted kind, on a started REP seat (`phoenix_crm_rep_entry_days()`, migration
 *      `20261016201551`). A day with no Phoenix entry keeps his iReports360 rows. A district manager's
 *      own team seat is never an entry, so he keeps BOTH apps. The plans door is unchanged.
 *   2. Phoenix visits: every real (`is_test = false`) row of `phoenix_crm_countable_visits` — the
 *      module's own predicate for "this visit counts", read and never re-typed, so an off-plan visit
 *      appears once it is approved — on a started team's territory, within its start.
 *   3. Phoenix DAY ACTIVITIES (owner, 2026-10-02, B3): every real RECORDED day activity — never a planned
 *      one — as the iReports360 code the compliance and deduction readers already treat as a WORKED day
 *      (`visit-type-meaning.ts`): meeting -11, conference -1, health day -15, training -9, admin work
 *      -20, travel -12, and a sales day as -7 with its comment beginning "Sales day", exactly as
 *      iReports360 carried one (`classifyAmbiguousComment`). So a training or meeting day no longer reads
 *      "no activity". None of these codes is a call: no call rate, visit count or Early Birds figure
 *      reads one.
 * A visit to a customer NOT VALIDATED YET is in the view, carried with `phoenix_customer_validated =
 * false`. Phoenix CRM itself draws the same line: its KPIs wait for validation ("not counted in KPIs till
 * validated", owner 2026-10-01), its adoption board does not, because a rep logging a visit to a
 * carried-over doctor he has not validated yet has plainly worked — and every one of the 1,756 Delta (1)
 * customers was still not validated on 2026-10-02. So the "did he work today" readers (field-work
 * compliance, the deductions connectors, attendance, the outstation workload) see it, and the call rate
 * leaves it out of the rate until the customer is validated, then counts it in its own day
 * (`not-validated` in `callRateExclusionOf`).
 *
 * A Phoenix row in the vendor shape: `source = 'phoenix'`; `crm_visit_id` NEGATIVE (−1 − 52 bits of
 * md5(id): every vendor id is positive, and 52 bits stay exact in JavaScript); `visit_date` the Phoenix
 * visit day (already the Cairo day of capture − 2 h — a visit day ends at 02:00 Cairo); agent = the rep,
 * or the manager on his own single visit, with his `employees.crm_id` (equal to his old vendor id for
 * every Delta rep, so readers keyed on `agent_crm_id` still find him); double = the district manager on a
 * double or chain visit; `contact_crm_id` = the customer's `reference_contact_crm_id` (null for a customer
 * created new in Phoenix, and on a day activity); `visit_type` 0 'Regular Visit' on a visit (a countable
 * Phoenix visit is a call); `ampm` = the customer's list; `visit_date_time` and `crm_save_date` = the
 * capture instant as Cairo wall clock labelled UTC (the vendor convention); `synced_at`/`created_at` =
 * when the row reached the server; region columns null. No location, accuracy, distance, flag, photo,
 * voice, dwell, capture-source or offline column is carried (golden rule #1's silent columns). The
 * manager is carried as the vendor shape carries any manager: the agent on his own single visit, the
 * partner (`double_*`) on a double or chain visit with a rep — so the DSM no-record connector, Double
 * Visit Analytics and the managers' board credit him from his Phoenix visits exactly as they did from
 * his iReports360 ones.
 *
 * ## How the check-in door works (`crm_checkins_unified`, owner 2026-10-02 — "each visit's silent
 * location counts as a check-in on the SFE and manager screens. Never on the rep's own screens")
 *
 * Its iReports360 branch leaves out the same people's check-ins for the same days as the visits door.
 * Its Phoenix branch serves each countable Phoenix visit of a started team, within its start, that
 * carries a position, as that day's check-in: capture time, position, the rep and the customer, and no
 * integrity column at all (no accuracy, flag, distance, skew, photo, dwell, capture source or offline
 * time — those stay on the integrity board). The app reads those rows ONLY where it asks
 * (`queryCheckins` `includePhoenixVisits`), and only a reader no rep can reach asks:
 *   - the CRM Master (its Check-ins tab reads the view direct; its visits' nearest check-in asks) and
 *     the CRM integrity page — the Super Admin's;
 *   - GPS brick coverage — an admin-shell board (Super Admin, CEO, SFE Manager);
 *   - the SFE and CEO overview's field analytics, whose start-time table reads the day's first Phoenix
 *     visit through `phoenixFirstVisitStarts` (sfe-field-analytics.ts) — the helper Early Birds reads;
 *   - the managers' first-visit board on the District, Regional and National Sales Managers' home pages;
 *   - the rep-day drill-down behind HR's field-workforce compliance and the National Sales Manager's
 *     team calendar; Field Activity (`double_visit_analytics`, which no Medical Rep holds); probation SFE
 *     evidence (company-wide probation access, or the SFE Manager).
 * Every other check-in reader reads iReports360 check-ins only, so a started team's people show none
 * there within the start — see "Which still do not".
 *
 * ## How the plan door works (`crm_plan_entries_unified`, owner 2026-10-02 — "Yes, in the second PR")
 *
 * Reps List statuses, the KPIs board's coverage and frequency, SFE doctor coverage and the Reps Weekly
 * Plans tab (with its plan actuals) read the iReports360 plan copy. For a started team, within its start,
 * they now read its Phoenix weekly plans INSTEAD, for the same people and days the visits use:
 *   - "PLANNED" IS WHAT THE MODULE MEANS: a day is a plan day when the plan had been SENT (submitted or
 *     approved) AS OF THAT DAY — by the end of that Cairo day, or by now for a day still to come — with
 *     the one-day-return rule (a returned day reopens only that day; the other days are "still planned").
 *     `phoenix_crm_plan_day_status` is phoenix_crm_save_visit's own "was he planned" rule for one plan,
 *     read from the plan EVENTS, never `phoenix_crm_plans.status` alone; the test holds its clauses to
 *     the save's. A draft, a week returned whole and a never-sent plan are no plan.
 *   - `plan_status` is the vendor's own 1 (verified) when the week is approved NOW, else 0 (pending) — the
 *     same on every day of a plan, as the plan boards read it.
 *   - A carried-over customer carries his `reference_contact_crm_id`, as on a visit. A customer created
 *     new in Phoenix has none, and every per-doctor reader skips a row without a contact — his plan and
 *     his visits alike, so he can be neither "planned" nor "off plan" there.
 *   - The rep's iReports360 plan entries for those days leave the view (by hr id, or CRM id on a row the
 *     plan mirror left without one). A monthly vendor plan carries no date and is not split by a start.
 *   - The Phoenix CRM List's reference patterns (`loadPlanDatesFor`) and "Copy last month"
 *     (`getAgentPlanEntriesForWindow`) read iReports360 plan entries only: they are the vendor's
 *     reference plans by design, and his own Phoenix plan is already on his screen.
 *
 * ## How double counting is prevented
 *
 *   - Within a start, a team's reps' iReports360 rows leave the same views that carry their Phoenix
 *     rows, for the same days — the two branches never both speak for one rep-day.
 *   - Outside a start, no Phoenix row is served at all (pilot or onboarding work stays out).
 *   - One Phoenix visit is one row: the agent and manager lookups are one row per person whatever the
 *     casing, so a join can never double a visit; the starts never overlap, so a seat is in one start a day.
 *   - A PHARMACY IS A ROW OF ITS OWN SINCE 2026-10-03, and this paragraph said the opposite until
 *     2026-10-04. It WAS feedback typed ON a Phoenix visit, so nothing was added for it and the
 *     Pharmacies figure of a started team read "not recorded in Phoenix" on the other screens. Then the
 *     owner ruled that a pharmacy named on a visit counts as that pharmacy's own visit — no validation,
 *     no plan, no approval — and Delta (1) logged 25 on its first Phoenix day. AM · PM · Pharmacies
 *     still stay apart, and the door still adds nothing of its own: a pharmacy call is one countable
 *     Phoenix visit, carried with `ampm` = `Pharmacy`, its customer's own list. `visitCountBucket` reads
 *     THAT (the speciality alone was not enough — 5 of those 25 carried none, and were counted among the
 *     PM doctors until it did), and `pharmacyRecordingOf` answers "recorded" for every split, so a
 *     started team's Pharmacies figure is a real count rather than a blank.
 *   - The Phoenix CRM List's "iReports360 history" (`readContactVisitHistory`) reads vendor rows only,
 *     so the visits it already counts as "saved here" are never counted twice beside them.
 *   - The district manager who holds the team's seat leaves the iReports360 branches with his reps
 *     ("Yes, the whole team"): his own vendor visits, plan entries and check-ins within the start stop
 *     counting, and his Phoenix visits count instead. The cost, named: Phoenix CRM records no day
 *     activity of a MANAGER's own (only a rep writes his day), so a district manager's meeting or
 *     training day within the start carries no record, and the DSM no-record connector may raise it — a
 *     candidate that always waits for a person's approval. Anyone who works a started team's territory
 *     without sitting on it, and logs the SAME visit in both systems, is still counted twice for it.
 *   - An iReports360 visit carries no territory, so the rule is per PERSON: someone holding a seat in a
 *     started team and another outside it at once loses his iReports360 rows for both within the start.
 *     Nobody does today — each of the 14 Delta (1) people holds that one seat (measured 2026-10-02).
 *
 * ## The read-side rules that had to learn what a Phoenix row is
 *
 * `isPhoenixNativeVisitRow` (here) is ONE predicate for "this row is Phoenix's own" — the double-visit
 * rule in reads.ts, the call rate and Early Birds all read it. The call rate (`src/lib/crm/call-rate.ts`)
 * treats a Phoenix visit as its own GPS check-in: it is captured live with the phone's location read
 * silently, and Phoenix shows that location back as no check-in row. Without it every Phoenix visit was
 * "No proof" and every Phoenix rep read 0, or "No GPS feed", on Reps List and the KPIs board.
 * `crm_visits_checkin_flags` says the same in SQL, so the CRM Master's "Regular · No Check-in" tabs never
 * list a Phoenix row.
 *
 * EARLY BIRDS (owner, 2026-10-02 — "First Phoenix visit"): for a started team's rep within its start, his
 * start of the day is the time of his first COUNTABLE Phoenix visit saved at the customer's door that day
 * (`captured_at`, Cairo) — in the start component AND the "#1 days" component, so the module stays on one
 * clock (`src/lib/early-birds/collect.ts`, `phoenix-start.ts`). His iReports360 check-ins within the
 * start are not read at all — not as his start, not as a visit's check-in, not on the daily board —
 * exactly as his iReports360 visits leave the door. As in the call rate, a Phoenix visit is its own
 * check-in: a Regular one earns the Regular credit a GPS-checked visit earns, and none sits in the GPS
 * share (no GPS check-in can ever match one), so a started district stands level with every other on the
 * company-wide wall. Every Early Birds screen names such a start "First visit", never GPS — the rep is
 * never told his location is read (golden rule #1). A visit to a customer not validated yet counts there,
 * as on every "did he work" reader: it is the start of a working day.
 *
 * ## Which readers now see Phoenix rows
 *
 * Everything that reads visits and plans through the doors: field-work compliance and its No Activity
 * Candidates, the CRM no-activity, DSM no-record and holiday-bridge deductions connectors, the
 * attendance CRM day maps, the outstation visit workload, Reps List and the KPIs board (the call rate,
 * coverage and frequency), the Reps Weekly Plans tab, the rep visits drill-down, SFE doctor coverage, the
 * Business Review, Employee 360, Early Birds, probation double visits and SFE evidence, Double Visit
 * Analytics, the company and field activity reports, retention risk, the employee portal's own and team
 * visits, the CRM Master and the contact master's activity pass. MONEY-ADJACENT among them: field-work
 * compliance (its payroll-deduction recommendation is the CRM connector's engine), the CRM no-activity,
 * DSM no-record and holiday-bridge connectors, the attendance day maps (a worked day cancels a
 * fingerprint deduction) and the outstation workload (its gate, and Double Visit Analytics behind its
 * Rule 3). The change only stops a working rep reading as idle there. Nothing here writes, approves or
 * publishes a deduction, an allowance or a payroll row — a CRM no-activity candidate still publishes with
 * the month unless someone clears it, exactly as before.
 *
 * ## Which still do not, and why (each needs a ruling or a feature of its own)
 *
 *   - Every check-in reader a REP can reach stays on iReports360 check-ins (golden rule #1), so a started
 *     team's people show no check-in there within the start: the portal's My Visits (its Check-ins tab,
 *     and its GPS/Logged badge — a Phoenix visit shows its time bare instead), Employee 360 (a rep opens
 *     his own), the KPIs board (a rep opens his own panel), the outstation visit workload and the claim
 *     validation behind it (a rep opens his own trip), Early Birds (its clock is the first Phoenix visit
 *     itself), the Phoenix CRM List's customer pins (reps-list.ts `loadCheckins` / `loadPinsFor`) and
 *     pharmacy search. The call rate and its drill-down need none: a Phoenix visit is its own check-in.
 *     The manager's Early Birds decision line still names "N GPS-verified", 0 for a Phoenix candidate.
 *   - A customer created new in Phoenix has no iReports360 contact id: his visits and plans count for
 *     the rep, but no contact-keyed figure (coverage, per-doctor tallies) can name him. Measured on
 *     production 2026-10-04: 13 such customers on Delta (1)'s first Phoenix day, carrying 12 of its 128
 *     Phoenix visits — 9.4% of them — with `contact_crm_id` null.
 *   - 🔴 THE DOCTOR LIST ITSELF IS STILL THE VENDOR'S, and it is the largest thing the starts do not yet
 *     reach. `crm_contact_master_refresh` (migration 20260914020000) rebuilds `crm_contacts` and
 *     `crm_contact_assignments` from the raw `ireports360_contacts` scrape, and its `v_lists_live` gate
 *     is `cairo_today < crm_cutover.cutover_date` COALESCED TO TRUE — so with the global date unset the
 *     vendor passes still run for a started team, and no `phoenix_crm_started_team_*` appears anywhere in
 *     the function. A started rep's real list lives in `phoenix_crm_customers`, read only inside
 *     `src/lib/phoenix-crm/` and `src/lib/customer-identity/`, so a doctor he added or dropped in Phoenix
 *     CRM from his start is invisible to every list surface outside the module: Rep Doctor Lists, the
 *     Reps List doctor column, the rep KPI reports' coverage and frequency denominators, the Business
 *     Review field link, Employee 360's doctor list and the direct-order venue picker. Measured
 *     2026-10-04: 1,984 Phoenix customers across Delta (1)'s seats against 1,997 live vendor assignments,
 *     the sizes near-identical because the Phoenix lists were SEEDED from the vendor's — so the defect is
 *     silent today and widens with every add and drop. Second shape, worse: the moment a rep's vendor
 *     account is disabled the scrape returns nothing, `contacts-sync` refuses an empty answer rather than
 *     applying it, and his list FREEZES at its last vendor contents for good.
 *   - A started team's October is scored by the PRE-cutover KPI rules: `kpiRulesFor`
 *     (phoenix-kpi-rules.ts) answers `legacy` whenever `cutoverDate` is null, which a per-team start
 *     never sets — the same shape as owner decision 18 below, and it needs the same ruling.
 *   - Leave is HR's: an APPROVED leave request already lifts a continuing rep's no-activity deduction —
 *     but the CRM connector's LEAVER path has no such check, so a leaving Phoenix rep's approved leave
 *     days would read as no activity (it used to see the iReports360 leave rows).
 *   - A chain visit's SENIOR manager: the vendor shape has one partner column, which carries the
 *     district manager, so the senior earns no double-visit credit from a started team.
 *   - Owner decision 18 (no CRM no-activity charge in the cutover month) keys on the GLOBAL
 *     `crm_cutover.cutover_date`, which per-team starts never set: a team's first Phoenix month is
 *     charged as any other unless the owner extends that decision to it.
 *   - SQL that reads `ireports360_visits` or `ireports360_plan_entries` directly rather than the views
 *     (sync, parity, plan verification, identity and region-mapping machinery) — by design, it is about
 *     the vendor's records.
 */

import { addDaysIso } from "@/lib/crm/dates";
import type { PhoenixTeamReadinessPanelData } from "@/lib/crm/phoenix-team-readiness";
import { utcDate } from "@/lib/format/cairo-datetime";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { seatOccupants, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { sortVendorLeftovers, type VendorLeftoverRep } from "@/lib/phoenix-crm/vendor-leftovers";

/** The table the first migration creates. The app reads it; only `phoenix_crm_set_team_start` writes it. */
export const PHOENIX_CRM_TEAM_STARTS_TABLE = "phoenix_crm_team_starts";

/** The once-per-team claim the notice inserts before it tells anybody. */
export const PHOENIX_CRM_TEAM_START_NOTICES_TABLE = "phoenix_crm_team_start_notices";

/** The one writer. */
export const PHOENIX_CRM_SET_TEAM_START_RPC = "phoenix_crm_set_team_start";

/** The migration that holds the starts, the writer and the visits door. */
export const PHOENIX_CRM_VISITS_EVERYWHERE_MIGRATION = "supabase/migrations/20261002123958_phoenix_crm_visits_everywhere.sql";

/** The migration that holds the plan door. */
export const PHOENIX_CRM_PLANS_EVERYWHERE_MIGRATION = "supabase/migrations/20261002142118_phoenix_crm_plans_everywhere.sql";

/** Where the Super Admin starts and stops a team — the CRM hub, at the panel. */
export const PHOENIX_TEAM_STARTS_PANEL_PATH = "/admin/crm#phoenix-team-starts";

/** `crm_visits_unified.source` on a Phoenix CRM row. */
export const PHOENIX_VISIT_SOURCE = "phoenix";

/** `crm_visits_unified.source` on an iReports360 row — for the readers that must see vendor history only. */
export const IREPORTS360_VISIT_SOURCE = "ireports360";

/**
 * Whether a row of the visits door is Phoenix CRM's own rather than iReports360's: `source` says so,
 * and a reader that did not select `source` still knows it by the NEGATIVE `crm_visit_id` the view
 * gives every Phoenix row (every vendor id is positive). A row carrying neither column is read as a
 * vendor row — the rule every caller had before Phoenix rows existed.
 */
export function isPhoenixNativeVisitRow(row: { source?: string | null; crm_visit_id?: number | null }): boolean {
  return row.source === PHOENIX_VISIT_SOURCE || (row.crm_visit_id != null && row.crm_visit_id < 0);
}

/** One person's days within a team's start: [from, until), until null while it runs. */
export type StartedRepWindow = {
  /** The roster key (`normalizeHrIdForAccess`), or null. */
  hrIdKey: string | null;
  agentCrmId: number | null;
  from: string;
  until: string | null;
};

/**
 * Whether a row (a check-in, a visit) of this person on this day falls within a start. Matched as the
 * read door matches: on the hr id, or — on a row that carries no hr id — on the CRM id.
 *
 * The SECOND predicate of this module, beside {@link isPhoenixNativeVisitRow}: that one asks what a row
 * IS, this one asks whether a person's day is Phoenix's to answer at all. A reader that goes anywhere
 * other than the views — the live vendor API, a raw mirror read — has no `source` column to look at, so
 * it must ask THIS before it picks a source. `rep-day.ts` is why the rule moved here from Early Birds:
 * it chose live-vs-mirror on the global `crm_cutover` alone, which a per-team start never sets.
 */
export function startedWindowCovers(
  windows: readonly StartedRepWindow[],
  row: { hrId: string | null | undefined; crmId: number | null | undefined },
  dateIso: string,
): boolean {
  if (!dateIso) return false;
  const key = normalizeHrIdForAccess(row.hrId ?? null);
  return windows.some(
    (window) =>
      dateIso >= window.from &&
      (window.until === null || dateIso < window.until) &&
      (key ? window.hrIdKey === key : row.crmId != null && window.agentCrmId === row.crmId),
  );
}

// ── The starts ─────────────────────────────────────────────────────────────────────────────────────

export type PhoenixTeamStartedBy = "owner_ruling" | "super_admin";

export type PhoenixTeamStart = {
  id: string;
  /** The district-manager seat the team's territories hang from. A key, never shown. */
  teamSeatId: string;
  /** The Saturday the team is counted from Phoenix CRM, YYYY-MM-DD. */
  startsOn: string;
  /** The Saturday it is counted from iReports360 again; null while it runs. */
  stopsOn: string | null;
  startedBy: PhoenixTeamStartedBy;
  startedByHrId: string | null;
  note: string | null;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isoDayOf(value: unknown): string | null {
  const day = typeof value === "string" ? value.slice(0, 10) : "";
  return ISO_DAY.test(day) ? day : null;
}

function textOf(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function isStartedBy(value: unknown): value is PhoenixTeamStartedBy {
  return value === "owner_ruling" || value === "super_admin";
}

/** One database row onto a start. A row without an id, a seat, a Saturday or a known cause is dropped. */
export function parsePhoenixTeamStart(raw: Record<string, unknown> | null | undefined): PhoenixTeamStart | null {
  if (!raw) return null;
  const id = textOf(raw.id);
  const teamSeatId = textOf(raw.team_seat_id);
  const startsOn = isoDayOf(raw.starts_on);
  if (!id || !teamSeatId || !startsOn || !isStartedBy(raw.started_by)) return null;
  return {
    id,
    teamSeatId,
    startsOn,
    stopsOn: isoDayOf(raw.stops_on),
    startedBy: raw.started_by,
    startedByHrId: textOf(raw.started_by_hr_id),
    note: textOf(raw.note),
  };
}

// ── The rules the panel offers — the database refuses anything else ─────────────────────────────────

function isoDow(day: string): number {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function isSaturday(day: string): boolean {
  return ISO_DAY.test(day) && isoDow(day) === 6;
}

/** The first day of the Cairo month `cairoToday` is in — no start or stop reaches back before it. */
export function cairoMonthFloor(cairoToday: string): string {
  return `${cairoToday.slice(0, 7)}-01`;
}

/** The first Saturday on or after a day. */
export function saturdayOnOrAfter(day: string): string {
  return addDaysIso(day, (13 - isoDow(day)) % 7);
}

/** "The coming Saturday": the first Saturday after today. */
export function comingSaturday(cairoToday: string): string {
  return saturdayOnOrAfter(addDaysIso(cairoToday, 1));
}

/** How many Saturdays past the coming one the pickers offer. */
export const TEAM_START_WEEKS_AHEAD = 12;

/** Every Saturday from `from` (a Saturday) through `TEAM_START_WEEKS_AHEAD` weeks past the coming one. */
function saturdaysFrom(from: string, cairoToday: string): string[] {
  const last = addDaysIso(comingSaturday(cairoToday), TEAM_START_WEEKS_AHEAD * 7);
  const days: string[] = [];
  for (let day = from; day <= last; day = addDaysIso(day, 7)) days.push(day);
  return days;
}

/** The Saturdays a team may be started from: on or after the month floor and the team's last stop. */
export function startSaturdayOptions(cairoToday: string, lastStop: string | null): string[] {
  const floor = saturdayOnOrAfter(cairoMonthFloor(cairoToday));
  const from = lastStop && lastStop > floor ? lastStop : floor;
  return saturdaysFrom(from, cairoToday);
}

/** The Saturday a Start offers first: the coming Saturday, or the first one offered after it. */
export function defaultStartSaturday(cairoToday: string, options: readonly string[]): string | null {
  const coming = comingSaturday(cairoToday);
  return options.find((day) => day >= coming) ?? options[options.length - 1] ?? null;
}

/**
 * The Saturdays a running start may be stopped from, under the month floor. Its own first Saturday is
 * offered when it falls in this month: stopping there takes the start back whole.
 */
export function stopSaturdayOptions(cairoToday: string, startsOn: string): string[] {
  const floor = saturdayOnOrAfter(cairoMonthFloor(cairoToday));
  const from = startsOn > floor ? startsOn : floor;
  return saturdaysFrom(from, cairoToday);
}

/** "Sat 03 Oct 2026" — a DATE-ONLY Saturday, so it is formatted in UTC and never shifted a day. */
export function saturdayLabel(isoDay: string): string {
  return `Sat ${utcDate(isoDay)}`;
}

/** "Saturday 03 Oct 2026". */
export function countedFromLabel(isoDay: string): string {
  return `Saturday ${utcDate(isoDay)}`;
}

function repsPhrase(reps: number): string {
  if (reps === 0) return "its reps";
  return reps === 1 ? "this 1 rep" : `these ${reps} reps`;
}

/** What pressing Start does, in words — the confirm the Super Admin answers. */
export function startConfirmText(day: string, reps: number): string {
  return `From ${saturdayLabel(day)}, the iReports360 visits of ${repsPhrase(reps)} stop counting and their Phoenix visits count instead.`;
}

/** Whether a Stop takes the start back whole: not reached yet, or stopped on its own first Saturday. */
export function stopCancelsStart(startsOn: string, day: string | null, cairoToday: string): boolean {
  return startsOn > cairoToday || !day || day <= startsOn;
}

/** What pressing Stop does, in words. */
export function stopConfirmText(startsOn: string, day: string | null, reps: number, cairoToday: string): string {
  if (stopCancelsStart(startsOn, day, cairoToday)) {
    return `The start on ${saturdayLabel(startsOn)} is taken back: the iReports360 visits of ${repsPhrase(reps)} count again, and no day of it counts from Phoenix.`;
  }
  return `From ${saturdayLabel(day as string)}, the Phoenix visits of ${repsPhrase(reps)} stop counting and their iReports360 visits count again.`;
}

/** The notice the Super Admin gets the first time a real weekly plan is sent on a team with no start. */
export const PHOENIX_TEAM_NOT_STARTED_EVENT = "team_not_started";

/** The words of that notice (phoenix-team-start-notice.ts sends it). Pure, so the test reads exactly what he reads. */
export function teamNotStartedNotice(input: { team: string; repName: string; weekStart: string }): { title: string; message: string } {
  return {
    title: "A team is planning in Phoenix CRM",
    message:
      `${input.repName} sent a weekly plan in Phoenix CRM for the week of ${saturdayLabel(input.weekStart)}. ` +
      `${input.team} is still counted from iReports360 on every other screen. Start it on the CRM page when you are ready.`,
  };
}

/** The writer's refusals, in words. */
export const TEAM_START_REFUSALS: Readonly<Record<string, string>> = {
  bad_input: "Choose the team and the Saturday, then try again.",
  no_team: "This team has no territories in the organogram any more. Reload the page.",
  not_saturday: "A team starts and stops on a Saturday.",
  before_month: "A start or a stop cannot reach back before the first day of this month.",
  already_started: "This team is already counted from Phoenix CRM. Reload the page.",
  overlaps: "Pick a Saturday on or after the team's last stop.",
  not_started: "This team is not counted from Phoenix CRM. Reload the page.",
};

/** `phoenix_crm_team_start:<code>` from the database → its words, or null when it is not one of ours. */
export function teamStartRefusal(message: string | null | undefined): string | null {
  const match = /phoenix_crm_team_start:([a-z_]+)/.exec(String(message ?? ""));
  if (!match) return null;
  return TEAM_START_REFUSALS[match[1]] ?? null;
}

// ── The panel ──────────────────────────────────────────────────────────────────────────────────────

export type PhoenixTeamState = "not_started" | "starts" | "running" | "stopping" | "stopped";

/** The first real plan sent on a team with no start (`phoenix_crm_team_start_notices`). */
export type PhoenixTeamFirstPlan = { repName: string | null; weekStart: string };

/** One team as the Super Admin reads it on the CRM hub. Names only; the seat id is the key and the payload. */
export type PhoenixTeamRow = {
  teamSeatId: string;
  /** "Dina Hamdy · Anti Infective · Delta (1)". */
  team: string;
  /** Territories under the team's seat today, and the reps on them. */
  territories: number;
  reps: number;
  state: PhoenixTeamState;
  /** "Counted from Phoenix CRM since Saturday 03 Oct 2026 · set by ruling". */
  stateLine: string;
  /** The running start, when there is one — what Stop acts on. */
  runningStartsOn: string | null;
  /** Start: the Saturdays offered and the one selected first; empty while a start runs. */
  startOptions: string[];
  startDefault: string | null;
  /** Stop: the Saturdays offered; empty for a start not reached yet, which Stop takes back whole. */
  stopOptions: string[];
  /** "Ahmed Ali sent a weekly plan for the week of Sat 10 Oct 2026" — on a team with no start. */
  firstPlanLine: string | null;
  /**
   * Reps of this team still recording their day in iReports360 since it started counting from
   * Phoenix, with what they recorded there. Empty when nobody is — and empty on a team with no
   * start, where iReports360 IS where the work belongs.
   * See `src/lib/phoenix-crm/vendor-leftovers.ts` for the sentence and why it exists.
   */
  stillOnVendor: VendorLeftoverRep[];
};

export type PhoenixTeamStartsPanelData = {
  /** False when the table is not there yet (the migration not applied) — the panel says so. */
  provisioned: boolean;
  cairoToday: string;
  teams: PhoenixTeamRow[];
  /**
   * Which of those teams is READY to be started, read beside the Start button rather than on a page
   * of its own — the same teams, the same titles, the same start state.
   * `src/lib/crm/phoenix-team-readiness.ts` holds the rules, and why "seats filled" is never the
   * headline there.
   */
  readiness: PhoenixTeamReadinessPanelData;
};

function teamTitle(seat: OrgSeat | null, names: (hrId: string) => string | null): string {
  const manager = seat?.occupantHrId ? names(seat.occupantHrId) : null;
  const who = !seat
    ? "A team no longer in the organogram"
    : (manager ?? (seat.occupantHrId ? "District manager" : "District manager seat vacant"));
  return [who, seat?.lineName ?? null, seat?.regionName ?? null].filter((part): part is string => Boolean(part)).join(" · ");
}

function causeOf(start: PhoenixTeamStart, names: (hrId: string) => string | null): string {
  if (start.startedBy === "owner_ruling") return "set by ruling";
  const who = start.startedByHrId ? names(start.startedByHrId) : null;
  return who ? `started by ${who}` : "started on the CRM page";
}

/**
 * Every team — every seat with territories under it — with its state, from today's organogram and every
 * start. A start whose seat the organogram no longer holds is still listed, so nothing counted from
 * Phoenix CRM is ever hidden from the Super Admin. `names` answers a display name for an hr id, or null.
 */
export function buildPhoenixTeamRows(input: {
  org: OrgIndex;
  starts: readonly PhoenixTeamStart[];
  firstPlans: ReadonlyMap<string, PhoenixTeamFirstPlan>;
  /** Per team seat: who is still recording in iReports360 since its start. Absent means none read. */
  stillOnVendor?: ReadonlyMap<string, VendorLeftoverRep[]>;
  names: (hrId: string) => string | null;
  cairoToday: string;
}): PhoenixTeamRow[] {
  const { org, names, cairoToday } = input;
  const territoriesByTeam = new Map<string, OrgSeat[]>();
  for (const territory of org.territories) {
    if (!territory.parentSeatId) continue;
    const list = territoriesByTeam.get(territory.parentSeatId) ?? [];
    list.push(territory);
    territoriesByTeam.set(territory.parentSeatId, list);
  }
  const startsByTeam = new Map<string, PhoenixTeamStart[]>();
  for (const start of input.starts) {
    const list = startsByTeam.get(start.teamSeatId) ?? [];
    list.push(start);
    startsByTeam.set(start.teamSeatId, list);
  }

  const rows: PhoenixTeamRow[] = [];
  for (const teamSeatId of new Set<string>([...territoriesByTeam.keys(), ...startsByTeam.keys()])) {
    const seat = org.seats.get(teamSeatId) ?? null;
    const territories = territoriesByTeam.get(teamSeatId) ?? [];
    // People, not seats: a handover seat holds two.
    const reps = territories.reduce((count, territory) => count + seatOccupants(territory).length, 0);
    const starts = [...(startsByTeam.get(teamSeatId) ?? [])].sort((left, right) => left.startsOn.localeCompare(right.startsOn));
    const running = starts.find((start) => start.stopsOn === null) ?? null;
    const lastStopped = [...starts].reverse().find((start) => start.stopsOn !== null) ?? null;

    let state: PhoenixTeamState;
    let stateLine: string;
    if (running && running.startsOn > cairoToday) {
      state = "starts";
      stateLine = `Counted from Phoenix CRM from ${countedFromLabel(running.startsOn)} · ${causeOf(running, names)}`;
    } else if (running) {
      state = "running";
      stateLine = `Counted from Phoenix CRM since ${countedFromLabel(running.startsOn)} · ${causeOf(running, names)}`;
    } else if (lastStopped?.stopsOn && lastStopped.stopsOn > cairoToday) {
      state = "stopping";
      stateLine = `Counted from Phoenix CRM since ${countedFromLabel(lastStopped.startsOn)}, back on iReports360 from ${countedFromLabel(lastStopped.stopsOn)}`;
    } else if (lastStopped?.stopsOn) {
      state = "stopped";
      stateLine = `Back on iReports360 since ${countedFromLabel(lastStopped.stopsOn)} · counted from Phoenix CRM ${saturdayLabel(lastStopped.startsOn)} to ${saturdayLabel(lastStopped.stopsOn)}`;
    } else {
      state = "not_started";
      stateLine = "Counted from iReports360";
    }

    const startOptions = running ? [] : startSaturdayOptions(cairoToday, lastStopped?.stopsOn ?? null);
    const firstPlan = running ? null : (input.firstPlans.get(teamSeatId) ?? null);
    rows.push({
      teamSeatId,
      team: teamTitle(seat, names),
      territories: territories.length,
      reps,
      state,
      stateLine,
      runningStartsOn: running?.startsOn ?? null,
      startOptions,
      startDefault: running ? null : defaultStartSaturday(cairoToday, startOptions),
      stopOptions: running && running.startsOn <= cairoToday ? stopSaturdayOptions(cairoToday, running.startsOn) : [],
      firstPlanLine: firstPlan
        ? `${firstPlan.repName ?? "A rep"} sent a weekly plan for the week of ${saturdayLabel(firstPlan.weekStart)}`
        : null,
      // Only on a team that HAS a running start: before one, iReports360 is where the work belongs
      // and there is nothing to flag.
      stillOnVendor: running ? sortVendorLeftovers(input.stillOnVendor?.get(teamSeatId) ?? []) : [],
    });
  }

  // Counted teams first, then by name, line and region — the order a Super Admin scans the company in.
  const rank: Record<PhoenixTeamState, number> = { running: 0, stopping: 1, starts: 2, stopped: 3, not_started: 4 };
  return rows.sort((left, right) => rank[left.state] - rank[right.state] || left.team.localeCompare(right.team));
}
