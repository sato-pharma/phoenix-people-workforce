// Who is told what when a targets workbook is committed (owner request, 2026-10-14) — the PURE half.
//
// This file groups the uploaded rows into TEAMS, resolves each team's recipients from plain
// organogram rows, and shapes the table as data. It reads nothing and sends nothing, so the whole
// "who is told what" decision is testable without a database; targets-uploaded-notification.ts
// loads the organogram, renders the zebra table and sends. The split is also what keeps this
// testable at all: the test runner substitutes a stub for the email layout (a .tsx it cannot
// import), and a module that rendered the table itself could not be loaded there.
//
// A TEAM is the reps who share a District Manager seat (the area map's `dm_seat_id`). That is the
// audience his example describes — "Omar 500 Lacto, Esraa 600 Lacto, and so on" — and the narrowest
// one that still lets a rep see the people he works beside: a whole-line table would show a rep in
// Alexandria the targets of every rep in Aswan, which no screen in the portal does.
//
// UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED (owner rule 2026-08-27). The grid carries one row per
// rep, area and product with its own units, and the only total is the team's target VALUE.

import { createHash } from "node:crypto";

import { canonicalHrIdKey } from "@/lib/hr-id";
import { getMergedAreaName } from "@/lib/sales/closing-area-merges";
import { lineName, type ResolvedTargetRow } from "@/lib/sales/monthly-targets";
import { isSalesNotificationExcluded } from "@/lib/sales/sales-notification-exclusions";

// ── The organogram, as plain rows ───────────────────────────────────────────────

export type TargetSeat = {
  seatId: string;
  parentSeatId: string | null;
  /** DM, ACTING_DM, RSM, NSM, REP, … (upper case). */
  tier: string;
  occupantHrId: string | null;
};

export type TargetAreaMapRow = {
  lineCode: string;
  areaCode: string;
  areaName: string | null;
  dmSeatId: string | null;
  repSeatId: string | null;
  /** YYYY-MM-DD. */
  effectiveFrom: string | null;
  /** YYYY-MM-DD, exclusive. Null while the row is open. */
  effectiveTo: string | null;
};

export type TargetPerson = {
  hrId: string;
  name: string;
  email: string | null;
  active: boolean;
};

export type TargetDirectory = {
  seats: TargetSeat[];
  areaMap: TargetAreaMapRow[];
  people: TargetPerson[];
  productNames: Map<string, string>;
};

/** One line of a team's table. */
export type TargetTeamRow = {
  period: string;
  repName: string;
  repHrId: string | null;
  areaName: string;
  productName: string;
  units: number | null;
  value: number | null;
};

export type TargetTeam = {
  lineCode: string;
  /** The District Manager seat the reps report to; null when the area map names none. */
  managerSeatId: string | null;
  periods: string[];
  rows: TargetTeamRow[];
  /** HR ids of the people the table is about (seated reps), in table order. */
  repHrIds: string[];
  /** HR ids of the manager chain above them: DM, RSM, NSM. */
  managerHrIds: string[];
};

/** Named by the owner (2026-10-14: "and of course cc the omar.anwar"), copied on every team's email whatever the seats say. */
export const NAMED_CC_HR_IDS = ["B-10"] as const; // Omar Anwar (Super Admin)

const MANAGER_CHAIN_TIERS = new Set(["RSM", "NSM"]);
const MAX_CHAIN_DEPTH = 8;

function upper(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

export function dateOnly(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 10) : null;
}

/** The last calendar day of a YYYY-MM period. */
export function periodEndDate(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10);
}

/**
 * The area-map row in force at the end of the month, else the open row. The same fallback the
 * attribution engine uses, so a target is routed to the seat that is answerable for the area.
 */
export function pickAreaMapRow(candidates: TargetAreaMapRow[], period: string): TargetAreaMapRow | null {
  if (candidates.length === 0) return null;
  const asOf = periodEndDate(period);
  const inForce = candidates
    .filter((row) => {
      const from = dateOnly(row.effectiveFrom);
      const to = dateOnly(row.effectiveTo);
      return (!from || from <= asOf) && (!to || to > asOf);
    })
    .sort((left, right) => String(dateOnly(right.effectiveFrom) ?? "").localeCompare(String(dateOnly(left.effectiveFrom) ?? "")));
  if (inForce.length > 0) return inForce[0]!;
  return candidates.find((row) => !dateOnly(row.effectiveTo)) ?? candidates[0]!;
}

/** The RSM and NSM seats above a seat, nearest first. Bounded, so a malformed loop cannot hang. */
export function managersAbove(seatId: string | null, seats: Map<string, TargetSeat>): TargetSeat[] {
  const found: TargetSeat[] = [];
  const visited = new Set<string>();
  let current = seatId ? seats.get(seatId) : undefined;
  for (let depth = 0; current && depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (visited.has(current.seatId)) break;
    visited.add(current.seatId);
    if (MANAGER_CHAIN_TIERS.has(upper(current.tier))) found.push(current);
    current = current.parentSeatId ? seats.get(current.parentSeatId) : undefined;
  }
  return found;
}

/**
 * Group the uploaded rows into TEAMS — one per (line, District Manager seat) — and resolve who is
 * in each. A row whose line and area no organogram row names reaches nobody and is returned as
 * `unplaced` so the caller can count it.
 */
export function buildTargetTeams(input: {
  rows: ResolvedTargetRow[];
  directory: TargetDirectory;
}): { teams: TargetTeam[]; unplaced: ResolvedTargetRow[] } {
  const { rows, directory } = input;
  const seatById = new Map(directory.seats.map((seat) => [seat.seatId, seat] as const));
  const personByKey = new Map<string, TargetPerson>();
  for (const person of directory.people) {
    const key = canonicalHrIdKey(person.hrId);
    if (key) personByKey.set(key, person);
  }
  const mapByCell = new Map<string, TargetAreaMapRow[]>();
  for (const row of directory.areaMap) {
    const key = `${row.lineCode}|${upper(row.areaCode)}`;
    const bucket = mapByCell.get(key) ?? [];
    bucket.push(row);
    mapByCell.set(key, bucket);
  }

  const occupantOf = (seatId: string | null): string | null => {
    const seat = seatId ? seatById.get(seatId) : undefined;
    const hrId = String(seat?.occupantHrId ?? "").trim();
    return hrId || null;
  };
  const nameOf = (hrId: string | null): string => {
    if (!hrId) return "Vacant seat";
    return personByKey.get(canonicalHrIdKey(hrId) ?? "")?.name ?? "Vacant seat";
  };

  type Draft = { team: TargetTeam; repSeen: Set<string> };
  const drafts = new Map<string, Draft>();
  const unplaced: ResolvedTargetRow[] = [];

  for (const row of rows) {
    const mapRow = pickAreaMapRow(mapByCell.get(`${row.line_code}|${upper(row.area_code)}`) ?? [], row.period);
    if (!mapRow) {
      unplaced.push(row);
      continue;
    }
    const repSeat = mapRow.repSeatId ? seatById.get(mapRow.repSeatId) : undefined;
    const managerSeatId = mapRow.dmSeatId ?? repSeat?.parentSeatId ?? null;
    const draftKey = `${row.line_code}|${managerSeatId ?? "none"}`;
    let draft = drafts.get(draftKey);
    if (!draft) {
      const dmHrId = occupantOf(managerSeatId);
      const above = managersAbove(managerSeatId, seatById)
        .map((seat) => String(seat.occupantHrId ?? "").trim())
        .filter(Boolean);
      draft = {
        repSeen: new Set<string>(),
        team: {
          lineCode: row.line_code,
          managerSeatId,
          periods: [],
          rows: [],
          repHrIds: [],
          managerHrIds: [...(dmHrId ? [dmHrId] : []), ...above],
        },
      };
      drafts.set(draftKey, draft);
    }

    const repHrId = occupantOf(mapRow.repSeatId);
    if (repHrId) {
      const repKey = canonicalHrIdKey(repHrId) ?? repHrId;
      if (!draft.repSeen.has(repKey)) {
        draft.repSeen.add(repKey);
        draft.team.repHrIds.push(repHrId);
      }
    }
    if (!draft.team.periods.includes(row.period)) draft.team.periods.push(row.period);

    const productCode = upper(row.product_code);
    draft.team.rows.push({
      period: row.period,
      repName: nameOf(repHrId),
      repHrId,
      areaName:
        getMergedAreaName(row.line_code, row.area_code, row.period)
        || String(mapRow.areaName ?? "").trim()
        || row.area_code,
      productName: directory.productNames.get(productCode) ?? productCode,
      units: row.target_units,
      value: row.target_value,
    });
  }

  const teams = [...drafts.values()].map(({ team }) => {
    team.periods.sort();
    team.rows.sort(
      (left, right) =>
        left.period.localeCompare(right.period)
        || left.repName.localeCompare(right.repName)
        || left.areaName.localeCompare(right.areaName)
        || left.productName.localeCompare(right.productName),
    );
    return team;
  });
  teams.sort(
    (left, right) =>
      left.lineCode.localeCompare(right.lineCode)
      || (left.rows[0]?.repName ?? "").localeCompare(right.rows[0]?.repName ?? ""),
  );
  return { teams, unplaced };
}

// ── The table, as data ──────────────────────────────────────────────────────────

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatTargetNumber(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "" : numberFormat.format(value);
}

function periodLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function periodsLabel(periods: string[]): string {
  const sorted = [...periods].sort();
  if (sorted.length === 0) return "";
  if (sorted.length === 1) return periodLabel(sorted[0]!);
  return `${periodLabel(sorted[0]!)} – ${periodLabel(sorted[sorted.length - 1]!)}`;
}

/** The team's target VALUE — the only figure that may span products. Null when no row carries one. */
export function teamTotalValue(team: TargetTeam): number | null {
  const values = team.rows.map((row) => row.value).filter((value): value is number => value != null && Number.isFinite(value));
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

export type TargetsGrid = {
  columns: Array<{ label: string; align?: "left" | "right" }>;
  rows: string[][];
};

/**
 * The columns and cells of the zebra table: one row per rep, area and product, each with its own
 * units and value. A Month column appears only when the file spans more than one month.
 */
export function buildTargetsGrid(team: TargetTeam): TargetsGrid {
  const withMonth = team.periods.length > 1;
  return {
    columns: [
      ...(withMonth ? [{ label: "Month" }] : []),
      { label: "Medical Rep" },
      { label: "Area" },
      { label: "Product" },
      { label: "Target units", align: "right" as const },
      { label: "Target value (EGP)", align: "right" as const },
    ],
    rows: team.rows.map((row) => [
      ...(withMonth ? [periodLabel(row.period)] : []),
      row.repName,
      row.areaName,
      row.productName,
      formatTargetNumber(row.units),
      formatTargetNumber(row.value),
    ]),
  };
}

/** Stable fingerprint of what a team is told, so the same file uploaded twice is one email. */
export function teamFingerprint(team: TargetTeam): string {
  const payload = team.rows.map((row) => [row.period, row.repName, row.areaName, row.productName, row.units, row.value]);
  return createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

// ── The people ──────────────────────────────────────────────────────────────────

export type TargetRecipient = { hrId: string; name: string; email: string };

/**
 * To = the reps in the table; Cc = the manager chain above them. A team whose reps all lack an
 * address still reaches its managers — as the To rather than a lone Cc — so a team is never
 * silently uninformed because a seat is vacant or an address is missing. A vacant seat, an
 * inactive employee, a person with no work email and the shared sales exclusion list are skipped,
 * never rendered as a blank row.
 */
export function resolveTeamRecipients(
  team: TargetTeam,
  people: TargetPerson[],
): { to: TargetRecipient[]; cc: TargetRecipient[]; warnings: string[] } {
  const warnings: string[] = [];
  const personByKey = new Map<string, TargetPerson>();
  for (const person of people) {
    const key = canonicalHrIdKey(person.hrId);
    if (key) personByKey.set(key, person);
  }
  const seen = new Set<string>();
  const collect = (hrIds: string[], context: string): TargetRecipient[] => {
    const bucket: TargetRecipient[] = [];
    for (const hrId of hrIds) {
      const key = canonicalHrIdKey(hrId);
      if (!key || seen.has(key) || isSalesNotificationExcluded(hrId)) continue;
      const person = personByKey.get(key);
      if (!person) continue;
      if (!person.active) {
        warnings.push(`${context}: ${person.name} is not active — skipped.`);
        continue;
      }
      const email = String(person.email ?? "").trim();
      if (!email) {
        warnings.push(`${context}: ${person.name} has no work email on file — skipped.`);
        continue;
      }
      seen.add(key);
      bucket.push({ hrId: person.hrId, name: person.name, email });
    }
    return bucket;
  };
  const reps = collect(team.repHrIds, `${lineName(team.lineCode)} rep`);
  const managers = collect(team.managerHrIds, `${lineName(team.lineCode)} manager`);
  const named = collect([...NAMED_CC_HR_IDS], "Named Cc");
  return reps.length > 0
    ? { to: reps, cc: [...managers, ...named], warnings }
    : { to: managers, cc: named, warnings };
}
