/**
 * The Needs You board, reduced to the five bands the page renders — PURE, and the owner of SECTION
 * ORDER.
 *
 * WHY THE ORDER LIVES HERE AND NOT IN THE COMPONENT. "Could not be read" is band ONE, above the work
 * itself, because this is a page the reader leaves after the first fold: an amber notice under a table
 * he has already stopped reading is an amber notice nobody sees. Putting the order in a pure module
 * means a test can assert it without a browser, so a later refactor that moves the amber band down
 * fails CI rather than quietly changing what the first fold says.
 *
 * It also owns every STRING the page prints, for two reasons. The ellipsis ban (AGENTS.md §4 — never
 * truncate text with an ellipsis, wrapping wins) is then checkable over data rather than over JSX;
 * and the empty-state sentence can be gated on `allClearProvable` in one place instead of in a
 * component that also happens to know `yours.length`.
 */
import { formatDateValue } from "../../i18n/format.ts";
import {
  needsYouHeadlineCount,
  NEEDS_YOU_ALL_CLEAR_SENTENCE,
  NEEDS_YOU_NOT_PROVEN_EMPTY_SENTENCE,
} from "../classify.ts";
import { needsYouDestinations, type NeedsYouBoard, type NeedsYouItem } from "../types.ts";

/** One row of the desktop table, and one card on mobile. The SAME four facts, never a subset. */
export type NeedsYouRow = {
  key: string;
  /** Column 1 — what needs you. */
  what: string;
  note: string | null;
  /** Column 2 — how many, with `overdueLabel` beneath it. `"—"` when the item is not a count. */
  howMany: string;
  overdueLabel: string | null;
  /** Column 3 — who, then since when. Names and a Cairo date, merged into one cell. */
  whoSince: string;
  /** Column 4 — where to do it. */
  whereLabel: string;
  href: `/${string}` | null;
  externalUrl: string | null;
};

export type NeedsYouSection =
  | {
      id: "not-proven";
      band: "notices";
      title: string;
      description: string;
      notices: readonly { key: string; label: string; because: string }[];
    }
  | {
      id: "yours" | "someone-else";
      band: "table";
      title: string;
      description: string;
      rows: readonly NeedsYouRow[];
      emptyLine: string;
    }
  | {
      id: "worth-knowing";
      band: "prose";
      title: string;
      description: string;
      lines: readonly { key: string; text: string; whereLabel: string; href: `/${string}` | null }[];
      emptyLine: string;
    }
  | {
      id: "every-source";
      band: "sources";
      title: string;
      description: string;
      rows: readonly { key: string; label: string; verdict: string; because: string | null }[];
    };

/**
 * How many names a cell prints before it says how many more there are.
 *
 * NOT a truncation. "and 14 more" is a sentence the reader can act on; an ellipsis is text the owner
 * has banned outright, and a bare list of ninety names is the same cell nobody reads. Where this
 * collides with the no-horizontal-scroll rule the names still WRAP — nothing here clips.
 */
const NAMES_SHOWN = 6;

function namesLine(people: readonly string[]): string | null {
  if (people.length === 0) return null;
  if (people.length <= NAMES_SHOWN) return people.join(", ");
  const shown = people.slice(0, NAMES_SHOWN).join(", ");
  return `${shown} and ${people.length - NAMES_SHOWN} more`;
}

function agePhrase(ageDays: number | null): string | null {
  if (ageDays === null || !Number.isFinite(ageDays) || ageDays < 0) return null;
  if (ageDays === 0) return "today";
  return `${ageDays} ${ageDays === 1 ? "day" : "days"}`;
}

/**
 * "Ahmed Samir, Mona Fathy · oldest 06 Sep 2026 · 12 days" — Cairo, never raw UTC.
 *
 * Several sources are COUNTS with no roster and no timestamp behind them (the direct-order badges are
 * counts by design, so the rows can ride a 30-second poll). Those read "Not recorded" rather than a
 * fabricated name or a today's-date stand-in: a date invented here would sort the row to the top of a
 * board whose sort key is age.
 */
function whoSinceLine(item: NeedsYouItem): string {
  const parts: string[] = [];
  const names = namesLine(item.people);
  if (names) parts.push(names);
  if (item.oldestAt) parts.push(`oldest ${formatDateValue(item.oldestAt, "en")}`);
  const age = agePhrase(item.ageDays);
  if (age) parts.push(age);
  return parts.length > 0 ? parts.join(" · ") : "Not recorded";
}

function toRow(item: NeedsYouItem): NeedsYouRow {
  const destination = needsYouDestinations[item.sourceId];
  return {
    key: item.key,
    what: item.label,
    note: item.note,
    // An em dash, not an ellipsis: `count: null` means "this is not a count", and there is no
    // unknown to encode — a source that could not be counted produced no item at all.
    howMany: item.count === null ? "—" : String(item.count),
    overdueLabel: item.overdue ? "Overdue" : null,
    whoSince: whoSinceLine(item),
    whereLabel: item.externalUrl ? "Open on GitHub" : `Open ${destination.screen}`,
    href: item.href,
    externalUrl: item.externalUrl,
  };
}

const SOURCE_VERDICTS = {
  ok: "Read",
  "not-applicable": "Not applicable",
  unavailable: "Could not be read",
} as const;

export function buildNeedsYouSections(board: NeedsYouBoard): NeedsYouSection[] {
  return [
    // ── 1. FIRST, above the work. See the header. ──────────────────────────────────────────────
    {
      id: "not-proven",
      band: "notices",
      title: "Could not be read",
      description:
        "One row per source that did not answer. Nothing below is a complete picture while a row sits here.",
      notices: board.notProven.map((entry) => ({ key: entry.id, label: entry.label, because: entry.because })),
    },
    {
      id: "yours",
      band: "table",
      title: "Needs you",
      description: "A decision only you make. Every row links to the screen that already owns it.",
      rows: board.yours.map(toRow),
      // The ONE gate. Never `board.yours.length === 0` — a board whose every source died also has an
      // empty `yours`, and printing the all-clear over that is the failure this module exists to stop.
      emptyLine: board.allClearProvable ? NEEDS_YOU_ALL_CLEAR_SENTENCE : NEEDS_YOU_NOT_PROVEN_EMPTY_SENTENCE,
    },
    {
      id: "someone-else",
      band: "table",
      title: "With someone else",
      description: "Moving, and not yours to move. Here so an abandoned queue is visible, never as work waiting on you.",
      rows: board.someoneElse.map(toRow),
      emptyLine: "Nothing is sitting with anyone else.",
    },
    {
      id: "worth-knowing",
      band: "prose",
      title: "Worth knowing",
      description: "State, not work. Read it, decide nothing.",
      lines: board.worthKnowing.map((item) => ({
        key: item.key,
        text: item.note ? `${item.label} — ${item.note}` : item.label,
        whereLabel: `Open ${needsYouDestinations[item.sourceId].screen}`,
        href: item.href,
      })),
      emptyLine: "Nothing to note.",
    },
    // ── 5. What makes a silently dropped source visible ON SCREEN, not only in a test. ──────────
    {
      id: "every-source",
      band: "sources",
      title: "Every source",
      description: "One row per source this board composes, whether or not it had anything to say.",
      rows: board.sources.map((source) => ({
        key: source.id,
        label: source.label,
        verdict: SOURCE_VERDICTS[source.status],
        because: source.because,
      })),
    },
  ];
}

/**
 * Every line the page prints, flattened.
 *
 * Exported for the ellipsis check and the empty-state assertion: scanning DATA is what makes those
 * two checks real rather than a grep over JSX that a template literal would walk straight past.
 */
export function needsYouSectionLines(sections: readonly NeedsYouSection[]): string[] {
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(section.title, section.description);
    if (section.band === "notices") {
      for (const notice of section.notices) lines.push(notice.label, notice.because);
      continue;
    }
    if (section.band === "table") {
      lines.push(section.emptyLine);
      for (const row of section.rows) {
        lines.push(row.what, row.howMany, row.whoSince, row.whereLabel);
        if (row.note) lines.push(row.note);
        if (row.overdueLabel) lines.push(row.overdueLabel);
      }
      continue;
    }
    if (section.band === "prose") {
      lines.push(section.emptyLine);
      for (const line of section.lines) lines.push(line.text, line.whereLabel);
      continue;
    }
    for (const row of section.rows) {
      lines.push(row.label, row.verdict);
      if (row.because) lines.push(row.because);
    }
  }
  return lines;
}

/** The page's own subtitle. One sentence, and it never claims a clean board it cannot prove. */
export function needsYouHeroDescription(board: NeedsYouBoard): string {
  // Through `needsYouHeadlineCount`, never `board.yours.length` inline: one place decides what the
  // headline counts, so a later lane cannot quietly start counting toward it on one surface only.
  const count = needsYouHeadlineCount(board);
  if (count === 0 && board.allClearProvable) return NEEDS_YOU_ALL_CLEAR_SENTENCE;
  if (count === 0) {
    return `${board.notProven.length} of ${board.sources.length} sources did not answer, so a clean board cannot be proven.`;
  }
  const waiting = `${count} ${count === 1 ? "thing is" : "things are"} waiting on a decision only you can make.`;
  if (board.notProven.length === 0) return waiting;
  return `${waiting} ${board.notProven.length} more ${board.notProven.length === 1 ? "source" : "sources"} did not answer.`;
}
