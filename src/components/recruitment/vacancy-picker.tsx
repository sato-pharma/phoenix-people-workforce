"use client";

// Recruitment / ATS — choosing the position a CV is being sent FOR.
//
// Same treatment as the manager picker directly below it, and for the same measured reason. The
// owner, 2026-08-31: *"consider grouping the open vacancies as you make with the send to manager …
// I tell you a thing. You should implement it everywhere if needed and if applicable."*
//
// So the grouping is HIS, and it is the same two levels: JOB TITLE, then LINE. Measured in
// production 2026-08-31 there are 45 open vacancies — 43 Medical Representative (16 Anti Infective,
// 9 CNS, 18 Pedia) and 2 District Sales Manager (both Pedia) — spread over 34 areas.
//
// THE TWO DISTRICT MANAGER SEATS ARE WHY THIS MATTERS, and they are not hypothetical. Behira 1 ·
// Pedia carries BOTH an open Medical Representative seat and an open District Sales Manager seat.
// In the flat list this replaces, those two rows read:
//
//     Behira 1  |  Alex-BHR · Hany Saad
//     Behira 1  |  Alex-BHR · Hany Saad        <- a different SEAT, every visible word identical
//
// I read that as a duplicated row myself before checking the table. Sending a district manager's CV
// to the rep vacancy files it under the wrong seat, and nothing downstream can tell. With the title
// as a heading the two sit in different groups and cannot be confused.
//
// It is also unsearchable as a native select: a native dropdown's type-ahead matches the START of
// the label, so "Tanta" finds nothing when the label begins with the job title.
//
// SINGLE-select, unlike the manager picker. A CV is sent for ONE position — that is what the
// manager's inbox folds on — while it may reasonably go to several people.

import { Briefcase } from "lucide-react";

import { GroupedComboBox, type ComboItem } from "@/components/ui/grouped-combobox";

/**
 * What this picker needs to know about one open seat.
 *
 * Structurally typed rather than importing `VacancyOption`, exactly as the manager picker is:
 * `vacancy-options.ts` reaches the service-role client, and naming its type here would drag that
 * module into this "use client" bundle.
 */
export type VacancyPickerOption = {
  id: number;
  jobTitle: string;
  areaName: string | null;
  regionName: string | null;
  lineName: string | null;
  managerName: string | null;
};

/** The recruiter is typing a position that is not an open seat yet. */
export const FREE_POSITION = "free:";
/**
 * The recruiter is explicitly saying "no position", as opposed to not having chosen.
 *
 * These have to be two different values. With "" meaning both "untouched" and "none", choosing the
 * blank option handed the suggestion straight back and there was no way to refuse it.
 */
export const NO_POSITION = "none:";

/** First of these that actually holds text. */
function firstText(...values: ReadonlyArray<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) return trimmed;
  }
  return null;
}

export function VacancyPicker({
  disabled = false,
  offerNoPosition = false,
  onChange,
  panelId = "vacancy-picker-panel",
  suggestedIds = [],
  suggestionLabel = "Looks like this one",
  vacancies,
  value,
}: {
  disabled?: boolean;
  /**
   * Whether to offer "No position — send without one".
   *
   * Only worth a row when something has been suggested: with an empty picker there is nothing to
   * refuse, and the option would read as a second way of doing what leaving it alone already does.
   * Off for the pool, which suggests nothing.
   */
  offerNoPosition?: boolean;
  onChange: (value: string) => void;
  /** Unique per picker ON SCREEN — the pool can show a row's panel and the bulk bar's at once. */
  panelId?: string;
  /** The seats this CV looks like it is for. Shown FIRST, under their own heading. */
  suggestedIds?: number[];
  /** "Looks like this one" / "Looks like one of these" — never named as a machine's opinion. */
  suggestionLabel?: string;
  vacancies: VacancyPickerOption[];
  /** A vacancy id as a string, or FREE_POSITION, or NO_POSITION, or "" for untouched. */
  value: string;
}) {
  const suggested = new Set(suggestedIds.map((id) => String(id)));

  /** The heading a seat sits under. Never blank — an untitled row would open an unnamed group. */
  const titleOf = (vacancy: VacancyPickerOption): string => firstText(vacancy.jobTitle) ?? "Open vacancy";

  /**
   * The AREA is the name, because that is what a person picks by — 45 vacancies across 34 areas, so
   * the area is very nearly a unique key while the job title is one of two values. The title and the
   * line are the headings above it, so neither is repeated on the row.
   *
   * The manager is on the second line because picking a vacancy PRE-SELECTS them: it is the actual
   * consequence of this choice, and seeing it here is what stops a CV going somewhere nobody is
   * looking.
   */
  const toItem = (vacancy: VacancyPickerOption, group: string): ComboItem => ({
    group,
    id: String(vacancy.id),
    // A seat with no area says so. One of the 45 is in that state — SEAT-AIF-REP-AB4, an Anti
    // Infective rep seat in Alex-BHR, open since 6 July 2026 with `area_id` null — and falling back
    // to the job title gave it the same words as the heading it sits under: a row reading "Medical
    // Representative" inside the group "Medical Representative". Naming the gap is honest, keeps the
    // row distinguishable from its neighbours, and is the only place a recruiter would ever notice
    // it. The caller already sorts area-less seats to the end, so it sits at the foot of its line.
    name: firstText(vacancy.areaName) ?? "No area on this seat",
    search: [vacancy.jobTitle, vacancy.regionName, vacancy.lineName, vacancy.managerName].filter(Boolean).join(" "),
    secondary: firstText(
      [vacancy.regionName, vacancy.managerName].filter(Boolean).join(" · "),
      vacancy.jobTitle,
    ),
    // A suggested seat keeps its line as a sub-heading only inside the main list; under the
    // suggestion heading there are at most three of them and sub-headings would outnumber rows.
    subgroup: group === suggestionLabel ? null : vacancy.lineName,
  });

  const rest = vacancies.filter((vacancy) => !suggested.has(String(vacancy.id)));

  /**
   * Biggest title first, then alphabetically.
   *
   * `GroupedComboBox` renders groups in first-seen order, so something has to decide it, and the
   * caller's order cannot: `listOpenVacancyOptions` sorts by AREA, so whichever title happens to own
   * the alphabetically-first area would lead — "Behira 1" today, something else after one hire.
   * Sorting by size puts the 43 rep seats where a recruiter is looking 43 times out of 45, and keeps
   * the order stable as areas come and go. The sort is stable, so the caller's area-then-line order
   * survives untouched inside each group.
   */
  const countByTitle = new Map<string, number>();
  for (const vacancy of rest) countByTitle.set(titleOf(vacancy), (countByTitle.get(titleOf(vacancy)) ?? 0) + 1);
  const ordered = [...rest].sort(
    (left, right) =>
      (countByTitle.get(titleOf(right)) ?? 0) - (countByTitle.get(titleOf(left)) ?? 0) ||
      titleOf(left).localeCompare(titleOf(right)),
  );

  const items: ComboItem[] = [
    // Offered first and never duplicated further down. Showing the same seat twice would put two
    // rows with one identity in one list — both would tick together, and the second would read as a
    // different vacancy that happens to share every word.
    ...vacancies.filter((vacancy) => suggested.has(String(vacancy.id))).map((vacancy) => toItem(vacancy, suggestionLabel)),
    ...ordered.map((vacancy) => toItem(vacancy, titleOf(vacancy))),
    ...(offerNoPosition
      ? [
          {
            group: "Something else",
            id: NO_POSITION,
            name: "No position",
            search: "none without",
            secondary: "Send this CV without one",
          },
        ]
      : []),
    {
      group: "Something else",
      id: FREE_POSITION,
      name: "Another position",
      search: "free type new other",
      secondary: "Type an area and a job title",
    },
  ];

  return (
    <GroupedComboBox
      ariaLabel="Which position is this CV for"
      disabled={disabled}
      emptyLabel="No position matches"
      hint="area · region · manager"
      items={items}
      leadingIcon={<Briefcase className={value ? "h-3.5 w-3.5 shrink-0 text-orange-500" : "h-3.5 w-3.5 shrink-0 text-slate-400"} />}
      onChange={(ids) => onChange(ids[0] ?? "")}
      panelId={panelId}
      placeholder="For which position? (optional)"
      // The job title and line beside the closed field, where there are no headings to carry them.
      selectedSuffix={(item) => {
        const vacancy = vacancies.find((candidate) => String(candidate.id) === item.id);
        if (!vacancy) return null;
        return [vacancy.jobTitle, vacancy.lineName].filter(Boolean).join(" · ") || null;
      }}
      summaryNoun="positions"
      value={value ? [value] : []}
    />
  );
}
