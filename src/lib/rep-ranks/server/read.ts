// Phoenix Ranks — what the pages read. Every answer is shaped HERE, on the server.
//
// 🔴 THE PORTAL NEVER RECEIVES THE METRICS. Owner, 2026-10-05: "Don't put metrics … the metrics keep
// in your back end or show it to the admin account. But for the reps, only accuracy score." A field a
// browser receives counts as shown even when nothing draws it (Phoenix CRM golden rule #1), so the
// portal query does not SELECT `metrics` at all — only the admin twin's does.

import { unstable_cache } from "next/cache";

import { REP_RANKS_CACHE_TAG } from "@/lib/dashboard/invalidation";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { EMPTY_QUALITY_FACTS } from "@/lib/rep-ranks/field-quality";
import { rankForScore, rollingScore, RANK_ROLLING_MONTHS, starCount, type MilitaryRank, type RankTitle } from "@/lib/rep-ranks/ladder";
import type { RankPillarScores, RankStanding, RankUnrankedReason } from "@/lib/rep-ranks/scoring";
import { isWindowClosed, windowLabelOf, type RankWindowKind } from "@/lib/rep-ranks/windows";

export type RankAudience = "portal" | "admin";

/** The raw counts behind one rep's scores — admin only. */
export type RankAdminMetrics = {
  owedDays: number;
  amVisits: number;
  pmVisits: number;
  fieldDays: number;
  listed: number | null;
  covered: number | null;
  coveragePct: number | null;
  frequencyPct: number | null;
  frequencyRequired: number | null;
  frequencyMet: number | null;
  planned: number;
  kept: number;
  medianStartMinutes: number | null;
  startDays: number;
  located: number;
  atPlace: number;
  // The deeper measures (scoring version 4). Optional: a row written by version 3 does not carry them.
  gapPairs?: number;
  gapMedianMinutes?: number | null;
  gapMedianWalkMinutes?: number | null;
  gapTooFast?: number;
  gapTooSlow?: number;
  doctorVisits?: number;
  productsDiscussed?: number;
  withNote?: number;
  gpsFixes?: number;
  gpsMedianMeters?: number | null;
  fieldSaves?: number;
  flaggedSaves?: number;
  /**
   * Strong cases against a PLACE this rep validated — the signboard and capture-trust detectors,
   * which file against no visit. Absent on a row written before 2026-10-12, when the Integrity pillar
   * counted visit cases only and those two detectors reached no score at all.
   */
  flaggedPlaces?: number;
  /** Which silent check flagged how many saves — the admin's detail, never a portal answer. */
  integrityFlags?: Record<string, number>;
};

export type RankBoardRow = {
  hrIdKey: string;
  repName: string;
  lineName: string | null;
  areaName: string | null;
  ranked: boolean;
  unrankedReason: RankUnrankedReason | null;
  companyPosition: number | null;
  companyCount: number;
  linePosition: number | null;
  lineCount: number;
  total: number | null;
  pillars: RankPillarScores;
  rank: MilitaryRank;
  rollingScore: number | null;
  stars: number;
  /** Admin twin only — absent on every portal answer. */
  metrics?: RankAdminMetrics;
};

export type RankWindowOption = { key: string; label: string; from: string; to: string; closed: boolean };

export type RankBoard = {
  kind: RankWindowKind;
  window: RankWindowOption | null;
  windows: RankWindowOption[];
  rows: RankBoardRow[];
  lines: string[];
  computedAt: string | null;
};

type StandingRecord = {
  window_kind: RankWindowKind;
  window_key: string;
  hr_id_key: string;
  window_from: string;
  window_to: string;
  rep_name: string;
  line_name: string | null;
  area_name: string | null;
  ranked: boolean;
  unranked_reason: RankUnrankedReason | null;
  company_position: number | null;
  company_count: number | null;
  line_position: number | null;
  line_count: number | null;
  total_score: number | string | null;
  pillars: RankPillarScores;
  metrics?: RankAdminMetrics;
  computed_at: string;
};

const PORTAL_COLUMNS =
  "window_kind, window_key, hr_id_key, window_from, window_to, rep_name, line_name, area_name, ranked, unranked_reason, " +
  "company_position, company_count, line_position, line_count, total_score, pillars, computed_at";
const ADMIN_COLUMNS = `${PORTAL_COLUMNS}, metrics`;

const PAGE = 1000;

function db() {
  return getSupabaseAdmin();
}

const num = (value: number | string | null | undefined): number | null =>
  value === null || value === undefined || value === "" ? null : Number(value);

/**
 * The windows of one kind that have been computed, newest first. Read through each window's #1 row —
 * exactly one per window that ranked anybody — because a plain read of the kind holds one row per rep
 * per window and PostgREST would stop it, silently, ten days into the day board.
 */
async function windowOptions(kind: RankWindowKind): Promise<RankWindowOption[]> {
  const { data, error } = await db()
    .from("rep_rank_standings")
    .select("window_key, window_from, window_to")
    .eq("window_kind", kind)
    .eq("company_position", 1)
    .order("window_from", { ascending: false })
    .limit(400);
  if (error) throw error;
  const seen = new Map<string, RankWindowOption>();
  for (const row of (data ?? []) as { window_key: string; window_from: string; window_to: string }[]) {
    if (seen.has(row.window_key)) continue;
    seen.set(row.window_key, {
      key: row.window_key,
      label: windowLabelOf(kind, row.window_from),
      from: row.window_from,
      to: row.window_to,
      closed: isWindowClosed(kind, row.window_from, row.window_to),
    });
  }
  return [...seen.values()].slice(0, kind === "day" ? 30 : 24);
}

/** Every #1 in a CLOSED window, per rep — the stars and the medals. */
export async function loadTitles(): Promise<Map<string, RankTitle[]>> {
  const titles = new Map<string, RankTitle[]>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db()
      .from("rep_rank_standings")
      .select("window_kind, window_key, hr_id_key, window_from, window_to, company_position, line_position")
      .eq("ranked", true)
      .or("company_position.eq.1,line_position.eq.1")
      .order("window_from", { ascending: true })
      .order("window_kind", { ascending: true })
      .order("hr_id_key", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Pick<
      StandingRecord,
      "window_kind" | "window_key" | "hr_id_key" | "window_from" | "window_to" | "company_position" | "line_position"
    >[];
    for (const row of rows) {
      if (!isWindowClosed(row.window_kind, row.window_from, row.window_to)) continue;
      const list = titles.get(row.hr_id_key) ?? [];
      list.push({
        windowKind: row.window_kind,
        windowKey: row.window_key,
        windowLabel: windowLabelOf(row.window_kind, row.window_from),
        scope: row.company_position === 1 ? "company" : "line",
      });
      titles.set(row.hr_id_key, list);
    }
    if (rows.length < PAGE) break;
  }
  return titles;
}

/** Each rep's rolling score from the newest three month windows. */
async function loadRollingScores(): Promise<Map<string, number | null>> {
  const months = (await windowOptions("month")).slice(0, RANK_ROLLING_MONTHS).map((option) => option.key);
  const byRep = new Map<string, { from: string; total: number | null }[]>();
  if (months.length > 0) {
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await db()
        .from("rep_rank_standings")
        .select("hr_id_key, window_from, total_score")
        .eq("window_kind", "month")
        .in("window_key", months)
        .order("hr_id_key", { ascending: true })
        .order("window_from", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      const rows = (data ?? []) as { hr_id_key: string; window_from: string; total_score: number | string | null }[];
      for (const row of rows) {
        const list = byRep.get(row.hr_id_key) ?? [];
        list.push({ from: row.window_from, total: num(row.total_score) });
        byRep.set(row.hr_id_key, list);
      }
      if (rows.length < PAGE) break;
    }
  }
  const scores = new Map<string, number | null>();
  for (const [key, list] of byRep) {
    scores.set(key, rollingScore([...list].sort((a, b) => b.from.localeCompare(a.from)).map((entry) => entry.total)));
  }
  return scores;
}

function toRow(
  record: StandingRecord,
  rolling: Map<string, number | null>,
  titles: Map<string, RankTitle[]>,
  audience: RankAudience,
): RankBoardRow {
  const score = rolling.get(record.hr_id_key) ?? null;
  const row: RankBoardRow = {
    hrIdKey: record.hr_id_key,
    repName: record.rep_name,
    lineName: record.line_name,
    areaName: record.area_name,
    ranked: record.ranked,
    unrankedReason: record.unranked_reason,
    companyPosition: record.company_position,
    companyCount: record.company_count ?? 0,
    linePosition: record.line_position,
    lineCount: record.line_count ?? 0,
    total: num(record.total_score),
    pillars: record.pillars,
    rank: rankForScore(score),
    rollingScore: score,
    stars: starCount(titles.get(record.hr_id_key) ?? []),
  };
  if (audience === "admin" && record.metrics) row.metrics = record.metrics;
  return row;
}

/**
 * How long a board or a profile is remembered (2 Nov 2026, the speed root cause, Stage 2). The standings
 * change only when the nightly compute writes them, and that writer drops REP_RANKS_CACHE_TAG when it
 * finishes (compute.ts rebuildWindows), so the hour is a backstop, never the freshness.
 */
const RANK_READ_TTL_SECONDS = 3600;

/**
 * One window's board. `windowKey` absent → the newest computed window of that kind. Remembered per kind,
 * window and AUDIENCE — the admin twin's rows carry the metrics and the portal's never do, so the two
 * never share an entry.
 */
export async function loadRankBoard(input: {
  kind: RankWindowKind;
  windowKey?: string | null;
  audience: RankAudience;
}): Promise<RankBoard> {
  return unstable_cache(() => readRankBoard(input), ["rep-ranks-board", input.kind, input.windowKey ?? "-", input.audience], {
    revalidate: RANK_READ_TTL_SECONDS,
    tags: [REP_RANKS_CACHE_TAG],
  })();
}

async function readRankBoard(input: { kind: RankWindowKind; windowKey?: string | null; audience: RankAudience }): Promise<RankBoard> {
  const windows = await windowOptions(input.kind);
  const window = windows.find((option) => option.key === input.windowKey) ?? windows[0] ?? null;
  if (!window) return { kind: input.kind, window: null, windows, rows: [], lines: [], computedAt: null };

  const [records, rolling, titles] = await Promise.all([
    (async () => {
      const all: StandingRecord[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await db()
          .from("rep_rank_standings")
          .select(input.audience === "admin" ? ADMIN_COLUMNS : PORTAL_COLUMNS)
          .eq("window_kind", input.kind)
          .eq("window_key", window.key)
          .order("hr_id_key", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        const rows = (data ?? []) as unknown as StandingRecord[];
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      return all;
    })(),
    loadRollingScores(),
    loadTitles(),
  ]);

  const rows = records
    .map((record) => toRow(record, rolling, titles, input.audience))
    .sort((a, b) => {
      if (a.ranked !== b.ranked) return a.ranked ? -1 : 1;
      if (a.ranked && b.ranked) return (a.companyPosition ?? 0) - (b.companyPosition ?? 0);
      return a.repName.localeCompare(b.repName);
    });
  const lines = [...new Set(rows.map((row) => row.lineName).filter((line): line is string => Boolean(line)))].sort();
  const computedAt = records.reduce<string | null>((latest, record) => (!latest || record.computed_at > latest ? record.computed_at : latest), null);
  return { kind: input.kind, window, windows, rows, lines, computedAt };
}

/** The `RankStanding` shape `explainStanding` reads, from the board's rows. */
export function standingsOf(rows: readonly RankBoardRow[]): RankStanding[] {
  return rows.map((row) => ({
    hrIdKey: row.hrIdKey,
    repName: row.repName,
    lineName: row.lineName,
    areaName: row.areaName,
    regionName: null,
    pillars: row.pillars,
    total: row.total,
    ranked: row.ranked,
    unrankedReason: row.unrankedReason,
    companyPosition: row.companyPosition,
    companyCount: row.companyCount,
    linePosition: row.linePosition,
    lineCount: row.lineCount,
    facts: {
      hrIdKey: row.hrIdKey,
      repName: row.repName,
      lineName: row.lineName,
      areaName: row.areaName,
      regionName: null,
      // The browser never receives the counts, so the explanation works from the scores alone.
      owedDays: 0,
      targets: { am: 0, pm: 0 },
      amVisits: 0,
      pmVisits: 0,
      fieldDays: 0,
      coverage: null,
      frequency: null,
      plan: { planned: 0, kept: 0 },
      start: { medianMinutes: null, days: 0, scoreSum: 0 },
      accuracy: { located: 0, atPlace: 0 },
      quality: EMPTY_QUALITY_FACTS,
    },
  }));
}

export type RankTimelineEntry = {
  kind: RankWindowKind;
  key: string;
  label: string;
  from: string;
  closed: boolean;
  ranked: boolean;
  companyPosition: number | null;
  companyCount: number;
  linePosition: number | null;
  lineCount: number;
  total: number | null;
};

export type RankProfile = {
  hrIdKey: string;
  repName: string;
  lineName: string | null;
  areaName: string | null;
  rank: MilitaryRank;
  rollingScore: number | null;
  titles: RankTitle[];
  stars: number;
  /** Newest first, per kind. */
  timeline: Record<RankWindowKind, RankTimelineEntry[]>;
  /** The rank each closed month earned on its own month's score, newest first — the promotion trail. */
  monthTrail: { label: string; total: number | null; rank: MilitaryRank }[];
};

/** One rep's profile: rank, stars, titles and the whole timeline. Scores only — never metrics. Remembered per rep. */
export async function loadRankProfile(hrId: string): Promise<RankProfile | null> {
  const key = normalizeHrIdForAccess(hrId);
  if (!key) return null;
  return unstable_cache(() => readRankProfile(key), ["rep-ranks-profile", key], { revalidate: RANK_READ_TTL_SECONDS, tags: [REP_RANKS_CACHE_TAG] })();
}

async function readRankProfile(key: string): Promise<RankProfile | null> {
  const { data, error } = await db()
    .from("rep_rank_standings")
    .select(PORTAL_COLUMNS)
    .eq("hr_id_key", key)
    .order("window_from", { ascending: false })
    .limit(1000);
  if (error) throw error;
  const records = (data ?? []) as unknown as StandingRecord[];
  if (records.length === 0) return null;

  const [rolling, titles] = await Promise.all([loadRollingScores(), loadTitles()]);
  const latest = records[0];
  const timeline: Record<RankWindowKind, RankTimelineEntry[]> = { day: [], week: [], month: [], quarter: [], semester: [] };
  for (const record of records) {
    timeline[record.window_kind].push({
      kind: record.window_kind,
      key: record.window_key,
      label: windowLabelOf(record.window_kind, record.window_from),
      from: record.window_from,
      closed: isWindowClosed(record.window_kind, record.window_from, record.window_to),
      ranked: record.ranked,
      companyPosition: record.company_position,
      companyCount: record.company_count ?? 0,
      linePosition: record.line_position,
      lineCount: record.line_count ?? 0,
      total: num(record.total_score),
    });
  }
  const repTitles = [...(titles.get(key) ?? [])].reverse();
  const score = rolling.get(key) ?? null;
  return {
    hrIdKey: key,
    repName: latest.rep_name,
    lineName: latest.line_name,
    areaName: latest.area_name,
    rank: rankForScore(score),
    rollingScore: score,
    titles: repTitles,
    stars: starCount(repTitles),
    timeline,
    monthTrail: timeline.month.map((entry) => ({ label: entry.label, total: entry.total, rank: rankForScore(entry.total) })),
  };
}
