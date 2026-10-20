// Recruitment / ATS — one Cairo-daily summary of the CVs that arrived, in place of one alert per CV.
//
// Measured against production on 2026-08-15: 628 `recruitment_inbound_cv` deliveries reached 3
// Talent Acquisition reviewers over 30 days — roughly 21 CVs a day, each one raising its own in-app
// item, Telegram message and push. Nobody reads the twenty-first notification of the day, and the
// consequence is not merely noise: the alert that DOES matter (a CV whose file could not be
// attached, a dead-letter, an intake spike) arrives in the same stream and is muted along with the
// rest. The pool screen already shows what arrived and when, so the per-CV push was telling a
// reviewer something the screen tells them better.
//
// So this replaces the twenty-one with one. It is deliberately a SUMMARY, not a list of names: the
// digest exists to answer "is there work waiting, and what kind" in one line, and the names are one
// click away on a screen built to show them.
//
// GROUPED BY THE WORKSPACE'S OWN TABS (owner's plan, 20 Oct 2026): "Medical Rep · Alex-BHR: 3 new,
// 1 incomplete" — role tab, then the AU area (or the region, where the tab has no areas), each the
// way the applicant's OWN replies filed them (`ats_candidate_placements`). Nobody filed is counted
// under Needs placing. The old "Applying for" breakdown read `applied_for_job_title`, which the CV
// reading fills, and the owner's rule is that a CV never decides where a person is filed — so it is
// gone from here. "Incomplete" is the stored completeness (`missing_answer_keys` not empty).
//
// The pure half (buildDailyCvDigest, dailyCvDigestMessage) takes rows and returns text, so the
// wording and the counting are unit-testable without a database, a clock or a notification.

import { candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { isUnreviewedCandidateStatus } from "@/lib/recruitment/candidate-status";
import { recruitmentDb } from "@/lib/recruitment/db";
import { cairoDateKey, cairoHour } from "@/lib/recruitment/inbound/whatsapp-health";
import { intakeSourceLabel } from "@/lib/recruitment/intake-source";
import { listPlacementsFor } from "@/lib/recruitment/workspace/placements-db";
import {
  NEEDS_PLACING,
  personVisibleToViewer,
  workspaceRoleTabLabels,
  workspaceRoleTabs,
  workspaceViewer,
  type WorkspaceRoleTab,
} from "@/lib/recruitment/workspace/role-tabs";

/** Why one arriving CV still earns its own alert, or `null` when the digest covers it. */
export type InboundCvAlertReason = "no_file" | "applicant";

/**
 * Whether ONE arriving CV still deserves its own alert now that the day is summarised here.
 *
 * It stays YES for a CV whose file could not be attached: that is not routine arrival, it is a
 * candidate record with no CV behind it, needing a human to open the original message.
 *
 * It is also YES for a CV a REAL APPLICANT sent, and that half was missing until 2026-08-30. The
 * measurement behind the original rule counted 628 deliveries over 30 days and concluded the
 * per-CV alert was noise. Re-measured on production 2026-08-29, that number splits in two and the
 * halves are nothing alike: of 437 WhatsApp arrivals in 30 days, **427 were the owner forwarding
 * his own pile** from the advertised handset — 330 of them in a single evening — and **10 were
 * members of the public answering the advert.** The flood was never applicants. Suppressing the
 * forwards alone removes ~98% of the volume, and what is left is a handful a day.
 *
 * The cost of getting this wrong was measured the same night. A text with no CV fired
 * `recruitment_whatsapp_text_only` and reached the owner's Telegram in ONE second; the applicant's
 * actual CV, twenty-five seconds later, produced no notification row at all. He described it exactly
 * as it looks from the outside — "when someone sends the text and then sends the CV, the CV does not
 * appear" — because the least important event on the line was the loud one.
 *
 * `bulkArrival` is that distinction and nothing else: an import sender (a forwarding handset, not
 * the applicant) or a coexistence history replay, which would otherwise page a human once for every
 * CV of the last two months the moment a handset is linked. The daily digest still counts every
 * arrival either way — this decides only what interrupts someone NOW.
 *
 * It lives here rather than beside the notification it gates so it can be tested as a pure rule,
 * without loading the notification pipeline.
 */
export function inboundCvAlertReason(input: {
  fileAttached: boolean;
  bulkArrival?: boolean;
}): InboundCvAlertReason | null {
  if (!input.fileAttached) return "no_file";
  if (input.bulkArrival) return null;
  return "applicant";
}

/** Boolean form of {@link inboundCvAlertReason}, kept for call sites that only gate on it. */
export function shouldAlertImmediatelyForInboundCv(input: {
  fileAttached: boolean;
  bulkArrival?: boolean;
}): boolean {
  return inboundCvAlertReason(input) !== null;
}

/**
 * The Cairo hour the digest is sent in. 18:00 rather than the end of the day: the intake runs on the
 * every-10-minute email cron, so a digest can only fire on one of those ticks, and 18:00 puts it
 * after a Cairo working day's arrivals while there is still somebody at a desk to act on it.
 *
 * The cron ticks six times inside that hour. Only the first one actually delivers — the notification
 * layer claims a per-recipient idempotency key derived from the Cairo date (see
 * notifyDailyCvDigest), and a claim that loses the race is dropped before anything is sent.
 */
export const DAILY_CV_DIGEST_CAIRO_HOUR = 18;

/**
 * How far back the loader reads. The digest only ever reports ONE Cairo day, but "today in Cairo"
 * spans up to 26 hours of UTC depending on the hour the job fires, and Egypt observes DST — so the
 * window is deliberately generous and the day boundary is decided by cairoDateKey on each row, not
 * by arithmetic on a timestamp.
 */
const LOOKBACK_HOURS = 36;

/** Where one arrival is filed — one entry per tab, as `ats_candidate_placements` holds it. */
export type DailyCvDigestPlacement = {
  tab: WorkspaceRoleTab;
  regionCode?: string | null;
  areaCode?: string | null;
  areaName?: string | null;
};

/** What the digest needs off a candidate row. Nothing else is read, so nothing else can go stale. */
export type DailyCvDigestRow = {
  createdAt?: string | null;
  source?: string | null;
  status?: string | null;
  /** Empty or absent = Needs placing. */
  placements?: readonly DailyCvDigestPlacement[] | null;
  /** The stored completeness: answer keys the applicant has not given. Absent = not computed yet. */
  missingAnswerKeys?: readonly string[] | null;
};

export type DailyCvDigestGroup = { count: number; label: string };

/** One "Medical Rep · Alex-BHR: 3 new, 1 incomplete" line, with what the workspace link needs. */
export type DailyCvDigestPlace = {
  label: string;
  tab: WorkspaceRoleTab | typeof NEEDS_PLACING;
  region: string | null;
  area: string | null;
  /** Arrived that Cairo day. */
  count: number;
  /** Of those, with at least one answer still missing. */
  incomplete: number;
};

export type DailyCvDigest = {
  /** Of the day's arrivals, how many nobody has looked at yet. */
  awaitingReview: number;
  /**
   * By the tab and place the applicant's own replies filed them in, in the owner's tab order with
   * Needs placing last. A person filed in two tabs is counted in both, so these may add up to more
   * than `total` — never fewer: everyone is in a tab or in Needs placing.
   */
  byPlace: DailyCvDigestPlace[];
  bySource: DailyCvDigestGroup[];
  /** Africa/Cairo YYYY-MM-DD — the day being reported, and the throttle bucket. */
  dayKey: string;
  total: number;
};

const NEEDS_PLACING_LABEL = "Needs placing";

const UNRECORDED_SOURCE = "Source not recorded";

// The map moved to `intake-source.ts` when the screening list needed it too. Kept as a local alias
// so this file reads unchanged.
const sourceLabel = intakeSourceLabel;

/** Counts by label, biggest first, ties alphabetical so the same day always reads the same way. */
function groupByLabel(values: Array<string | null | undefined>, fallback: string): DailyCvDigestGroup[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = String(value ?? "").trim() || fallback;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts, ([label, count]) => ({ count, label })).sort(
    (left, right) => right.count - left.count || left.label.localeCompare(right.label),
  );
}

function isOnCairoDay(createdAt: string | null | undefined, dayKey: string): boolean {
  const raw = String(createdAt ?? "").trim();
  if (!raw) return false;
  const stamped = new Date(raw);
  if (Number.isNaN(stamped.getTime())) return false;
  return cairoDateKey(stamped) === dayKey;
}

function regionLabel(code: string | null | undefined): string | null {
  const key = String(code ?? "").trim().toUpperCase();
  if (!key) return null;
  return candidateRegionLabels[key as CandidateRegionCode] ?? null;
}

/**
 * One place per row and tab. The AU area's own name where the reply gave one, else the region's name,
 * else the tab alone — never a code on screen.
 */
function placesOf(row: DailyCvDigestRow): Array<Omit<DailyCvDigestPlace, "count" | "incomplete">> {
  const placements = (row.placements ?? []).filter((placement) => workspaceRoleTabs.includes(placement.tab));
  if (placements.length === 0) {
    return [{ area: null, label: NEEDS_PLACING_LABEL, region: null, tab: NEEDS_PLACING }];
  }
  return placements.map((placement) => {
    const areaName = String(placement.areaName ?? "").trim() || null;
    const region = String(placement.regionCode ?? "").trim() || null;
    const where = areaName ?? regionLabel(region);
    return {
      area: areaName ? String(placement.areaCode ?? "").trim() || null : null,
      label: where ? `${workspaceRoleTabLabels[placement.tab]} · ${where}` : workspaceRoleTabLabels[placement.tab],
      region,
      tab: placement.tab,
    };
  });
}

/** Tab order first (Needs placing last), then biggest first, ties alphabetical. */
function groupByPlace(rows: readonly DailyCvDigestRow[]): DailyCvDigestPlace[] {
  const groups = new Map<string, DailyCvDigestPlace>();
  for (const row of rows) {
    const incomplete = (row.missingAnswerKeys ?? []).length > 0;
    const seen = new Set<string>();
    for (const place of placesOf(row)) {
      const key = `${place.tab}|${place.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key) ?? { ...place, count: 0, incomplete: 0 };
      group.count += 1;
      if (incomplete) group.incomplete += 1;
      groups.set(key, group);
    }
  }
  const tabRank = (tab: DailyCvDigestPlace["tab"]) => {
    const at = (workspaceRoleTabs as readonly string[]).indexOf(tab);
    return at >= 0 ? at : workspaceRoleTabs.length;
  };
  return Array.from(groups.values()).sort(
    (left, right) =>
      tabRank(left.tab) - tabRank(right.tab) || right.count - left.count || left.label.localeCompare(right.label),
  );
}

/** "3 new, 1 incomplete" — the incomplete half only when there is one. */
export function dailyCvDigestPlaceLine(place: DailyCvDigestPlace): string {
  const counts = place.incomplete > 0 ? `${place.count} new, ${place.incomplete} incomplete` : `${place.count} new`;
  return `${place.label}: ${counts}`;
}

/**
 * Pure. Rows in, counts out — the caller decides which rows to hand over and the day key decides
 * which of them count.
 */
export function buildDailyCvDigest(rows: readonly DailyCvDigestRow[], dayKey: string): DailyCvDigest {
  const arrived = rows.filter((row) => isOnCairoDay(row.createdAt, dayKey));
  return {
    awaitingReview: arrived.filter((row) => isUnreviewedCandidateStatus(row.status)).length,
    byPlace: groupByPlace(arrived),
    bySource: groupByLabel(
      arrived.map((row) => sourceLabel(row.source)),
      UNRECORDED_SOURCE,
    ),
    dayKey,
    total: arrived.length,
  };
}

export function dailyCvDigestTitle(digest: DailyCvDigest): string {
  return digest.total === 1 ? "1 CV arrived today" : `${digest.total} CVs arrived today`;
}

/**
 * The message body. Every group is listed — no ellipsis and no "and N others", per the owner's
 * standing rule that text is never truncated. The number of distinct places in a single day is
 * bounded by the number of CVs in that day, which is ~21.
 */
export function dailyCvDigestMessage(digest: DailyCvDigest): string {
  if (digest.total === 0) return "";

  const lines: string[] = [];
  lines.push(
    digest.awaitingReview === 0
      ? "Every one of them has already been looked at."
      : `${digest.awaitingReview} of them ${digest.awaitingReview === 1 ? "is" : "are"} still waiting for a first look.`,
  );

  lines.push("");
  lines.push("By tab and place:");
  for (const place of digest.byPlace) lines.push(`- ${dailyCvDigestPlaceLine(place)}`);

  lines.push("");
  lines.push("Arrived by:");
  for (const group of digest.bySource) lines.push(`- ${group.label} — ${group.count}`);

  return lines.join("\n");
}

const DIGEST_COLUMNS = "id,created_at,source,status,declared_role_family,missing_answer_keys";
const PRE_MIGRATION_DIGEST_COLUMNS = "id,created_at,source,status";

type CandidateDigestDbRow = {
  id: string;
  created_at?: string | null;
  source?: string | null;
  status?: string | null;
  declared_role_family?: string | null;
  missing_answer_keys?: string[] | null;
};

/** A digest row plus what the Talent Acquisition fence reads. */
export type DailyCvDigestSourceRow = DailyCvDigestRow & { id: string; declaredRoleFamily: string | null };

/**
 * Reads the recent candidate rows the digest might report on, with where each is filed. A handful of
 * columns only — never `select("*")`, which would drag every jsonb extraction block across the
 * Atlantic for a job that needs a count.
 *
 * The narrow select is retried without the workspace columns on a 42703 (undefined column): the
 * workspace migration is a separate production step from the merge that ships this code, and in that
 * window the digest still counts the day — everyone simply reads as filed nowhere yet. Every other
 * error is thrown.
 */
export async function loadRecentCandidateDigestRows(now: Date = new Date()): Promise<DailyCvDigestSourceRow[]> {
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const supabase = recruitmentDb();

  let rows: CandidateDigestDbRow[];
  const first = await supabase.from("ats_candidates").select(DIGEST_COLUMNS).gte("created_at", since);
  if (!first.error) {
    rows = (first.data ?? []) as CandidateDigestDbRow[];
  } else {
    if ((first.error as { code?: string }).code !== "42703") throw first.error;
    const fallback = await supabase.from("ats_candidates").select(PRE_MIGRATION_DIGEST_COLUMNS).gte("created_at", since);
    if (fallback.error) throw fallback.error;
    rows = (fallback.data ?? []) as CandidateDigestDbRow[];
  }

  const placements = await listPlacementsFor(rows.map((row) => String(row.id)));
  return rows.map((row) => ({
    createdAt: row.created_at ?? null,
    declaredRoleFamily: row.declared_role_family ?? null,
    id: String(row.id),
    missingAnswerKeys: row.missing_answer_keys ?? null,
    placements: (placements.get(String(row.id)) ?? []).map((placement) => ({
      areaCode: placement.areaCode,
      areaName: placement.areaName,
      regionCode: placement.regionCode,
      tab: placement.roleTab,
    })),
    source: row.source ?? null,
    status: row.status ?? null,
  }));
}

/**
 * The rows a fenced viewer may count. PURE. The Talent Acquisition seat never sees an HR applicant
 * (her manager's seat or her own), not even as a number in a summary — the same rule, by person, as
 * every screen (`personVisibleToViewer`).
 */
export function digestRowsVisibleTo(rows: readonly DailyCvDigestSourceRow[], hideHrPeople: boolean): DailyCvDigestSourceRow[] {
  if (!hideHrPeople) return [...rows];
  // The Talent Acquisition seat's own viewer — the one role the fence applies to.
  const viewer = workspaceViewer({ role: "HR Resourcing", scope: "company" });
  return rows.filter((row) =>
    personVisibleToViewer(viewer, {
      declaredRoleFamily: row.declaredRoleFamily,
      placementTabs: (row.placements ?? []).map((placement) => placement.tab),
    }),
  );
}

/** True only inside the one Cairo hour the digest is allowed to send in. Pure, so the gate is testable. */
export function isDailyCvDigestHour(hour: number): boolean {
  return hour === DAILY_CV_DIGEST_CAIRO_HOUR;
}

/** The same gate against a real instant — what the cron actually calls. */
export function isDailyCvDigestTime(now: Date = new Date()): boolean {
  return isDailyCvDigestHour(cairoHour(now));
}

/**
 * Builds today's digest from live data. Returns a digest with total 0 when nothing arrived.
 * `hideHrPeople` is the viewer's `workspaceViewer(access).hidesHrPeople`: the 18:00 notice goes to
 * the Super Admin only and passes nothing; Talent Acquisition's panel passes hers.
 */
export async function buildTodaysCvDigest(
  now: Date = new Date(),
  options: { hideHrPeople?: boolean } = {},
): Promise<DailyCvDigest> {
  const rows = await loadRecentCandidateDigestRows(now);
  return buildDailyCvDigest(digestRowsVisibleTo(rows, options.hideHrPeople === true), cairoDateKey(now));
}
