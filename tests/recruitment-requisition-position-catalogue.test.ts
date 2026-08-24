import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The requisition create form used to build its Position dropdown only from open organogram
 * vacancies, so of the 21 active positions only the ~3 with a vacant seat could be picked. Every
 * other role was reachable only by free-texting a title, and that requisition landed with no
 * position_id at all.
 *
 * This pins the fix: a full active-catalogue read, a create path that tags a seatless requisition
 * with a real position_id and borrows the position's title, a guard that still insists on a hiring
 * manager (visibility hangs off it), and a form that offers the whole catalogue.
 *
 * Setting position_id does NOT touch the organogram — a seat (vacancy_id) is a separate concept, so
 * this is coherent and safe.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

// Extract one named block (a function or const) up to the earliest of the given following markers.
// Scoping the assertions to a single function keeps "break it and watch this line fail" honest —
// otherwise a duplicate call elsewhere in the file would keep the regex green.
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

export async function runRecruitmentRequisitionPositionCatalogueTests() {
  const requisitions = read("src/lib/recruitment/requisitions.ts");
  const route = read("app/api/recruitment/requisitions/route.ts");
  const workspace = read("src/components/recruitment/recruitment-workspace.tsx");
  const types = read("src/lib/recruitment/types.ts");

  // ── 1 · The service exposes the full ACTIVE catalogue ───────────────────────
  assert.match(
    requisitions,
    /export async function listPositionCatalogue\(\): Promise<PositionCatalogueOption\[\]>/,
    "requisitions.ts must export listPositionCatalogue returning the catalogue option type",
  );
  const catalogueFn = block(requisitions, "export async function listPositionCatalogue", [
    "\nfunction normalizeHeadcountType",
  ]);
  assert.match(
    catalogueFn,
    /\.from\("positions"\)/,
    "the catalogue is read from the positions table, not derived from vacancy rows",
  );
  assert.match(
    catalogueFn,
    /\.eq\("is_active", true\)/,
    "listPositionCatalogue must return ACTIVE positions only",
  );

  // The option type the whole feature threads through is exported for the pages and the client form.
  assert.match(
    types,
    /export type PositionCatalogueOption = \{ id: number; title: string \}/,
    "the catalogue option type must be exported from recruitment/types.ts",
  );

  // ── 2 · A seatless requisition carries a real position_id and a real name ───
  const createFn = block(requisitions, "export async function createRequisition", [
    "\nconst requisitionNextStatus",
  ]);
  assert.match(
    createFn,
    /position_id: vacancy\?\.positionId \?\? numberOrNull\(input\.positionId\) \?\? null/,
    "with no vacancy, position_id must come from the chosen catalogue position",
  );
  // The title is resolved from the positions row when the requisition has no vacancy and no typed
  // title, so a nameless row never reaches the screen.
  assert.match(
    createFn,
    /\.from\("positions"\)[\s\S]{0,240}?\.eq\("id", positionId\)[\s\S]{0,120}?\.eq\("is_active", true\)/,
    "the create path must resolve the chosen position from the positions table before using it",
  );
  assert.match(
    createFn,
    /resolvedPositionTitle/,
    "the resolved position title must feed the job_title fallback",
  );
  assert.match(
    createFn,
    /job_title: textOrNull\(input\.jobTitle\)[\s\S]{0,120}?resolvedPositionTitle/,
    "job_title must fall back to the resolved catalogue position title",
  );

  // ── 3 · The hiring manager stays mandatory for a seatless requisition ───────
  // Visibility (canSeeRequisition) hangs off the hiring manager, so this throw is what keeps a
  // seatless requisition from becoming invisible to the person meant to hire for it.
  assert.match(
    createFn,
    /if \(!vacancy\) \{[\s\S]{0,400}?Choose the hiring manager/,
    "the service must still refuse a seatless requisition with no hiring manager named",
  );
  // A bogus/inactive position id is rejected rather than silently tagged onto the row.
  assert.match(
    createFn,
    /Selected position was not found\./,
    "an unknown or inactive position id must be refused, not written through",
  );

  // The route mirrors the guard — a title source (position OR typed title) plus a hiring manager.
  assert.match(
    route,
    /positionId: num\(body\.positionId\)/,
    "the POST route must read positionId from the request body",
  );
  assert.match(
    route,
    /if \(!input\.vacancyId\) \{[\s\S]{0,200}?!input\.jobTitle && !input\.positionId/,
    "the route pre-check must accept either a typed title or a chosen position as the title source",
  );

  // ── 4 · The form offers the whole catalogue, not just vacancy-backed roles ──
  assert.match(
    workspace,
    /positionCatalogue: PositionCatalogueOption\[\]/,
    "the workspace must accept the position catalogue as a prop",
  );
  assert.match(
    workspace,
    /\{positionCatalogue\.map\(\(position\) => \(/,
    "the Position dropdown options must be built from the catalogue, not only from open vacancies",
  );
  // openVacancies still decides, for the chosen position, whether real seats sit behind it.
  assert.match(
    workspace,
    /const matchingVacancies = posSel/,
    "the chosen position is still matched against open vacancies to drive the seat cascade",
  );
}
