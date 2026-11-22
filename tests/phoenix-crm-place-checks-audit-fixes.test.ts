import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { createPlaceCheckReread } from "../src/components/phoenix-crm/place-check-reread.ts";
import { earlierDecisionOf, earlierDecisionText } from "../src/lib/phoenix-crm/earlier-decision.ts";
import { needsYouDecisionCount, needsYouDecisionCountWithSfe } from "../src/lib/phoenix-crm/shared-place-groups.ts";
import { refusalTakeBack } from "../src/lib/phoenix-crm/validation-feedback.ts";

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

  checkSfeRecommendedApart();

  // ── A1: the figure counts real entries only, and the held buildings, and never a short read ───────
  const reviews = code("src/lib/phoenix-crm/server/validation-reviews.ts");
  const waiting = fn(reviews, "export async function countValidationReviewsWaiting(");
  assert.equal((waiting.match(/\.eq\("is_test", false\)/g) ?? []).length, 2, "🔴 the reviews AND the held buildings are read without the test entries");
  assert.ok(waiting.includes("if (capped || heldRead.capped) throw"), "a read that met its ceiling throws, for both reads");
  assert.ok(waiting.includes("return needsYouDecisionCountWithSfe({"), "the count is the page's own: one per building");
  assert.ok(
    waiting.includes("venue:phoenix_crm_shared_places!phoenix_crm_places_shared_place_id_fkey(id, status, is_test, retired_at)"),
    "🔴 each place's building comes joined into the same read, over its named key",
  );
  assert.equal((waiting.match(/selectByIds/g) ?? []).length, 1, "so no second lookup by id waits behind it");
  const sharedPlaces = code("src/lib/phoenix-crm/server/shared-places.ts");
  const onTheBoard = fn(sharedPlaces, "export function sharedPlaceIsOnTheBoard(");
  assert.ok(onTheBoard.includes("if (row.is_test === true) return false;"), "a test building is never on the board");
  assert.ok(onTheBoard.includes('if (row.status === "active" || row.status === "held") return true;'), "an active or held building is");

  // ── A3: a sent-back customer who captured again is counted once, under Needs you ─────────────────
  assert.ok(fn(reviews, "export async function loadReopenedCustomers(").includes("await withoutACaptureSince(read.rows)"), "🔴 the list leaves out a customer with a place in use again");
  const reopenedCount = fn(reviews, "export async function countReopenedCustomersWaiting(");
  assert.ok(reopenedCount.includes('{ count: "exact", head: true }'), "the figure is a head count, so no row ceiling can shorten it and the backlog never sets its cost");
  assert.equal((reopenedCount.match(/\.eq\("is_test", false\)/g) ?? []).length, 2, "real entries only, in the count and in the oldest stamp");
  assert.equal(
    (reopenedCount.match(/\.eq\("active_place\.status", "active"\)\s*\.is\("active_place", null\)/g) ?? []).length,
    2,
    "🔴 the count and the oldest stamp both leave out a customer with a place in use again, as the list does",
  );
  assert.ok(
    reviews.includes('const NO_PLACE_IN_USE_JOIN = "active_place:phoenix_crm_places!phoenix_crm_places_customer_id_fkey(id)";'),
    "his places are joined over the one named key",
  );
  assert.ok(reopenedCount.includes("throwIfError(waiting.error);") && reopenedCount.includes("throwIfError(oldest.error);"), "a failed read throws, never a zero");
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

// ── A3: what the SFE Manager recommended on is counted apart (22 Nov 2026, the deep audit). Needs you read
// 25 more place checks than Place checks drew: the board hands those to the SFE recommendations page. ──────
function checkSfeRecommendedApart() {
  const input = {
    waiting: [
      { id: "r1", at: "2026-11-10T08:00:00Z", placeId: "p1", sharedPlaceId: null },
      // The SFE Manager recommended on this one.
      { id: "r2", at: "2026-11-09T08:00:00Z", placeId: "p2", sharedPlaceId: null },
      // Behind a held building he recommended on, not recommended on themselves.
      { id: "r3", at: "2026-11-12T08:00:00Z", placeId: "p3", sharedPlaceId: "venue-1" },
      { id: "r5", at: "2026-11-14T08:00:00Z", placeId: "p5", sharedPlaceId: "venue-1" },
      // Behind a building in use.
      { id: "r4", at: "2026-11-13T08:00:00Z", placeId: "p4", sharedPlaceId: "venue-2" },
    ],
    heldVenues: [
      { id: "venue-1", at: "2026-11-11T08:00:00Z" },
      { id: "venue-3", at: "2026-11-07T08:00:00Z" },
    ],
    venuesOnBoard: new Set(["venue-1", "venue-2", "venue-3"]),
    sfeRecommendedPlaces: new Set(["p2"]),
    // venue-2 is in use: a recommendation left on a building already approved hands nothing over.
    sfeRecommendedVenues: new Set(["venue-1", "venue-2"]),
  };
  const split = needsYouDecisionCountWithSfe(input);
  assert.deepEqual(
    split.sfeRecommended,
    { count: 2, oldestAt: "2026-11-09T08:00:00Z" },
    "🔴 the place he recommended on and the held building he recommended on wait on his page — each once",
  );
  assert.equal(split.count, 5, "🔴 Place checks keeps r1, r3 and r5 on their own (their building left the board), the building in use, and venue-3");
  assert.equal(split.oldestAt, "2026-11-07T08:00:00Z", "and its oldest is the oldest thing Place checks still draws");
  const none = needsYouDecisionCountWithSfe({ ...input, sfeRecommendedPlaces: new Set(), sfeRecommendedVenues: new Set() });
  assert.deepEqual(
    { count: none.count, oldestAt: none.oldestAt },
    needsYouDecisionCount(input),
    "with nothing recommended it is the page's count exactly",
  );
  assert.deepEqual(none.sfeRecommended, { count: 0, oldestAt: null }, "and nothing waits on his page");

  const reviews = code("src/lib/phoenix-crm/server/validation-reviews.ts");
  const loader = fn(reviews, "async function loadSfeRecommendedSubjects(");
  assert.ok(
    loader.includes('row.writer_role === "sfe_manager" && parsePlaceRecommendation(row.recommendation) !== null'),
    "his rows only, and a recommendation the code does not know is none — as `sfeRecommendationOf` reads them",
  );
  assert.ok(!/catch|\|\| 0/.test(loader), "a failed read travels");
  const waiting = fn(reviews, "export async function countValidationReviewsWaiting(");
  assert.ok(/loadSfeRecommendedSubjects\(\s*placeIds,\s*heldRead\.rows\.map\(\(row\) => String\(row\.id\)\),?\s*\)/.test(waiting), "asked of every waiting place and every held building");
  assert.ok(code("src/lib/phoenix-crm/server/needs-you.ts").includes("sfeRecommendedChecks: placeCheck.sfeRecommended.count,"), "the board's loader carries it");
  const sources = code("src/lib/needs-you/sources.ts");
  const row = sources.slice(sources.indexOf('key: "phoenix-crm-decisions:sfe-recommended-checks"'), sources.indexOf("});", sources.indexOf('key: "phoenix-crm-decisions:sfe-recommended-checks"')));
  assert.ok(row.includes("href: SFE_RECOMMENDATIONS_PATH,"), "🔴 its own row opens the page that lists them, never Place checks");
  assert.ok(row.includes('lane: "yours"') && row.includes("count: counts.sfeRecommendedChecks,"), "in his own lane, with its own count");
}

function checkDecisionPaths() {
  // ── B1: a recommendation is the district manager's word alone ────────────────────────────────────
  const notes = code("src/lib/phoenix-crm/server/place-notes.ts");
  assert.ok(
    fn(notes, "export async function savePlaceRecommendation(").includes(
      'source === "manager" ? "district_manager" : recommendsOnCompanyPlaceChecks(viewer) ? "sfe_manager" : null;',
    ) && fn(notes, "export async function savePlaceRecommendation(").includes("if (!writerRole) throw forbiddenError("),
    "🔴 a decider's hand-built request is refused, never stored under his own HR id — only a district manager or the SFE Manager recommends (owner, 2026-11-19)",
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
  const feedback = code("src/lib/phoenix-crm/validation-feedback.ts");
  assert.ok(feedback.includes('export const PLACE_RETIRED_CODE = "phoenix_crm_place_retired";'), "a retired place has its own code");
  assert.ok(feedback.includes('export const PLACE_GONE_CODE = "phoenix_crm_place_not_found";'), "and so does a place that is gone");
  const sharedCodes = /import \{[^}]*\bPLACE_GONE_CODE,\s*PLACE_RETIRED_CODE\b[^}]*\} from "@\/lib\/phoenix-crm\/validation-feedback";/;
  assert.ok(sharedCodes.test(reviews), "🔴 the server throws the codes from the one module the screen reads them from");
  assert.ok(!/const PLACE_(RETIRED|GONE)_CODE\b/.test(reviews), "never a second copy beside it");
  for (const opening of ["export async function refuseValidatedPlace(", "export async function approveValidatedPlace("]) {
    const body = fn(reviews, opening);
    assert.ok(body.includes('throw conflictError("This place is already retired.", PLACE_RETIRED_CODE)'), `${opening} answers a retired place with its code`);
    assert.ok(body.includes('throw notFoundError("This place is no longer there.", PLACE_GONE_CODE)'), `${opening} answers a gone place with its code`);
  }
  const done = read("src/components/phoenix-crm/place-check-done.tsx");
  const codes = done.slice(done.indexOf("const ALREADY_DECIDED_CODES"), done.indexOf("]);", done.indexOf("const ALREADY_DECIDED_CODES")));
  for (const name of ["PLACE_RETIRED_CODE", "PLACE_GONE_CODE"]) {
    assert.ok(new RegExp(`\\n\\s*${name},`).test(codes), `🔴 ${name} draws "Already decided", never red`);
  }
  assert.ok(sharedCodes.test(done), "read from the same module the server throws them from, never a string typed again");

  // ── C2: in a bulk run too, and every settled row is marked saved ─────────────────────────────────
  const bulk = code("src/components/phoenix-crm/place-check-bulk.tsx");
  assert.ok(bulk.includes('if (isAlreadyDecided(error)) landed.push("already");'), "🔴 a bulk row already decided is counted as settled");
  assert.ok(bulk.includes("else failed.push({ name: nameOf(row), problem: messageOf(error) });"), "and only a real failure is listed as not answered");
  assert.ok(bulk.includes("if (landed.length > before) markRowSaved(row, landed[landed.length - 1]);"), "🔴 every row the run settled draws its saved mark at once");
  assert.ok(stripComments(done).includes("export function markRowSaved(subject: unknown, outcome: PlaceCheckOutcome) {\n  SAVED_MARKS.remember(savedMarkKey(subject), outcome);"), "keyed exactly as the row's own control keys it");

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
  assert.equal(refusalTakeBack(true), "You can approve it after all from History while it stays retired.", "the line follows who can take it back");
  assert.equal(refusalTakeBack(false), "Only the Super Admin can take it back.", "and says who can when he cannot");
  assert.equal(refusalTakeBack(true, 3), "You can approve them after all from History while they stay retired.", "the bulk warning counts its places");
  assert.equal(refusalTakeBack(false, 3), "Only the Super Admin can take them back.", "for both deciders");
  assert.ok(!/function refusalTakeBack\(/.test(list), "🔴 one wording, in validation-feedback, never a copy in the list");
  assert.ok(fn(list, "function Refuse(").includes("const canRestore = useCanRestoreValidation();"), "read from the take-back's own provider, never from `mode`");
  assert.ok(list.includes("{refusalTakeBack(canRestore)}</CrmNote>"), "and drawn in the warning");
  assert.ok(list.includes("${refusalTakeBack(canRestore, count)}"), "🔴 the bulk warning follows who is reading too");
  assert.ok(fn(list, "export function ValidatedPlaceList(").includes("actions={inUseActions(canRestore)}"), "and is built from his own take-back");
  assert.ok(fn(list, "function Refuse(").includes("if (saved) return null;"), "🔴 Approve draws the saved mark once; Refuse never draws it again beside it");
  assert.ok(
    code("src/lib/needs-you/sources.ts").includes('plural(counts.placeChecks, "place check waits", "place checks wait")} for your approval'),
    "🔴 the Needs You row counts place checks, held or not, never \"places are held\"",
  );

  // ── C4: the Same place tab is read by both, answered by the Super Admin alone (owner, 2026-11-19) ──
  const rules = read(".claude/rules/phoenix-crm-place-checks.md");
  assert.ok(!/SAME PLACE, SEVERAL REPS[^\n]*THE SUPER ADMIN'S ALONE/.test(rules), "🔴 the rule no longer names the Super Admin alone");
  assert.ok(/SAME PLACE, SEVERAL REPS[^\n]*\(read by the Super Admin and the SFE Manager, `canReadPlaceMatches` = `readsCompanyPlaceChecks`; answered by the Super Admin alone since 19 Nov 2026/.test(rules), "it names both readers, as `canReadPlaceMatches` has since 19 Oct, and the Super Admin as the one who answers");
  assert.ok(code("src/lib/phoenix-crm/server/place-match-groups.ts").includes("return readsCompanyPlaceChecks(viewer);"), "🔴 the readers' gate is the company board's readers, never the decider's");
  assert.ok(code("src/lib/phoenix-crm/server/place-match-groups.ts").includes("if (!canReadPlaceMatches(viewer)) throw forbiddenError("), "and the code still asks that gate");
  assert.ok(!read("app/api/phoenix-crm/place-notes/route.ts").includes("refuses the RSM, the NSM and the SFE Manager"), "the note route no longer says the SFE Manager is refused");

  // ── C5: a failed reload of every place says so, after the first reading too ──────────────────────
  const board = code("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(board.includes("{onDemand && wanted && complete && everythingRead.error ? ("), "🔴 a reload that failed over rows already on screen is said");
  assert.ok(board.includes("<ReadingEverything error={everythingRead.error} onRetry={reloadEverything} stale />"), "with Try again");
  assert.ok(board.includes("The lists and counts below are from the reading before it."), "and what the lists now are");
  assert.ok(
    board.includes('did not work${error ? `: ${error.trim().replace(/([^.!?])$/, "$1.")}` : "."} The lists'),
    "🔴 the reason ends its own sentence before the next one starts",
  );

  // ── C7: the folded controls point at nothing that is not drawn, and the comment names both readers ──
  assert.ok(board.includes('aria-controls={filtersOpen ? "vr-filter-fields" : undefined}'), "the filters button names its fields only while they are drawn");
  assert.ok(
    code("src/components/phoenix-crm/place-check-scorecard.tsx").includes('aria-controls={open ? "place-check-scorecard-body" : undefined}'),
    "and so does the scorecard's",
  );
  assert.ok(code("src/components/phoenix-crm/refusal-reason-field.tsx").includes("Add a comment for the rep and their manager (optional)"), "🔴 the comment link says the manager reads it too");
  assert.ok(code("app/(admin)/admin/field-crm/validation-reviews/page.tsx").includes("list-none items-center gap-2 px-4 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-500 hover:text-slate-700 [&::-webkit-details-marker]:hidden"), "Safari draws no second marker beside the chevron");

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
  assert.ok(/\} finally \{\s*if \(ownsRun\.current\) \{\s*ownsRun\.current = false;\s*setBulkRunGoing\(false\);\s*\}\s*\}/.test(run), "🔴 and always says it ended, even on a throw");
  assert.ok(run.includes("if (!alive.current) break;"), "🔴 a run stops at the next row once its bar has left the page");
  assert.ok(/if \(!alive\.current\) return;[\s\S]*router\.refresh\(\)/.test(run), "🔴 and never refreshes a page he has opened since");
  assert.ok(/return \(\) => \{\s*alive\.current = false;\s*if \(ownsRun\.current\) \{\s*ownsRun\.current = false;\s*setBulkRunGoing\(false\);/.test(bulk), "and a bar that leaves mid-run hands the board back");
  assert.ok(bulk.includes("const busy = running !== null || anyRunGoing;"), "and no other bar starts a run over it");
  const board = code("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(board.includes("const bulkRunning = useBulkRunGoing();"), "the board reads it");
  assert.ok(board.includes('<fieldset className="m-0 min-w-0 space-y-5 border-0 p-0" disabled={bulkRunning}>'), "🔴 the filters, the scorecard and the tabs wait while it runs");
  const tabs = board.indexOf('role="tablist"');
  assert.ok(tabs > board.indexOf("disabled={bulkRunning}>") && tabs < board.indexOf("</fieldset>"), "the tabs are inside it");
  const panelsHold = board.indexOf('<fieldset className="m-0 min-w-0 space-y-5 border-0 p-0" disabled={bulkRunning}>', board.indexOf("</fieldset>"));
  assert.ok(panelsHold > -1 && panelsHold < board.indexOf('id="vr-panel-needs"'), "🔴 every row's own buttons wait too: the panels sit in a second hold");
  assert.ok(board.lastIndexOf("</fieldset>") > board.indexOf('id="vr-panel-history"'), "down to the last panel, History");
  assert.ok(board.includes("The tabs, the filters and every other decision wait until it is done."), "and the status line says so");
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
  assert.ok(bulk.includes("placeCheckReread.refreshNow(() => router.refresh());"), "the bulk bar's own read drops the waiting one first, through the one re-read");
  const notes = code("src/components/phoenix-crm/place-check-notes.tsx");
  assert.equal((notes.match(/placeCheckReread\.refreshNow\(\(\) => router\.refresh\(\)\);/g) ?? []).length, 2, "and so do both note saves");
  assert.equal((notes.match(/router\.refresh\(\)/g) ?? []).length, 2, "with no other refresh in the file");

  checkComingBackAfterDecisions(board);
}

// ── D3: the page he comes back to is never older than his decisions (owner, 22 Nov 2026: "I keep approving
// or rejecting … I turn around and do anything, and I come back … the same place … is as it is") ──────
function checkComingBackAfterDecisions(board: string) {
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
  const read = () => (reads += 1);
  const opened = "2026-11-22T19:20:00.000Z";
  const fresh = "2026-11-22T19:31:00.000Z";

  // His evening: the board opens, he approves and rejects, and leaves inside the quiet time.
  reread.showing(opened, read);
  assert.equal(reads, 0, "opening the board reads nothing");
  reread.ask(read);
  reread.ask(read);
  reread.cancel();
  assert.equal(reads, 0, "leaving drops the waiting timer, as D2 says");
  // He comes back, and the browser draws the copy from before his decisions.
  reread.showing(opened, read);
  assert.equal(reads, 1, "🔴 the old page drawn again reads the page at once — the decisions he left are owed");
  reread.showing(fresh, read);
  reread.showing(opened, read);
  assert.equal(reads, 1, "a page read after them settles them: nothing more is owed, even if an old copy shows later");

  // A page the server read after his decisions (the link after the router cache ran out) is not read twice.
  reread.ask(read);
  reread.cancel();
  reread.showing("2026-11-22T19:40:00.000Z", read);
  assert.equal(reads, 1, "a newer page settles the decision without a second read");

  // While he stays, the quiet-time read lands a newer page, which settles the run; a later remount is quiet.
  reread.showing("2026-11-22T19:41:00.000Z", read);
  reread.ask(read);
  for (const run of [...timers.values()]) run();
  assert.equal(reads, 2, "the quiet time's own read");
  reread.showing("2026-11-22T19:43:00.000Z", read);
  reread.showing("2026-11-22T19:43:00.000Z", read);
  assert.equal(reads, 2, "and the page it brought back owes nothing");

  // A coming-back read takes the place of a timer still waiting, so the same page is never read twice.
  reread.ask(read);
  assert.equal(timers.size, 1, "a decision waits");
  reread.showing("2026-11-22T19:43:00.000Z", read);
  assert.equal(reads, 3, "the same page drawn again reads now");
  assert.equal(timers.size, 0, "and the waiting timer goes with it");

  // A board with no stamp settles nothing and reads nothing.
  reread.ask(read);
  reread.cancel();
  reread.showing(null, read);
  assert.equal(reads, 3, "no stamp, no read");
  reread.showing("2026-11-22T19:43:00.000Z", read);
  assert.equal(reads, 4, "and the decision is still owed to the next stamped page");

  assert.ok(
    /useEffect\(\(\) => \{\s*shownReadAt\.current = readAt;\s*placeCheckReread\.showing\(readAt, \(\) => router\.refresh\(\)\);\s*\}, \[readAt, router\]\);/.test(board),
    "🔴 the board tells the re-read which page it draws, every time that page changes",
  );

  checkOwedReads(board);
}

// ── D5: every way a decision reaches the page is owed until a page read after it is drawn (22 Nov 2026, the
// deep audit of Place checks after "I come back … the same place … is as it is") ──────────────────────
function checkOwedReads(board: string) {
  const timers = new Map<number, () => void>();
  let next = 0;
  let told = 0;
  const reread = createPlaceCheckReread<number>(
    {
      clear: (handle) => void timers.delete(handle),
      set: (callback) => {
        next += 1;
        timers.set(next, callback);
        return next;
      },
    },
    30_000,
    () => (told += 1),
  );
  let reads = 0;
  const read = () => (reads += 1);
  const fire = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const run of due) run();
  };

  // A decision pressed while a read is already running: that read's page was built before the press.
  reread.showing("2026-11-22T20:00:00.000Z", read);
  reread.refreshNow(read);
  assert.equal(reads, 1, "a comment reads the page at once");
  reread.ask(read);
  reread.cancel();
  reread.showing("2026-11-22T20:00:20.000Z", read);
  assert.equal(reads, 2, "🔴 the page that read brings does not settle a decision pressed during it — it is read again");
  reread.showing("2026-11-22T20:00:40.000Z", read);
  reread.showing("2026-11-22T20:00:40.000Z", read);
  assert.equal(reads, 2, "and the page after that settles it");

  // The same, with the quiet time still waiting: its own read follows, so nothing is read twice.
  reread.refreshNow(read);
  reread.ask(read);
  reread.showing("2026-11-22T20:01:00.000Z", read);
  assert.equal(reads, 3, "the running read's page waits for the timer, which reads after it");
  fire();
  assert.equal(reads, 4, "the quiet time's own read");
  reread.showing("2026-11-22T20:01:40.000Z", read);
  reread.showing("2026-11-22T20:01:40.000Z", read);
  assert.equal(reads, 4, "settled");

  // A read now (a bulk run's end, a comment, a declaration) is owed like a decision.
  reread.refreshNow(read);
  assert.equal(reads, 5);
  reread.cancel();
  reread.showing("2026-11-22T20:01:40.000Z", read);
  assert.equal(reads, 6, "🔴 leaving before a bulk run's read landed still reads the page on coming back");
  reread.showing("2026-11-22T20:02:00.000Z", read);
  reread.showing("2026-11-22T20:02:00.000Z", read);
  assert.equal(reads, 6, "the page it brought settles it");

  // Shown again: never a second build while his own decision waits, or while a read runs.
  reread.ask(read);
  reread.shownAgain("2026-11-22T20:02:00.000Z", read);
  assert.equal(reads, 6, "🔴 looking away and back mid-run adds no build — the timer keeps its one read");
  assert.equal(timers.size, 1, "and the timer still waits");
  fire();
  assert.equal(reads, 7);
  reread.shownAgain("2026-11-22T20:02:00.000Z", read);
  assert.equal(reads, 7, "a read on its way brings the newer page itself");
  reread.showing("2026-11-22T20:02:40.000Z", read);
  reread.shownAgain("2026-11-22T20:02:40.000Z", read);
  assert.equal(reads, 7, "nothing owed, nothing read");

  // Another tab decided: owed here, read when this tab is shown again — never at once.
  const toldBefore = told;
  reread.owe();
  assert.equal(reads, 7, "🔴 a decision in another tab reads nothing at once — two windows side by side would rebuild per press");
  assert.equal(told, toldBefore, "🔴 and owing it never tells the other tabs again, or two tabs would echo for ever");
  reread.shownAgain("2026-11-22T20:02:40.000Z", read);
  assert.equal(reads, 8, "the tab shown again reads its page");
  reread.showing("2026-11-22T20:03:00.000Z", read);
  reread.shownAgain("2026-11-22T20:03:00.000Z", read);
  assert.equal(reads, 8, "once");

  // Every decision and every read now tells the other tabs.
  reread.ask(read);
  reread.refreshNow(read);
  assert.equal(told, toldBefore + 2, "a decision and a read now each tell the other tabs");

  assert.ok(board.includes("const stopHearing = hearOtherTabs(() => placeCheckReread.owe());"), "🔴 the board hears a decision made in another tab");
  assert.ok(
    /const back = \(\) => \{\s*if \(document\.visibilityState === "visible"\) placeCheckReread\.shownAgain\(shownReadAt\.current, \(\) => router\.refresh\(\)\);\s*\};/.test(board),
    "and reads what is owed when the tab is shown again",
  );
  assert.ok(board.includes('document.addEventListener("visibilitychange", back);') && board.includes('window.addEventListener("focus", back);'), "on visibility and on focus");
  assert.ok(code("src/components/phoenix-crm/place-check-reread.ts").includes('otherTabs()?.postMessage("decided");'), "the tab's one re-read tells the others");

  const bulk = code("src/components/phoenix-crm/place-check-bulk.tsx");
  assert.ok(/placeCheckReread\.cancel\(\);\s*placeCheckReread\.owe\(\);/.test(bulk), "🔴 a bulk run's rows are owed from its first one, so leaving mid-run never shows the old page again");
  assert.ok(code("src/components/phoenix-crm/shared-place-list.tsx").includes("placeCheckReread.refreshNow(() => router.refresh());"), "the no-timetable declaration reads through the one re-read");
  const done = code("src/components/phoenix-crm/place-check-done.tsx");
  assert.ok(
    /const pressedOn = typeof window === "undefined" \? null : window\.location\.pathname;\s*placeCheckReread\.ask\(\(\) => \{\s*if \(pressedOn === null \|\| window\.location\.pathname === pressedOn\) router\.refresh\(\);/.test(done),
    "🔴 a decision's quiet-time read refreshes only the page it was pressed on — never a page opened since",
  );
}

// ── D4: a new capture of a customer already decided says so (owner, 22 Nov 2026). A rejection sends the rep
// "Validate again" and he often captures the same door within the minute — 10 of 878 rejections within the
// hour on production — so the new row read exactly like the one just decided. ──────────────────────────
function checkEarlierDecision() {
  const decided = [
    { customerId: "c1", status: "approved" as const, decidedAt: "2026-11-10T08:00:00.000Z", deciderName: "Omar Gawish", refusalLabel: null },
    { customerId: "c1", status: "rejected" as const, decidedAt: "2026-11-22T19:10:00.000Z", deciderName: "Omar Gawish", refusalLabel: "No timetable in the photo" },
    { customerId: "c1", status: "approved" as const, decidedAt: "2026-11-22T19:30:00.000Z", deciderName: "Omar Gawish", refusalLabel: null },
    { customerId: "c2", status: "rejected" as const, decidedAt: "2026-11-22T19:00:00.000Z", deciderName: null, refusalLabel: null },
    { customerId: "c1", status: "rejected" as const, decidedAt: "not a date", deciderName: null, refusalLabel: null },
  ];
  const earlier = earlierDecisionOf("c1", "2026-11-22T19:11:00.000Z", decided);
  assert.equal(earlier?.decidedAt, "2026-11-22T19:10:00.000Z", "🔴 the latest decision BEFORE the capture, a minute earlier");
  assert.equal(earlier?.status, "rejected");
  assert.equal(earlierDecisionOf("c1", "2026-11-22T19:10:00.000Z", decided)?.status, "approved", "a decision at the same instant is not before it");
  assert.equal(earlierDecisionOf("c1", "2026-11-01T00:00:00.000Z", decided), null, "a customer decided only later has nothing earlier");
  assert.equal(earlierDecisionOf("c3", "2026-11-22T19:11:00.000Z", decided), null, "a customer never decided has nothing");
  assert.equal(earlierDecisionOf("c1", "garbage", decided), null, "a capture whose instant cannot be read says nothing");

  const text = earlierDecisionText({ ...(earlier as NonNullable<typeof earlier>), decidedAtText: "22 Nov 2026, 9:10 PM" });
  assert.equal(
    text,
    "An earlier photo of this customer was rejected by Omar Gawish on 22 Nov 2026, 9:10 PM (No timetable in the photo). This is a new capture.",
  );
  assert.equal(
    earlierDecisionText({ status: "approved", decidedAt: "x", decidedAtText: "10 Nov", deciderName: null, refusalLabel: "ignored" }),
    "An earlier photo of this customer was approved on 10 Nov. This is a new capture.",
    "no decider for a viewer who decides nothing, and no refusal reason on an approval",
  );

  const loader = code("src/lib/phoenix-crm/server/validation-reviews.ts");
  assert.ok(
    /await markDoorsCapturedAgain\(rows, reviews, placeById\);\s*await markEarlierDecisions\(rows, reviews, decides\);/.test(loader),
    "🔴 the board's read marks every waiting review with the decision before it",
  );
  const mark = fn(loader, "async function markEarlierDecisions(");
  assert.ok(mark.includes('row.status === "pending"'), "only a waiting review is marked");
  assert.ok(/names = decides \?/.test(mark), "the decider's name rides only to a viewer who decides");
  for (const [path, why] of [
    ["src/components/phoenix-crm/validation-review-queue.tsx", "the queue row"],
    ["src/components/place-review-deck/review-deck.tsx", "the one-by-one slide"],
    ["src/components/phoenix-crm/shared-place-customers.tsx", "a customer waiting in a building"],
  ] as const) {
    assert.ok(/earlierDecision \? [\s\S]{0,120}earlierDecisionText\(/.test(code(path)), `🔴 ${why} prints the earlier decision`);
  }
  assert.ok(
    code("src/lib/phoenix-crm/shared-place-groups.ts").includes('earlierDecision: state === "waiting" ? (row.earlierDecision ?? null) : null'),
    "a seated customer carries it only while waiting",
  );
}

export function runPhoenixCrmPlaceChecksAuditFixesTests() {
  checkCounts();
  checkDecisionPaths();
  checkWording();
  checkBackgroundRuns();
  checkEarlierDecision();
}
