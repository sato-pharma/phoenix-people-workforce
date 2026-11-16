import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { createPlaceCheckReread } from "../src/components/phoenix-crm/place-check-reread.ts";
import { needsYouDecisionCount } from "../src/lib/phoenix-crm/shared-place-groups.ts";

/**
 * Place checks — the deep audit of 17 Nov 2026 (owner: "redo the deep audit", then "Wrong counts,
 * Decision paths, Wording on screen, Background runs"). One section per finding, each in the words of
 * the change that would bring it back.
 *
 *  A. WRONG COUNTS — the Needs You figure counted the three test entries and not the eight held
 *     buildings; a building with five customers waiting was five decisions on the board and one on the
 *     page; a sent-back customer who had already captured again was counted twice; and a dropped
 *     customer's place stood under Not confirmed (77 on production).
 *  B. DECISION PATHS — a recommendation saved under a decider's own HR id; a Regional Sales Manager on a
 *     vacant district seat reading his whole region's board; an approval older than 14 days rejected by
 *     overwriting who approved it; and the held full names cut at 200 with no word.
 *  C. WORDING ON SCREEN — "already decided" in red on Not confirmed and in the bulk bar; "cannot be
 *     undone" over a refusal the Super Admin can take back; the Same place tab's rule naming him alone; a
 *     failed full-list reload saying nothing; and two copies of every field id on one page.
 *  D. BACKGROUND RUNS — a bulk run carried on out of sight after a tab change, and a decision's re-read
 *     rebuilt whatever page he had opened since.
 */

const read = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => stripComments(read(path));

/** One function's text, from its opening to the closing brace at the start of a line. */
function fn(source: string, opening: string): string {
  const start = source.indexOf(opening);
  assert.ok(start > -1, `${opening} is still there`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${opening} ends`);
  return source.slice(start, end + 2);
}

function checkCounts() {
  // ── A2: a building is ONE decision, whatever number of customers wait behind it ───────────────────
  const onBoard = new Set(["venue-1", "venue-2"]);
  const counted = needsYouDecisionCount({
    waiting: [
      { id: "r1", at: "2026-11-10T08:00:00Z", sharedPlaceId: "venue-1" },
      { id: "r2", at: "2026-11-09T08:00:00Z", sharedPlaceId: "venue-1" },
      { id: "r3", at: "2026-11-12T08:00:00Z", sharedPlaceId: null },
      // Behind a building that is not on the board: its own decision, as the page draws it.
      { id: "r4", at: "2026-11-13T08:00:00Z", sharedPlaceId: "venue-9" },
    ],
    heldVenues: [
      { id: "venue-1", at: "2026-11-11T08:00:00Z" },
      { id: "venue-2", at: "2026-11-08T08:00:00Z" },
    ],
    venuesOnBoard: onBoard,
  });
  assert.equal(counted.count, 4, "🔴 venue-1 with two customers and its own hold is ONE decision; venue-2 held alone is one; r3 and r4 are one each");
  assert.equal(counted.oldestAt, "2026-11-08T08:00:00Z", "and the oldest is the held building nobody has seated a customer in yet");
  assert.deepEqual(
    needsYouDecisionCount({ waiting: [], heldVenues: [{ id: "venue-3", at: "2026-11-01T08:00:00Z" }], venuesOnBoard: onBoard }),
    { count: 0, oldestAt: null },
    "a held building the board does not draw (a test one, or retired long ago) is never counted",
  );
  assert.deepEqual(needsYouDecisionCount({ waiting: [], heldVenues: [], venuesOnBoard: new Set() }), { count: 0, oldestAt: null }, "nothing waiting is a true zero");

  // ── A1: the figure counts real entries only, and the held buildings, and never a short read ───────
  const reviews = code("src/lib/phoenix-crm/server/validation-reviews.ts");
  const waiting = fn(reviews, "export async function countValidationReviewsWaiting(");
  assert.equal((waiting.match(/\.eq\("is_test", false\)/g) ?? []).length, 2, "🔴 the reviews AND the held buildings are read without the test entries");
  assert.ok(waiting.includes("if (capped || heldRead.capped) throw"), "a read that met its ceiling throws, for both reads");
  assert.ok(waiting.includes("return needsYouDecisionCount({"), "the count is the page's own: one per building");
  const sharedPlaces = code("src/lib/phoenix-crm/server/shared-places.ts");
  const onTheBoard = fn(sharedPlaces, "export function sharedPlaceIsOnTheBoard(");
  assert.ok(onTheBoard.includes("if (row.is_test === true) return false;"), "a test building is never on the board");
  assert.ok(onTheBoard.includes('if (row.status === "active" || row.status === "held") return true;'), "an active or held building is");

  // ── A3: a sent-back customer who captured again is counted once, under Needs you ─────────────────
  assert.ok(fn(reviews, "export async function loadReopenedCustomers(").includes("await withoutACaptureSince(read.rows)"), "🔴 the list leaves out a customer with a place in use again");
  const reopenedCount = fn(reviews, "export async function countReopenedCustomersWaiting(");
  assert.ok(reopenedCount.includes("readEveryPage<Row>("), "the figure is read whole and paged");
  assert.ok(reopenedCount.includes('.eq("is_test", false)'), "real entries only");
  assert.ok(reopenedCount.includes("await withoutACaptureSince(read.rows)"), "and the same customers the list shows");
  assert.ok(fn(reviews, "async function withoutACaptureSince(").includes('query.eq("status", "active")'), "a capture since is a place in use");

  // ── A4: a dropped customer's place is not "in use" ───────────────────────────────────────────────
  const validated = fn(reviews, "export async function loadValidatedPlaces(");
  assert.ok(validated.includes("${PLACE_CUSTOMER_STATUS_JOIN}"), "the places in use read their customer's status");
  assert.ok(validated.includes('.neq("customer.status", "dropped")'), "🔴 and leave out a dropped customer's (77 on production)");
  assert.ok(
    read("src/lib/phoenix-crm/place-checks-slim-read.ts").includes(
      'export const PLACE_CUSTOMER_STATUS_JOIN = "customer:phoenix_crm_customers!phoenix_crm_places_customer_id_fkey!inner(status)";',
    ),
    "an INNER join on the one foreign key, so the filter drops the row instead of blanking the field",
  );
}

function checkDecisionPaths() {
  // ── B1: a recommendation is the district manager's word alone ────────────────────────────────────
  const notes = code("src/lib/phoenix-crm/server/place-notes.ts");
  assert.ok(
    fn(notes, "export async function savePlaceRecommendation(").includes('if (source !== "manager") throw forbiddenError('),
    "🔴 a decider's hand-built request is refused, never stored under his own HR id",
  );

  // ── B2: the team board is the territories under his district seats, not every manager seat ───────
  const access = code("src/lib/phoenix-crm/server/access.ts");
  const team = fn(access, "export function teamPlaceChecksSeats(");
  assert.ok(team.includes("TEAM_PLACE_CHECKS_TIERS.has(seat.tier)"), "only the seats of the tiers that admit him");
  assert.ok(team.includes("return territoriesBelow(viewer.org, districtSeats).filter((seat) => !isLocationBlind(viewer, seat));"), "🔴 and the territories below those, his own rep seat still blind");
  assert.ok(!team.includes("scopeTerritories"), "never the scope built from every manager seat");

  // ── B3: an approval is rejected on its own row, whatever screen sends it ─────────────────────────
  const reviews = code("src/lib/phoenix-crm/server/validation-reviews.ts");
  const refuse = fn(reviews, "export async function refuseValidatedPlace(");
  const branch = refuse.indexOf('if (earlierRow?.status === "approved" && typeof earlierRow.id === "string") {');
  assert.ok(branch > -1, "🔴 an approved review is caught before the upsert");
  assert.ok(branch < refuse.indexOf(".upsert("), "BEFORE the upsert that would overwrite who approved it");
  assert.ok(refuse.includes('decideValidationReview(viewer, { reviewId: earlierRow.id, decision: "reject", note, refusalReason })'), "and goes through the review route, which keeps the record");
  assert.ok(refuse.indexOf("approvalLockFor(viewer)") < branch, "the Super Admin's approval lock is still asked first");
  assert.ok(fn(reviews, "export async function decideValidationReview(").includes("reopened: result.reopened === true"), "the review route says whether the customer went back to To validate");

  // ── B4: every held full name, read whole ─────────────────────────────────────────────────────────
  const names = code("src/lib/phoenix-crm/server/full-name-reviews.ts");
  const held = fn(names, "export async function loadHeldFullNames(");
  assert.ok(held.includes("readEveryPage<Row>("), "🔴 read paged, never the oldest 200");
  assert.ok(held.includes("if (read.capped) throw"), "and a read that met its ceiling throws");
  assert.ok(!/HELD_LIMIT|\.limit\(/.test(held), "no cap left behind");
}

function checkWording() {
  // ── C1: the other decider settled it first — an answer, not an error ─────────────────────────────
  const reviews = code("src/lib/phoenix-crm/server/validation-reviews.ts");
  assert.ok(reviews.includes('export const PLACE_RETIRED_CODE = "phoenix_crm_place_retired";'), "a retired place has its own code");
  assert.ok(reviews.includes('export const PLACE_GONE_CODE = "phoenix_crm_place_not_found";'), "and so does a place that is gone");
  for (const opening of ["export async function refuseValidatedPlace(", "export async function approveValidatedPlace("]) {
    const body = fn(reviews, opening);
    assert.ok(body.includes('throw conflictError("This place is already retired.", PLACE_RETIRED_CODE)'), `${opening} answers a retired place with its code`);
    assert.ok(body.includes('throw notFoundError("This place is no longer there.", PLACE_GONE_CODE)'), `${opening} answers a gone place with its code`);
  }
  const done = read("src/components/phoenix-crm/place-check-done.tsx");
  const codes = done.slice(done.indexOf("const ALREADY_DECIDED_CODES"), done.indexOf("]);", done.indexOf("const ALREADY_DECIDED_CODES")));
  for (const literal of ['"phoenix_crm_place_retired"', '"phoenix_crm_place_not_found"']) {
    assert.ok(codes.includes(literal), `🔴 ${literal} draws "Already decided", never red`);
  }

  // ── C2: in a bulk run too, and every settled row is marked saved ─────────────────────────────────
  const bulk = code("src/components/phoenix-crm/place-check-bulk.tsx");
  assert.ok(bulk.includes('if (isAlreadyDecided(error)) landed.push("already");'), "🔴 a bulk row already decided is counted as settled");
  assert.ok(bulk.includes("else failed.push({ name: nameOf(row), problem: messageOf(error) });"), "and only a real failure is listed as not answered");
  assert.ok(bulk.includes("if (landed.length > before) markRowSaved(row, landed[landed.length - 1]);"), "🔴 every row the run settled draws its saved mark at once");
  assert.ok(stripComments(done).includes("export function markRowSaved(subject: unknown, outcome: PlaceCheckOutcome) {\n  rememberSaved(JSON.stringify(subject), outcome);"), "keyed exactly as the row's own control keys it");

  const summaryFn = fn(done, "export function bulkOutcomeSummary(");
  const labelsOpening = "const SAVED_LABEL: Record<PlaceCheckOutcome, { text: string; tone: PillTone }> = ";
  const labelsStart = done.indexOf(labelsOpening);
  const savedLabel = new Function(`return ${done.slice(labelsStart + labelsOpening.length, done.indexOf("\n};", labelsStart) + 2)};`)() as Record<string, { text: string }>;
  const summary = new Function(
    "outcomes",
    "SAVED_LABEL",
    "PLACE_APPROVED_NOT_A_LIST_ADD",
    summaryFn.slice(summaryFn.indexOf("{") + 1, summaryFn.lastIndexOf("}")).replace("new Map<PlaceCheckOutcome, number>()", "new Map()"),
  ) as (outcomes: string[], labels: Record<string, { text: string }>, listAdd: string) => string;
  assert.equal(summary(["already", "already", "already"], savedLabel, "L"), "Already decided: 3.", "🔴 a run that saved nothing of its own never says \"Saved.\"");
  assert.equal(summary(["rejected", "already"], savedLabel, "L"), "Saved. Rejected: 1 · Already decided: 1.", "a mixed run says both");

  // ── C3: a refusal the Super Admin can take back is never "cannot be undone" ──────────────────────
  const list = read("src/components/phoenix-crm/validated-place-list.tsx");
  assert.ok(!/cannot be undone/.test(stripComments(list)), "🔴 no screen line says a refusal cannot be undone");
  assert.ok(list.includes('return canRestore ? "You can approve it after all from History while it stays retired." : "Only the Super Admin can take it back.";'), "the line follows who can take it back");
  assert.ok(fn(list, "function Refuse(").includes("const canRestore = useCanRestoreValidation();"), "read from the take-back's own provider, never from `mode`");
  assert.ok(list.includes("{refusalTakeBack(canRestore)}</CrmNote>"), "and drawn in the warning");
  assert.ok(list.includes("Only the Super Admin can take a refusal back, from History."), "the bulk warning is true for both deciders");

  // ── C4: the Same place tab is both deciders' ─────────────────────────────────────────────────────
  const rules = read(".claude/rules/phoenix-crm-place-checks.md");
  assert.ok(!/SAME PLACE, SEVERAL REPS[^\n]*THE SUPER ADMIN'S ALONE/.test(rules), "🔴 the rule no longer names the Super Admin alone");
  assert.ok(/SAME PLACE, SEVERAL REPS[^\n]*THE DECIDERS' ALONE[^\n]*\(the Super Admin and the SFE Manager, `canReadPlaceMatches`/.test(rules), "it names both, as `canReadPlaceMatches` has since 19 Oct");
  assert.ok(code("src/lib/phoenix-crm/server/place-match-groups.ts").includes("if (!canReadPlaceMatches(viewer)) throw forbiddenError("), "and the code still asks that gate");
  assert.ok(!read("app/api/phoenix-crm/place-notes/route.ts").includes("refuses the RSM, the NSM and the SFE Manager"), "the note route no longer says the SFE Manager is refused");

  // ── C5: a failed reload of every place says so, after the first reading too ──────────────────────
  const board = code("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(board.includes("{onDemand && wanted && complete && everythingRead.error ? ("), "🔴 a reload that failed over rows already on screen is said");
  assert.ok(board.includes("<ReadingEverything error={everythingRead.error} onRetry={reloadEverything} stale />"), "with Try again");
  assert.ok(board.includes("The lists and counts below are from the reading before it."), "and what the lists now are");

  // ── C6: one id per field on the page ─────────────────────────────────────────────────────────────
  for (const path of ["src/components/phoenix-crm/validation-review-queue.tsx", "src/components/phoenix-crm/validated-place-list.tsx"]) {
    const source = code(path);
    assert.equal((source.match(/<LastColumn mode=\{mode\} noteIndex=\{noteIndex\} row=\{row\} scope="card-" \/>/g) ?? []).length, 1, `🔴 ${path}: the phone cards carry their own scope`);
    assert.equal((source.match(/<LastColumn mode=\{mode\} noteIndex=\{noteIndex\} row=\{row\} scope="" \/>/g) ?? []).length, 1, `${path}: the table keeps its ids`);
  }
  assert.ok(code("src/components/phoenix-crm/validation-review-queue.tsx").includes("<Decision row={row} scope={scope} />"), "the queue hands the scope to its decision, its take-back and its reject-after-all");
  assert.ok(code("src/components/phoenix-crm/validated-place-list.tsx").includes("<Refuse row={row} scope={scope} />"), "the list hands it to Refuse");
  assert.ok(!/id="place-check-bulk-(reason|note)"/.test(bulk), "🔴 no bulk bar carries a fixed field id");
  assert.ok(bulk.includes("const noteId = `place-check-bulk-note-${fieldId}`;") && bulk.includes("const reasonId = `place-check-bulk-reason-${fieldId}`;"), "each bar its own");
}

function checkBackgroundRuns() {
  // ── D1: a bulk run holds the board still until it ends ───────────────────────────────────────────
  const bulk = code("src/components/phoenix-crm/place-check-bulk.tsx");
  const run = fn(bulk, "  async function run(action: BulkAction<Row>) {".trimStart());
  assert.ok(run.includes("setBulkRunGoing(true);"), "a run says it is going");
  assert.ok(/\} finally \{\s*setBulkRunGoing\(false\);\s*\}/.test(run), "🔴 and always says it ended, even on a throw");
  assert.ok(bulk.includes("const busy = running !== null || anyRunGoing;"), "and no other bar starts a run over it");
  const board = code("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(board.includes("const bulkRunning = useBulkRunGoing();"), "the board reads it");
  assert.ok(board.includes('<fieldset className="m-0 min-w-0 space-y-5 border-0 p-0" disabled={bulkRunning}>'), "🔴 the filters, the scorecard and the tabs wait while it runs");
  const tabs = board.indexOf('role="tablist"');
  assert.ok(tabs > board.indexOf("disabled={bulkRunning}>") && tabs < board.indexOf("</fieldset>"), "the tabs are inside it");
  for (const control of ["disabled={bulkRunning}\n                    onClick={() => setChip(key)}", "<CrmButton disabled={bulkRunning} onClick={() => setOnlyBuilding(null)}", "checked={showRejectedBuildings} disabled={bulkRunning}"]) {
    assert.ok(board.includes(control), `every switch that redraws a list waits too: ${control.split("\n")[0]}`);
  }

  // ── D2: a decision's re-read dies with the page ──────────────────────────────────────────────────
  const timers = new Map<number, () => void>();
  let next = 0;
  const reread = createPlaceCheckReread<number>({
    clear: (handle) => void timers.delete(handle),
    set: (callback) => {
      next += 1;
      timers.set(next, callback);
      return next;
    },
  });
  let reads = 0;
  reread.ask(() => (reads += 1));
  assert.equal(timers.size, 1, "a decision asks for one re-read");
  reread.cancel();
  assert.equal(timers.size, 0, "🔴 cancel drops the waiting timer");
  reread.flush();
  assert.equal(reads, 0, "and nothing is read, not even by a later flush");
  reread.cancel();
  assert.equal(reads, 0, "a cancel with nothing waiting does nothing");
  reread.ask(() => (reads += 1));
  reread.flush();
  assert.equal(reads, 1, "the next decision still re-reads");

  assert.ok(board.includes("useEffect(() => () => placeCheckReread.cancel(), []);"), "🔴 the board drops it when it closes");
  assert.ok(/placeCheckReread\.cancel\(\);\s*router\.refresh\(\);/.test(bulk), "the bulk bar's own read drops the waiting one first");
  const notes = code("src/components/phoenix-crm/place-check-notes.tsx");
  assert.equal((notes.match(/placeCheckReread\.cancel\(\);\s*router\.refresh\(\);/g) ?? []).length, 2, "and so do both note saves");
  assert.equal((notes.match(/router\.refresh\(\)/g) ?? []).length, 2, "with no other refresh in the file");
}

export function runPhoenixCrmPlaceChecksAuditFixesTests() {
  checkCounts();
  checkDecisionPaths();
  checkWording();
  checkBackgroundRuns();
}
