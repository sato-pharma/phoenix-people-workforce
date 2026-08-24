import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The requisition Position dropdown (admin + employee portal recruitment create-form, both fed by
 * listPositionCatalogue()) offered every active position in the org catalogue, including "Ceo" — a
 * role the owner does not want reachable from the recruitment pipeline at all. This is a display
 * curation, not a permission gate: nothing in access control changes, the row still exists in
 * `positions`, it simply never appears as a choosable Position.
 *
 * This pins the fix: a named, exported set of excluded position codes (so it can grow beyond "ceo"
 * without touching the filtering logic again), and listPositionCatalogue() actually filtering by it.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

// Extract one named block (a function or const) up to the earliest of the given following markers.
function block(source: string, startMarker: string, endMarkers: string[]): string {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `expected to find ${startMarker}`);
  let end = source.length;
  for (const marker of endMarkers) {
    const at = source.indexOf(marker, start + startMarker.length);
    if (at !== -1 && at < end) end = at;
  }
  return source.slice(start, end);
}

export async function runRecruitmentNonRecruitablePositionsTests() {
  const requisitions = read("src/lib/recruitment/requisitions.ts");

  // ── 1 · The curated set is exported and names "ceo" as excluded ─────────────
  assert.match(
    requisitions,
    /export const NON_RECRUITABLE_POSITION_CODES = new Set<string>\(\[[^\]]*\]\)/,
    "requisitions.ts must export a NON_RECRUITABLE_POSITION_CODES set",
  );
  const setDeclaration = block(requisitions, "export const NON_RECRUITABLE_POSITION_CODES", [
    "\nexport async function listPositionCatalogue",
    "\nfunction normalizeHeadcountType",
  ]);
  assert.match(
    setDeclaration,
    /Set<string>\(\[\s*"ceo"/,
    'NON_RECRUITABLE_POSITION_CODES must contain "ceo" — the owner-curated exclusion this PR adds',
  );

  // ── 2 · listPositionCatalogue() actually filters by the set ─────────────────
  const catalogueFn = block(requisitions, "export async function listPositionCatalogue", [
    "\nfunction normalizeHeadcountType",
  ]);
  assert.match(
    catalogueFn,
    /\.select\("id,title,code"\)/,
    "listPositionCatalogue must select code so the exclusion set can filter on it",
  );
  assert.match(
    catalogueFn,
    /NON_RECRUITABLE_POSITION_CODES\.has\(code\.toLowerCase\(\)\)/,
    "listPositionCatalogue must filter the catalogue by NON_RECRUITABLE_POSITION_CODES (case-insensitively)",
  );

  // ── 3 · The returned option shape is unchanged: still { id, title } ─────────
  assert.match(
    catalogueFn,
    /\.map\(\(row\) => \(\{ id: numberOrNull\(row\.id\), title: textOrNull\(row\.title\) \}\)\)/,
    "the catalogue option shape must stay { id, title } — the exclusion is a pre-filter, not a shape change",
  );
}
