// Employee `lines.name` values ("Anti Infective", "Pedia", "CNS", "Head Office") → Source of
// Sales `official_line` values ("Anti Infective", "CNS", "Head Office", "Pedia") — all four now
// match verbatim. The map is keyed by a case/whitespace-insensitive key and still carries the
// legacy "anti inf"/"office" abbreviations (kept so pre-rename data and the import codes
// anti_inf/office keep resolving), so any variant resolves to the exact SoS official line string
// (which is what the line-scope filter passes into SQL).
//
// Kept in its own dependency-free module, separate from access-scope.ts (which imports the
// server-only Supabase/employee-directory chain), so client components that only need the
// official-line constant list — e.g. the Database Mapping workspace's allowed-values list —
// never pull that server-only chain into a client bundle.
const OFFICIAL_LINE_BY_KEY: Record<string, string> = {
  "anti inf": "Anti Infective",
  "anti infective": "Anti Infective",
  cns: "CNS",
  office: "Head Office",
  "head office": "Head Office",
  pedia: "Pedia",
};

/** Map an employee line name onto the canonical Source-of-Sales official line. Unknown lines
 *  pass through trimmed (a future line still scopes correctly — the SQL filter lowercases). */
export function bridgeEmployeeLineToOfficial(lineName: string | null | undefined): string | null {
  if (!lineName) return null;
  const trimmed = lineName.trim();
  if (!trimmed) return null;
  return OFFICIAL_LINE_BY_KEY[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * The full set of canonical Source-of-Sales official line values, derived from
 * `OFFICIAL_LINE_BY_KEY` so it can never drift from the bridge map above. This is the
 * write-time allow-list for any place a line label is typed in as free text (e.g. the
 * Product Master import) — confidentiality (`isHeadOfficeLine`) is only as strong as this
 * set staying exhaustive, since a product/rollup row with an unrecognized line label would
 * silently bypass the Head Office strip instead of being caught.
 */
export const OFFICIAL_LINE_VALUES: readonly string[] = Array.from(new Set(Object.values(OFFICIAL_LINE_BY_KEY)));

/** Resolve a free-text line label to its canonical official-line casing, or null if it
 *  doesn't match any known official line (case/whitespace-insensitive). Unlike
 *  `bridgeEmployeeLineToOfficial`, this does NOT pass unknown values through — it is the
 *  write-time gate, where an unrecognized label should be rejected, not silently accepted. */
export function resolveOfficialLineValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  return OFFICIAL_LINE_BY_KEY[key] ?? OFFICIAL_LINE_VALUES.find((v) => v.toLowerCase() === key) ?? null;
}
