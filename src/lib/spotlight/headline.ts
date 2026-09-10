// Spotlight — the generated headline.
//
// Owner's decision: auto by default, editable before export. So this has one job — produce a
// headline that is already right often enough that the field is usually left alone.
//
// 🔴 IT NEVER GENDERS A TITLE. The sheet that started this module said "Man of the Month" because
// the owner wrote it for a specific man. Generated text cannot make that call: the module ranks
// medical reps of whom many are women, and a machine that prints "Man of the Month" over Fatma's
// name is a mistake with somebody's name on it, sent to the whole company. The generated form is
// therefore always the ROLE — "Medical Representative of the Month" — and the owner types the
// gendered version himself when he wants it, which is exactly what the override field is for.
//
// Pure. No clock, no database.

import type {
  SpotlightRankDirection,
  SpotlightRow,
  SpotlightSelection,
  SpotlightSubjectKind,
  SpotlightWindowKind,
} from "./types";

const SUBJECT_SINGULAR: Record<SpotlightSubjectKind, string> = {
  rep: "Medical Representative",
  dm: "District Manager",
  rsm: "Regional Manager",
  nsm: "National Sales Manager",
  area: "Territory",
  region: "District",
  line: "Line",
};

const SUBJECT_PLURAL: Record<SpotlightSubjectKind, string> = {
  rep: "Medical Representatives",
  dm: "District Managers",
  rsm: "Regional Managers",
  nsm: "National Sales Managers",
  area: "Territories",
  region: "Districts",
  line: "Lines",
};

const WINDOW_NOUN: Record<SpotlightWindowKind, string> = {
  month: "Month",
  quarter: "Quarter",
  semester: "Half",
};

/** "CNS", "CNS and Pedia", "CNS, Pedia and Anti Infective". Never a trailing comma, never an ellipsis. */
export function joinNames(names: string[]): string {
  const clean = names.filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0]!;
  return `${clean.slice(0, -1).join(", ")} and ${clean.at(-1)}`;
}

export type HeadlineContext = {
  selection: SpotlightSelection;
  rows: SpotlightRow[];
  windowLabel: string;
  lineNames: Map<string, string>;
  regionNames: Map<string, string>;
  areaNames: Map<string, string>;
};

/**
 * The headline.
 *
 * Three shapes, in the order they are checked:
 *
 *   ONE SUBJECT      → "Medical Representative of the Month"
 *   A NAMED PLACE    → "Giza District Managers"     (the owner's own comparison case: one region,
 *                       several lines — the place is the story, not the count)
 *   EVERYTHING ELSE  → "Top 10 Medical Representatives"
 */
export function buildHeadline(context: HeadlineContext): string {
  const { selection, rows, regionNames, areaNames } = context;
  const override = selection.headline?.trim();
  if (override) return override;

  const kind = selection.subject;
  const count = rows.length;

  if (count === 1) {
    return selection.direction === "bottom"
      ? `${SUBJECT_SINGULAR[kind]} Below Target`
      : `${SUBJECT_SINGULAR[kind]} of the ${WINDOW_NOUN[selection.window.kind]}`;
  }

  const regions = selection.filters.regions ?? [];
  const areas = selection.filters.areas ?? [];
  const place = areas.length === 1
    ? areaNames.get(areas[0]!) ?? areas[0]!
    : regions.length === 1
      ? regionNames.get(regions[0]!) ?? regions[0]!
      : null;

  if (place) return `${place} ${SUBJECT_PLURAL[kind]}`;

  const lead = selection.direction === "bottom" ? "Bottom" : "Top";
  return selection.limit && selection.limit > 0
    ? `${lead} ${count} ${SUBJECT_PLURAL[kind]}`
    : SUBJECT_PLURAL[kind];
}

/** The line under it: the window, the scope it was drawn from, and what ordered it. */
export function buildSubheadline(context: HeadlineContext): string {
  const { selection, rows, windowLabel, lineNames, regionNames } = context;
  const override = selection.subheadline?.trim();
  if (override) return override;

  const parts: string[] = [windowLabel];

  const lines = selection.filters.lines ?? [];
  if (lines.length > 0 && lines.length < 3) {
    parts.push(joinNames(lines.map((code) => lineNames.get(code) ?? code)));
  } else if (rows.length > 0 && rows.every((row) => row.lineName && row.lineName === rows[0]!.lineName)) {
    parts.push(rows[0]!.lineName!);
  } else {
    parts.push("All lines");
  }

  const regions = selection.filters.regions ?? [];
  if (regions.length > 0 && regions.length <= 3) {
    parts.push(joinNames(regions.map((code) => regionNames.get(code) ?? code)));
  }

  parts.push(selection.rankBy === "achievement" ? "Ranked by achievement" : "Ranked by sales value");
  return parts.join("  ·  ");
}

/** A short, safe file name. No spaces, no punctuation a filesystem or a chat client will mangle. */
export function exportFileName(headline: string, windowLabel: string, direction: SpotlightRankDirection): string {
  const slug = (value: string) =>
    value.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
  const parts = ["Sato-Spotlight", slug(headline), slug(windowLabel)];
  if (direction === "bottom") parts.push("below-target");
  return `${parts.filter(Boolean).join("-")}.pdf`;
}
