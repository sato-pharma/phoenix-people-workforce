/**
 * The HR Operations Specialist's landing page — the pure part: which figures stand where, what the
 * scoreboard divides, and who is arriving and leaving.
 *
 * NAMES, TITLES AND DATES ONLY. She is the seat that never sees a salary (isSalaryBlindRole), and the
 * two lists below are built from reads that carry more than she should be handed: a joiner holds a
 * mobile, an email and notes, and a resignation holds its settlement field. Each row is mapped down
 * to `TalentJoiner` here, so what reaches her browser cannot grow by accident.
 */

import {
  addDaysToKey,
  JOINERS_WINDOW_DAYS,
  kpi,
  type TalentJoiner,
  type TalentJoiners,
  type TalentKpi,
} from "@/lib/hr/talent-acquisition-logic";

export const HIRING_DOCUMENTS_HREF = "/hr/hiring-documents";
export const RESIGNATIONS_HREF = "/hr/resignations";
const REPORTS_HREF = "/hr/hr-reports";
const RECORD_GAPS_HREF = "/hr/employees/record-gaps";

/** The six figures on her page, in three labelled groups, the way the Talent Acquisition page has its own. */
export const HR_OPERATIONS_TILE_GROUPS = [
  {
    caption: "What is waiting on you",
    key: "review",
    label: "Review",
    tileKeys: ["hr-reports-to-review", "hr-reports-rows"],
  },
  {
    caption: "The Employee Master",
    key: "people",
    label: "People",
    tileKeys: ["headcount", "incomplete-records"],
  },
  {
    caption: "The cases you follow",
    key: "follow-ups",
    label: "Follow-ups",
    tileKeys: ["resignations-open", "contracts-active"],
  },
] as const;

export type HrOperationsTileGroup<T> = {
  caption: string;
  key: string;
  label: string;
  tiles: T[];
};

/**
 * Only the six this page chose; a group whose source did not load has no tiles and is left out, and
 * the notice at the top of the page names that source. Never a row of zeroes.
 */
export function groupHrOperationsTiles<T extends { key: string }>(tiles: readonly T[]): HrOperationsTileGroup<T>[] {
  return HR_OPERATIONS_TILE_GROUPS.map((group) => ({
    caption: group.caption,
    key: group.key,
    label: group.label,
    tiles: group.tileKeys.flatMap((key) => tiles.filter((tile) => tile.key === key)),
  })).filter((group) => group.tiles.length > 0);
}

/**
 * The three measures on the dark scoreboard. A source that did not load is null and its card is left
 * out; a source that loaded with nothing to divide by prints its sentence, never 0%.
 */
export function buildHrOperationsScoreboard(input: {
  /** People in the active Employee Master, and how many of them miss required data. */
  records: { active: number; incomplete: number } | null;
  /** Rows across the reports still with her. */
  reports: { reviewed: number; toReview: number } | null;
  /** Everyone due to join, and how many have had their papers confirmed. */
  joiners: { confirmed: number; total: number } | null;
}): TalentKpi[] {
  const cards: TalentKpi[] = [];
  if (input.reports) {
    cards.push(
      kpi({
        caption: "The rows you have answered, of every row needing an answer, across the reports still with you.",
        denominator: input.reports.reviewed + input.reports.toReview,
        denominatorLabel: "to answer",
        emptyLabel: "No report is waiting on you",
        href: REPORTS_HREF,
        hrefLabel: "Open Daily & Weekly Reports",
        key: "reports-answered",
        label: "Report rows answered",
        numerator: input.reports.reviewed,
        numeratorLabel: "answered",
      }),
    );
  }
  if (input.records) {
    cards.push(
      kpi({
        caption: "Active employees whose record holds all its required data.",
        denominator: input.records.active,
        denominatorLabel: "active",
        emptyLabel: "No active record to measure",
        href: RECORD_GAPS_HREF,
        hrefLabel: "Open Record Gaps",
        key: "records-complete",
        label: "Records complete",
        numerator: Math.max(0, input.records.active - input.records.incomplete),
        numeratorLabel: "complete",
      }),
    );
  }
  if (input.joiners) {
    cards.push(
      kpi({
        caption: "People due to join whose papers you have confirmed with them.",
        denominator: input.joiners.total,
        denominatorLabel: "due to join",
        emptyLabel: "Nobody is due to join",
        href: HIRING_DOCUMENTS_HREF,
        hrefLabel: "Open Hiring Documents",
        key: "papers-confirmed",
        label: "Joiners' papers confirmed",
        numerator: input.joiners.confirmed,
        numeratorLabel: "confirmed",
      }),
    );
  }
  return cards;
}

/** Every joiner with a joining day, for the month grid. A joiner with no day yet has no place on it. */
export function joinerMarks(
  joiners: readonly { name: string; offerId: string; startKey: string; title: string | null }[],
): TalentJoiner[] {
  return joiners
    .filter((joiner) => Boolean(joiner.startKey))
    .map((joiner) => ({
      dateKey: joiner.startKey,
      href: HIRING_DOCUMENTS_HREF,
      id: joiner.offerId,
      name: joiner.name,
      title: joiner.title ?? "",
    }));
}

function withinWindow(rows: TalentJoiner[] | null, todayKey: string, windowDays: number): TalentJoiners {
  const toKey = addDaysToKey(todayKey, windowDays);
  return {
    fromKey: todayKey,
    loaded: rows !== null,
    rows: (rows ?? []).filter((row) => row.dateKey >= todayKey && row.dateKey <= toKey),
    toKey,
  };
}

/** Who walks in within the fortnight. Null is a failed read: said on the panel, never "nobody". */
export function joinersDue(
  joiners: readonly TalentJoiner[] | null,
  todayKey: string,
  windowDays: number = JOINERS_WINDOW_DAYS,
): TalentJoiners {
  return withinWindow(joiners ? [...joiners] : null, todayKey, windowDays);
}

/** A resignation she still follows: a rejected or cancelled one is nobody leaving, a completed one has left. */
const OPEN_RESIGNATION_STATUSES: ReadonlySet<string> = new Set(["submitted", "under_review", "approved"]);

/** Whose last day falls within the fortnight. Name, title and date: the rest of the record stays on the server. */
export function peopleLeaving(
  records:
    | readonly {
        effectiveDate: string;
        employeeName: string;
        id: string;
        jobTitle: string | null;
        status: string;
      }[]
    | null,
  todayKey: string,
  windowDays: number = JOINERS_WINDOW_DAYS,
): TalentJoiners {
  return withinWindow(
    records
      ? records
          .filter((record) => OPEN_RESIGNATION_STATUSES.has(record.status) && Boolean(record.effectiveDate))
          .map((record) => ({
            dateKey: record.effectiveDate.slice(0, 10),
            href: RESIGNATIONS_HREF,
            id: record.id,
            name: record.employeeName,
            title: record.jobTitle ?? "",
          }))
      : null,
    todayKey,
    windowDays,
  );
}
