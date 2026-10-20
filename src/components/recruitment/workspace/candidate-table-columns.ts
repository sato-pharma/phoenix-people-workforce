// Recruitment workspace — the candidate table's columns, as plain data: which answers get a column of
// their own, the owner's words over them, and each column's share of the width. Kept apart from
// `candidate-table.tsx` so the test runner can load and pin it (`tests/recruitment-workspace-table.test.ts`):
// the six must stay his six, in his order and his words, and each layout's shares must sum to 100.

/** The owner's six, by chip key, in his order — `MEDICAL_REP_LEAD_KEYS` (pinned equal by the test). */
export const TABLE_LEAD_KEYS = ["role", "background", "experience", "salary", "oc_start_date", "field_age_band"] as const;
/** His words for the six — `OWNER_ANSWER_LABELS` (pinned equal by the test). */
export const TABLE_LEAD_LABELS: Record<(typeof TABLE_LEAD_KEYS)[number], string> = {
  background: "Graduated in",
  experience: "Years of experience",
  field_age_band: "Age",
  oc_start_date: "When could you start",
  role: "Applying for",
  salary: "Expected monthly net salary",
};
/** The answers the Region · Area column already shows; everything else is "Other answers". */
export const TABLE_PLACE_KEYS: readonly string[] = ["region", "area"];

/** The table switches to ten columns from this much of its OWN width. */
export const TABLE_WIDE_MIN_PX = 1180;

export type TableColumn = { key: string; percent: number };

/** Ten columns, ≥ 1180px of the table's own width. Percentages sum to 100 (pinned by the test). */
export const WIDE_COLUMNS: readonly TableColumn[] = [
  { key: "tick", percent: 3 },
  { key: "candidate", percent: 21 },
  { key: "role", percent: 9 },
  { key: "background", percent: 9 },
  { key: "experience", percent: 8 },
  { key: "salary", percent: 8 },
  { key: "oc_start_date", percent: 8 },
  { key: "field_age_band", percent: 7 },
  { key: "place", percent: 10 },
  { key: "other", percent: 17 },
];

/** The half page: the six in two stacked columns, the place inside the candidate cell. Sums to 100. */
export const COMPACT_COLUMNS: readonly TableColumn[] = [
  { key: "tick", percent: 5 },
  { key: "candidate", percent: 37 },
  { key: "first", percent: 29 },
  { key: "second", percent: 29 },
];

/** The columns without the tick (a reader who cannot work the list), its share given to the candidate. */
export function columnsFor(columns: readonly TableColumn[], canSelect: boolean): TableColumn[] {
  if (canSelect) return [...columns];
  const tick = columns.find((column) => column.key === "tick")?.percent ?? 0;
  return columns.filter((column) => column.key !== "tick").map((column) => (column.key === "candidate" ? { ...column, percent: column.percent + tick } : column));
}
