import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { placeChecksBoardSets } from "../src/lib/phoenix-crm/place-checks-board-sets.ts";
import { mergedNoteIndex, PLACE_CHECKS_SUMMARY_ROUTE, placeChecksSummary } from "../src/lib/phoenix-crm/place-checks-on-demand.ts";
import { keptBySeatedDecisionsRead, REVIEW_SUBJECTS_SEATED_SELECT, REVIEW_SUBJECTS_SELECT } from "../src/lib/phoenix-crm/place-checks-slim-read.ts";
import { placeNoteSubjectKey } from "../src/lib/phoenix-crm/place-note-rules.ts";
import { keepPlaceChecksForTheClick, placeChecksHandoffKey, takePlaceChecksForTheClick } from "../src/lib/phoenix-crm/server/place-checks-handoff.ts";
import type { PlaceNoteIndex, ReopenedCustomerRow, SharedPlaceBoardRow, ValidatedPlaceRow, ValidationReviewRow } from "../src/lib/phoenix-crm/view-types.ts";
import { stripComments } from "./support/comment-strip.ts";
import { placeCheckBoardSource } from "./support/place-check-board-source.ts";

/**
 * Phoenix CRM — Place checks reads what it sends, and the wide read comes after the first row (owner,
 * 23 Nov 2026: "Fix speed next").
 *
 * Measured on production that day: 12.2 s to the first waiting place, 9.75 s of it two reads the page made
 * only to count the figures on its tabs and to leave rows for a click — every place in use (7,124, 13 MB)
 * and every decision ever made (2,377). The page now reads the places waiting, the 14-day decisions, the
 * buildings and the 513 places seated in them; the board asks for the figures once it is on screen, and
 * that read leaves its rows for the click. The one-by-one review opens on the press, and a phone's page
 * starts with the first waiting place instead of a screen of headings.
 *
 * What would break silently:
 * - the page reading every place in use or every decision again: nothing looks wrong, the 12 seconds come back;
 * - a tab showing a count taken from the few seated places while the figures are still being read, or a
 *   card showing 0 for a number that is not in yet;
 * - the figures' route answering somebody the page would have turned away, or sending the rows themselves;
 * - two wide reads in flight and the OLDER one kept for the click because it finished last;
 * - the click making the wide read a second time because it did not wait for the figures' read to end;
 * - a single clinic's comment or integrity case missing from its row, because the page no longer reads it;
 * - the page and the read behind it sorting rows by two rules, so a tab's count and its rows disagree;
 * - the phone's lane heads growing back to a screen of wrapped sentences above the first place;
 * - (23 Nov 2026, "Fix what is under 9.5") the page reading every decision of the last 14 days again to
 *   keep the third of them it sends, or the narrow read resting on the request alone, so a wider answer
 *   puts the single clinics' decisions back in the page;
 * - a phone's lane head, filter box or tab picker growing back to rows of their own above the first place.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

const PAGE = "app/(admin)/admin/field-crm/validation-reviews/page.tsx";

function checkThePageReadsWhatItSends() {
  const page = read(PAGE);
  assert.match(
    page,
    /const subjectReads = Promise\.all\(\[\s*loadValidationReviews\(viewer, \{ seatedDecisionsOnly: true \}\),\s*loadValidatedPlaces\(viewer, \{ seatedOnly: true \}\),\s*loadSharedPlaceBoard\(viewer\),\s*\]\);/,
    "🔴 the page reads the places waiting, the decisions and the places SEATED in a building, and the buildings: what it sends, and nothing else",
  );
  assert.ok(!page.includes("everyDecision"), "🔴 never every decision ever made (2,377 rows before the first waiting place)");
  assert.ok(!/loadValidatedPlaces\(viewer\)/.test(page), "🔴 never every place in use (7,124 places, 13 MB)");
  assert.ok(!page.includes("placeChecksSummary"), "🔴 the page counts no figure over rows it does not read");
  assert.ok(!page.includes("keepPlaceChecksForTheClick"), "and leaves nothing for the click: the figures' read does");
  assert.match(page, /const onDemand = \{ readAt: new Date\(\)\.toISOString\(\) \};/, "it tells the board only when it was read");
  assert.ok(page.includes("<PlaceChecksInUseFigures />"), "the two cards counted over every place in use are filled by the board");
  assert.ok(!page.includes('label="Validated, in use"') && !page.includes('label="Never looked at"'), "🔴 and are not counted here from the seated places alone");

  const loader = read("src/lib/phoenix-crm/server/validation-reviews/decided.ts");
  assert.match(loader, /const seatedOnly = options\?\.seatedOnly === true;/, "the narrow read is asked for by name, and only `true` asks for it");
  assert.ok(
    loader.includes('return (seatedOnly ? scoped.not("shared_place_id", "is", null) : scoped).order("id", { ascending: false });'),
    "🔴 the database answers the seated places alone: the filter is in the query, not made in code after reading them all",
  );

  const wide = read("src/lib/phoenix-crm/server/place-checks-wide-read.ts");
  assert.match(
    wide,
    /loadValidationReviews\(viewer, \{ everyDecision: true \}\),\s*loadValidatedPlaces\(viewer\),\s*loadSharedPlaceBoard\(viewer\),/,
    "🔴 the read behind the page is still every decision and every place in use: the figures are counted from all of them",
  );
  assert.ok(wide.includes("loadReopenedCustomers(viewer)"), "and the customers sent back, which History counts");
  assert.match(
    wide,
    /loadPlaceNoteIndex\(subjects, \{ viewerHrId: viewer\.hrId \}\), loadPlaceCheckIntegrity\(viewer, subjects\)/,
    "🔴 the comments and the evidence come with the rows, read for every row this read answers",
  );
  assert.ok(wide.includes("noteIndex: { ...notes, integrity },") && wide.includes("capped,"), "and are handed to the click with them, with whether a read stopped at its ceiling");
  const sorted = "placeChecksBoardSets({ decides, reviews: reviews.rows, sharedPlaces: sharedRead.rows, notes })";
  assert.ok(page.includes(sorted) && wide.includes(sorted), "🔴 the page and the read behind it sort their rows by ONE function, called the same way");
}

function checkTheFiguresRoute() {
  assert.equal(PLACE_CHECKS_SUMMARY_ROUTE, "/api/phoenix-crm/validation-reviews/summary", "the board asks the route that exists");
  const route = read("app/api/phoenix-crm/validation-reviews/summary/route.ts");
  const handler = route.slice(route.indexOf("export async function GET("));
  const order = [
    'assertPermission(access, "phoenix_crm", "approve")',
    "if (!readsCompanyPlaceChecks(viewer)) throw forbiddenError(",
    "const startedAt = Date.now();",
    "const wide = await readPlaceChecksWide(viewer);",
    "keepPlaceChecksForTheClick(placeChecksHandoffKey(viewer), wide.everything, startedAt);",
    "return NextResponse.json({ summary: wide.summary, success: true });",
  ].map((line) => handler.indexOf(line));
  assert.ok(order.every((at) => at > 0), "every step of the route is there");
  assert.deepEqual(order, [...order].sort((left, right) => left - right), "🔴 `approve`, then the board's reader, both before a row is read; the clock is read BEFORE the read starts; the rows are kept, and only the figures are sent");
  assert.ok(!/NextResponse\.json\(\{[^}]*everything/.test(handler), "🔴 the figures' answer never carries the rows: they were 13 MB");
  assert.ok(!/export async function (POST|PUT|PATCH|DELETE)/.test(route), "it reads and counts; nothing is decided here");

  const registry = read("src/lib/security/access-registry.ts");
  assert.ok(
    registry.includes(
      'sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/validation-reviews/summary", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: false })',
    ),
    "the route is registered with the same permission its handler asserts",
  );
}

/**
 * 🔴 THE PAGE READS THE DECISIONS IT SENDS, AND NO OTHERS (owner, 23 Nov 2026: "Fix what is under 9.5"). It
 * read all 1,184 decisions of the last 14 days to keep the 404 seated in a building and to count two cards
 * of the Figures tab: 2.9 of its seconds, its slowest read. The database now sends the seated ones alone,
 * the rows are narrowed again in code, and the two cards are counted by the read behind the page.
 */
function checkThePageReadsOnlyTheSeatedDecisions() {
  const queue = read("src/lib/phoenix-crm/server/validation-reviews/queue.ts");
  assert.match(queue, /const seatedDecisionsOnly = options\.seatedDecisionsOnly === true;/, "the narrow read is asked for by name, and only `true` asks for it");
  assert.match(
    queue,
    /const query = seatedDecisionsOnly && !waiting \? byStatus\.not\("place\.shared_place_id", "is", null\) : byStatus;\s*return seatScoped\(query, seats\)/,
    "🔴 the database answers the seated decisions alone, and every waiting review whole",
  );
  assert.match(
    queue,
    /\.select\(seatedDecisionsOnly && !waiting \? `\$\{REVIEW_COLUMNS\}, \$\{REVIEW_SUBJECTS_SEATED_SELECT\}` : `\$\{REVIEW_COLUMNS\}, \$\{REVIEW_SUBJECTS_SELECT\}`\)/,
    "🔴 with the place joined inner for that read: a filter on a plain join sends the review back with an empty place",
  );
  assert.match(
    queue,
    /if \(seatedDecisionsOnly\) \{\s*for \(const \[id, row\] of reviewById\) \{\s*if \(!keptBySeatedDecisionsRead\(row\)\) reviewById\.delete\(id\);/,
    "🔴 and the rows are narrowed again in code: the rule never rests on the request alone",
  );

  // The select the narrow read sends: the plain one, with the place's join made inner and nothing else changed.
  assert.equal(REVIEW_SUBJECTS_SELECT.split("!inner(").length - 1, 0, "the plain read joins nothing inner");
  assert.equal(REVIEW_SUBJECTS_SEATED_SELECT.split("!inner(").length - 1, 1, "the narrow read makes one join inner");
  assert.ok(REVIEW_SUBJECTS_SEATED_SELECT.includes("place:phoenix_crm_places!phoenix_crm_validation_reviews_place_id_fkey!inner("), "🔴 the place's");
  assert.equal(REVIEW_SUBJECTS_SEATED_SELECT.replace("_place_id_fkey!inner(", "_place_id_fkey("), REVIEW_SUBJECTS_SELECT, "and every column of the plain read is still asked for");

  assert.equal(keptBySeatedDecisionsRead({ status: "approved", place: { shared_place_id: "venue-1" } }), true, "a decision seated in a building is kept");
  assert.equal(keptBySeatedDecisionsRead({ status: "rejected", place: { shared_place_id: null } }), false, "🔴 a single clinic's decision is dropped, even when the request sent it");
  assert.equal(keptBySeatedDecisionsRead({ status: "approved", place: null }), false, "🔴 and so is a decision that came back with no place");
  assert.equal(keptBySeatedDecisionsRead({ status: "approved", place: { shared_place_id: "  " } }), false, "a blank building is no building");
  assert.equal(keptBySeatedDecisionsRead({ status: "pending", place: { shared_place_id: null } }), true, "🔴 a waiting review is kept wherever its place is: every one of them is his to decide");

  const page = read(PAGE);
  assert.ok(
    !page.includes("realDecided") && !page.includes('label="Approved, last 14 days"') && !page.includes('label="Rejected, last 14 days"'),
    "🔴 the page counts no card from the decisions it no longer reads",
  );
  const cards = read("src/components/phoenix-crm/place-checks/in-use-figures.tsx");
  for (const label of ['label="Approved, last 14 days"', 'label="Rejected, last 14 days"', 'label="Validated, in use"', 'label="Never looked at"']) {
    assert.ok(cards.includes(label), `the board's figures fill ${label}`);
  }
  assert.ok(
    cards.includes("value={figureOrWord(state, (figures) => figures.approved)}") && cards.includes("value={figureOrWord(state, (figures) => figures.rejected)}"),
    "🔴 the two decision cards show their number or the word: never a 0 while it is being counted",
  );
  assert.ok(cards.includes('"Counting every decision."'), "and say what is being counted");
}

function checkTheReadThatStartedLaterIsKept() {
  const person = placeChecksHandoffKey({ hrId: "FIRST-READ-1", role: "Super Admin", isTestPersona: false } as never);
  const rows = (tag: string) => ({
    validated: [{ placeId: tag } as unknown as ValidatedPlaceRow],
    olderDecided: [],
    decisionFigures: { approved: 0, rejected: 0 },
    noteIndex: { notes: {}, recommendations: {}, integrity: {} } as unknown as PlaceNoteIndex,
    capped: { reviews: false, validated: false },
  });
  const t0 = 5_000_000;
  // He decides while the opening's read is still on its way: the board asks again, and that second read
  // (started at t0 + 4 s) answers before the first one (started at t0) does.
  keepPlaceChecksForTheClick(person, rows("started-later"), t0 + 4_000);
  keepPlaceChecksForTheClick(person, rows("started-earlier"), t0);
  assert.equal(
    takePlaceChecksForTheClick(person, t0 + 11_000)?.validated[0].placeId,
    "started-later",
    "🔴 the rows kept are the ones read AFTER his decision, although the older read finished last",
  );
  keepPlaceChecksForTheClick(person, rows("one"), t0 + 20_000);
  keepPlaceChecksForTheClick(person, rows("two"), t0 + 20_000);
  assert.equal(takePlaceChecksForTheClick(person, t0 + 21_000)?.validated[0].placeId, "two", "a read that started at the same moment or later replaces the one kept");
}

function checkTheNotesComeWithTheRows() {
  const note = (body: string) => [{ body }];
  const page = {
    notes: { "place:on-both": note("the page's, read after his decision") },
    recommendations: { "place:on-both": [{ recommendation: "validate" }] },
    integrity: { "place:on-both": { open: 1 } },
  } as unknown as PlaceNoteIndex;
  const click = {
    notes: { "place:on-both": note("the click's, older"), "place:single-clinic": note("a single clinic's comment") },
    recommendations: { "place:on-both": [{ recommendation: "reject" }], "place:single-clinic": [{ recommendation: "reject" }] },
    integrity: { "place:on-both": { open: 9 }, "place:single-clinic": { open: 2 } },
  } as unknown as PlaceNoteIndex;
  assert.equal(mergedNoteIndex(page, null), page, "before the click the index is the page's own, the same object");
  const merged = mergedNoteIndex(page, click);
  assert.deepEqual(merged.notes["place:single-clinic"], click.notes["place:single-clinic"], "🔴 a single clinic's comment arrives with its row: the page no longer reads it");
  assert.deepEqual(merged.integrity["place:single-clinic"], click.integrity["place:single-clinic"], "and so does its integrity case");
  assert.deepEqual(merged.recommendations["place:single-clinic"], click.recommendations["place:single-clinic"], "and what a manager recommended on it");
  assert.deepEqual(
    [merged.notes["place:on-both"], merged.recommendations["place:on-both"], merged.integrity["place:on-both"]],
    [page.notes["place:on-both"], page.recommendations["place:on-both"], page.integrity["place:on-both"]],
    "🔴 a subject in both is the page's: the page is read again after every decision",
  );
  assert.deepEqual([Object.keys(page.notes), Object.keys(click.notes).length], [["place:on-both"], 2], "neither index is changed by the merge");
}

function checkTheBoardSets() {
  const reviewRow = (id: string, fields: Record<string, unknown> = {}) =>
    ({ reviewId: id, placeId: `p-${id}`, status: "pending", isTest: false, decisionNote: null, ...fields }) as unknown as ValidationReviewRow;
  const building = (id: string, status: string, fields: Record<string, unknown> = {}) =>
    ({ sharedPlaceId: id, status, isTest: false, decisionNote: null, ...fields }) as unknown as SharedPlaceBoardRow;
  const said = (writerRole: string, recommendation: string) => ({ writerRole, recommendation, managerName: "x", decidedAtText: "x", mine: false });
  const key = { place: (id: string) => placeNoteSubjectKey("place", `p-${id}`), building: (id: string) => placeNoteSubjectKey("shared_place", id) };

  const reviews = [
    reviewRow("plain"),
    reviewRow("sfe"),
    reviewRow("sfe-test", { isTest: true }),
    reviewRow("district"),
    reviewRow("decided", { status: "approved", decisionNote: " The sign is hidden. " }),
    reviewRow("decided-other", { status: "rejected", decisionNote: "Written for the record" }),
  ];
  const sharedPlaces = [
    building("held", "held"),
    building("held-sfe", "held"),
    building("active", "active", { decisionNote: "Two doors, one sign." }),
    building("retired", "retired"),
  ];
  const notes = {
    notes: { [key.place("decided")]: [{ body: "The sign is hidden." }], [key.building("active")]: [{ body: "Two doors, one sign." }] },
    recommendations: {
      [key.place("sfe")]: [said("sfe_manager", "validate")],
      [key.place("sfe-test")]: [said("sfe_manager", "reject")],
      [key.place("district")]: [said("district_manager", "reject")],
      [key.building("held-sfe")]: [said("sfe_manager", "reject")],
    },
  } as unknown as Pick<PlaceNoteIndex, "notes" | "recommendations">;
  const ids = (rows: ReadonlyArray<ValidationReviewRow>) => rows.map((row) => row.reviewId);
  const venues = (rows: ReadonlyArray<SharedPlaceBoardRow>) => rows.map((row) => row.sharedPlaceId);

  const superAdmin = placeChecksBoardSets({ decides: true, reviews, sharedPlaces, notes });
  assert.deepEqual(ids(superAdmin.waiting), ["plain", "district"], "🔴 what the SFE Manager recommended on waits on its own page, not on the Super Admin's board; a district manager's word moves nothing");
  assert.deepEqual(venues(superAdmin.sharedPlaces), ["held", "active", "retired"], "🔴 and so does a held building he recommended on; every building that is not held stays");
  assert.equal(superAdmin.sfeRecommendedCount, 2, "the link to that page counts the real ones: one place and one building, never the test entry");
  assert.deepEqual(ids(superAdmin.decided), ["decided", "decided-other"], "every row that is not waiting is a decision");
  assert.deepEqual(
    superAdmin.decided.map((row) => row.decisionNote),
    [null, "Written for the record"],
    "🔴 a decision note that is already a comment on the row is not drawn a second time; any other note stays",
  );
  assert.equal(superAdmin.sharedPlaces.find((row) => row.sharedPlaceId === "active")?.decisionNote, null, "the same for a building's");
  assert.equal(superAdmin.rows.length, reviews.length, "no row is lost between what was read and what is sorted");

  const sfeManager = placeChecksBoardSets({ decides: false, reviews, sharedPlaces, notes });
  assert.deepEqual(ids(sfeManager.waiting), ["plain", "sfe", "sfe-test", "district"], "🔴 the SFE Manager keeps every row: he can see and change what he recommended");
  assert.deepEqual(venues(sfeManager.sharedPlaces), ["held", "held-sfe", "active", "retired"], "and every building");
  assert.equal(sfeManager.sfeRecommendedCount, superAdmin.sfeRecommendedCount, "the count is of what he recommended, whoever reads it");
}

function checkNoCountBeforeTheFigures() {
  // The two "in use" figures, counted by the same function as every other figure, over every real place.
  const inUse = (placeId: string, fields: Record<string, unknown> = {}) =>
    ({ placeId, sharedPlaceId: null, isTest: false, reviewed: false, repName: "Rep", line: "CNS", region: "Cairo", listType: "AM", areaName: "A", photoKind: "signboard", signboard: { verdict: "match", reason: null, signText: "x" }, schedule: null, ...fields }) as unknown as ValidatedPlaceRow;
  const validated = [inUse("seen", { reviewed: true }), inUse("never-seen"), inUse("seated-never-seen", { sharedPlaceId: "v1" }), inUse("test", { isTest: true })];
  const building = { sharedPlaceId: "v1", isTest: false, status: "active", repName: "Rep", line: "CNS", region: "Cairo", areaName: "A", decidedByName: null } as unknown as SharedPlaceBoardRow;
  const counted = placeChecksSummary({ team: false, lanes: true, pending: [], decided: [], validated, reopened: [] as ReopenedCustomerRow[], sharedPlaces: [building] });
  assert.deepEqual([counted.inUse, counted.unseen], [3, 2], "🔴 Validated, in use is every real place, seated or not; Never looked at is the ones with no review of any kind");
  assert.deepEqual(counted.capped, { reviews: false, validated: false }, "a read that did not stop at its ceiling says so");
  const atCeiling = placeChecksSummary({ team: false, pending: [], decided: [], validated, reopened: [], sharedPlaces: [building], capped: { reviews: false, validated: true } });
  assert.deepEqual(atCeiling.capped, { reviews: false, validated: true }, "🔴 and one that did is carried to the board, which says the page shows the newest rows only");

  const board = placeCheckBoardSource(read);
  assert.ok(board.includes('useCrmGet<PlaceChecksSummary>(onDemand ? PLACE_CHECKS_SUMMARY_ROUTE : null, "summary")'), "🔴 the board asks for the figures itself, once it is on screen, under the key the route answers");
  assert.ok(!board.includes("onDemand.summary"), "🔴 and is no longer handed them by the page");
  assert.match(board, /onDemand\?: \{ readAt: string \};/, "the page hands it only the moment it was read");
  assert.match(board, /const summarySettled = !summaryRead\.loading;/, "🔴 the click's read waits for the figures' read to end, so ONE wide read serves both");
  assert.match(board, /if \(wanted\) reloadEverything\(\);\s*else reloadSummary\(\);/, "🔴 after a decision re-reads the page the board asks again for the rows it holds, else for the figures: never both, each is the wide read");
  assert.match(board, /const summary = onDemand \? summaryRead\.data : null;/, "a manager's board, handed every row, has no figures' read at all");

  assert.match(board, /const counted = !complete && !filtering \? summary : null;/, "until the rows are in, a count is the figures' read, and nothing while that is on its way");
  assert.ok(
    board.includes("const unconfirmedCount = complete ? unconfirmedOpenCount(inUse, filters) : counted ? counted.unconfirmed : null;"),
    "🔴 Not confirmed shows NO count before the figures answer: never one taken from the seated places",
  );
  assert.ok(
    board.includes("const decidedCount = (own: number, server: (figures: NonNullable<typeof counted>) => number) => (complete ? shown(own) : counted ? server(counted) : null);"),
    "🔴 nor do History and Approved by the system",
  );
  assert.ok(board.includes("const scorecard = countedScorecard ?? (summary && !filtering ? summary.scorecard : null);"), "🔴 the scorecard is the rows' own count, else the figures' read, else nothing");
  assert.ok(board.includes("complete || !summary ? counted : summary.options"), "the filter lists are counted from what the board holds until the figures bring the whole lists");
  assert.match(board, /\{!scorecard && !reading && !summaryError \? <ScorecardBeingCounted \/> : null\}/, "the scorecard tab says it is being counted: never an empty tab");

  // 🔴 A FIGURE THAT IS NOT IN YET IS NEVER A ZERO.
  assert.match(
    board,
    /export function figureOrWord\(state: PlaceChecksInUseFigureState \| null, pick: \(figures: PlaceChecksFigures\) => number\): number \| string \{\s*if \(state\?\.figures\) return pick\(state\.figures\);\s*return state\?\.failed \? "Not counted" : "Counting";\s*\}/,
    "🔴 a card shows its number, or the word Counting, or Not counted: never 0 for a number it does not hold",
  );
  assert.match(
    board,
    /everything\s*\? \{ inUse: validated\.length, unseen: validated\.filter\(\(row\) => !row\.reviewed\)\.length, \.\.\.everything\.decisionFigures \}\s*: summary\s*\? \{ inUse: summary\.inUse, unseen: summary\.unseen, \.\.\.summary\.decisionFigures \}\s*: null/,
    "the cards read the rows once they are in, else the figures, else nothing; the two decision cards are the wide read's count either way",
  );
  assert.ok(board.includes("<PlaceChecksInUseFiguresProvider value={{ figures: inUseFigures, failed: summaryError !== null }}>"), "the board hands the cards their figures, and whether the read failed");
  assert.ok(
    board.includes("{summaryError !== null && !complete ? <FiguresNotCounted error={summaryError} onRetry={reloadSummary} /> : null}"),
    "🔴 a failed figures read says which numbers are missing and offers Try again; with the rows in hand the board counts for itself and says nothing",
  );
  assert.match(board, /The places waiting for you below are\s+complete\./, "and says the waiting places are whole, so he keeps deciding");
  // 🔴 A RE-READ OF THE FIGURES THAT FAILS IS SAID TOO. After a decision the board counts again; the last
  // answer stays on screen when that fails, so without this the tabs showed the old numbers and no notice.
  assert.match(board, /const summaryStale = onDemand && summary !== null \? summaryRead\.error : null;/, "🔴 figures on screen whose re-read failed are known to be older than his last decision");
  assert.ok(
    board.includes("{summaryStale !== null && !complete ? <FiguresNotCounted error={summaryStale} onRetry={reloadSummary} stale /> : null}"),
    "🔴 and the board says so, with Try again; with the rows in hand it counts for itself",
  );
  assert.ok(board.includes('{stale ? "They stand as they were before your last decision. " : ""}'), "in words: the numbers stand as they were before his last decision");
  assert.match(
    board,
    /reviews: props\.capped\.reviews \|\| Boolean\(summary\?\.capped\.reviews\) \|\| Boolean\(everything\?\.capped\.reviews\),\s*validated: props\.capped\.validated \|\| Boolean\(summary\?\.capped\.validated\) \|\| Boolean\(everything\?\.capped\.validated\),/,
    "a wide read that stopped at its ceiling raises the board's notice, whichever read brought it",
  );
  assert.match(board, /const noteIndex = useMemo\(\(\) => mergedNoteIndex\(props\.noteIndex, clickNotes\), \[props\.noteIndex, clickNotes\]\);/, "🔴 the board draws every row from the merged notes");
}

/**
 * 🔴 THE PHONE'S TOP (owner, 23 Nov 2026: "Fix speed next"). Measured at 375 on the live page before this:
 * the lane heads were 241 px and 221 px, the title band 309 px, and the first waiting card started at 870
 * of an 812 px screen. Each sentence below was three or four wrapped lines of that. A desktop keeps them all.
 */
function checkThePhoneTop() {
  const raw = (path: string) => readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");

  const bulk = raw("src/components/phoenix-crm/place-check-bulk.tsx");
  assert.ok(bulk.includes("const foldedOnPhone = inTitleRow && picked.length === 0 && !lineOpen;"), "🔴 in a title row, with nothing ticked, a phone's pick line is folded until it is pressed");
  assert.ok(bulk.includes('<div className={foldedOnPhone ? "hidden sm:contents" : "contents"} data-pick-line-body>'), "folded on a phone only: a desktop draws the line whole, in the row, as before");
  assert.match(
    bulk,
    /\{inTitleRow && picked\.length === 0 \? \(\s*<CrmButton aria-expanded=\{lineOpen\} className="min-h-11 sm:hidden" data-pick-line-toggle disabled=\{busy\} onClick=\{\(\) => setLineOpen\(!lineOpen\)\} size="sm">/,
    "🔴 one button stands for it on a phone, says whether it is open, and waits with every other control during a run",
  );
  assert.ok(bulk.includes("`Answer several together (${picks.selectable})`"), "and says how many rows can be answered together");
  assert.ok(bulk.indexOf("const [lineOpen, setLineOpen] = useState(false);") < bulk.indexOf("if (picks.selectable === 0) return null;"), "its state is declared before the bar's early return, as a hook must be");

  const ready = raw("src/components/phoenix-crm/place-checks/ready-lane-bar.tsx");
  assert.match(
    ready,
    /<span className="max-sm:hidden">\s*Every check passed on these, and you have approved this kind of evidence at least 19 times in 20\. Nothing is approved until you press\.\s*<\/span>\s*<span className="sm:hidden">Nothing is approved until you press\.<\/span>/,
    "🔴 the Ready lane keeps the half that is a rule on a phone: nothing is approved until he presses",
  );

  const needs = raw("src/components/phoenix-crm/place-checks/needs-panel.tsx");
  assert.ok(needs.includes('<span className="min-w-0 flex-1 basis-60 break-words group-open:hidden max-sm:hidden">'), "on a phone the commonest reason waits for the press with the others");
  // 🔴 THE FOLD IS ONE SHORT PRESS ON A PHONE (owner, 23 Nov 2026: "Fix what is under 9.5"). At 375 px the
  // lane's head was three rows, 137 px: its title, "Why these are your call", "Answer several together".
  assert.ok(
    needs.includes('<span className={reasons.length > 1 ? "font-black text-slate-900 max-sm:hidden max-sm:group-open:inline" : "font-black text-slate-900"}>Why these are your call</span>'),
    "🔴 with several reasons a phone's closed fold drops its title, which the press says; with one reason the title is all there is, and stays",
  );
  assert.match(
    needs,
    /<span className="sm:hidden">Why: \{reasons\.length\} reasons<\/span>\s*<span className="max-sm:hidden">All \{reasons\.length\} reasons<\/span>/,
    "🔴 on a phone the press says what it opens, since no title stands beside it",
  );
  assert.ok(needs.includes('<span className="shrink-0 text-xs font-black text-orange-700 max-sm:group-open:ml-auto">'), "and it never pushes itself to the far edge of a row it shares with the pick button");

  const section = raw("src/components/phoenix-crm/place-checks/section.tsx");
  assert.ok(section.includes('const fold = lane !== null && typeof lane !== "string";'), "a lane's fold is told from a lane's plain sentence");
  assert.match(
    section,
    /"min-w-0 flex-1 basis-60 break-words text-sm text-slate-600",\s*fold \? "max-sm:basis-auto max-sm:has-\[details\[open\]\]:basis-full" : "max-sm:hidden",/,
    "🔴 a lane's plain sentence is a desktop's; its fold is as wide as its words on a phone, and takes a row of its own only while it is open",
  );
  assert.ok(
    section.includes('<div className={cn("flex min-w-0 items-center gap-2.5", fold && "max-sm:w-full")}>'),
    "🔴 the title takes the first row on a phone, so the fold and the pick button share the second (137 px to 89)",
  );
  assert.ok(
    section.includes('{action ? <div className={cn("min-w-0 sm:w-auto", fold ? "max-sm:max-w-full" : "w-full")}>{action}</div> : null}'),
    "🔴 beside a fold the pick button is as wide as its words; with no fold it keeps the row, as before",
  );

  const header = raw("src/components/phoenix-crm/place-checks/desk-header.tsx");
  assert.match(
    header,
    /<span className="max-sm:hidden">\s*\{sfeRecommended\.count\} more[\s\S]{0,260}?<\/span>\s*<span className="sm:hidden">\{sfeRecommended\.count\} more: <\/span>\s*<Link /,
    "🔴 on a phone the SFE line is the count and the link, on one line: both screens say how many, and both link to the page",
  );

  // 🔴 A PHONE'S FILTERS ARE ONE BUTTON BESIDE THE TAB PICKER (owner, 23 Nov 2026: "Fix what is under 9.5").
  // The folded box was 94 px and a gap above the first waiting place, to say "Showing everything", and the
  // picker's label another 20.
  const strip = raw("src/components/phoenix-crm/place-checks/tab-strip.tsx");
  const filterBar = raw("src/components/phoenix-crm/place-checks/filter-bar.tsx");
  assert.match(
    strip,
    /\{lanes \? \(\s*<div className="flex min-w-0 items-center gap-2 sm:hidden" data-tab-picker>\s*<label className="sr-only" htmlFor="vr-tab-select">\s*Showing\s*<\/label>\s*<div className="min-w-0 flex-1">\{picker\}<\/div>\s*<PlaceCheckFilterToggle board=\{board\} \/>\s*<\/div>/,
    "🔴 on the Super Admin's board a phone's row is the picker, named for a screen reader, and the Filters button beside it",
  );
  assert.match(
    strip,
    /\) : \(\s*<div className="min-w-0 sm:hidden">\s*<CrmField htmlFor="vr-tab-select" label="Showing">\s*\{picker\}\s*<\/CrmField>\s*<\/div>\s*\)\}/,
    "🔴 a board with no lanes (a district manager's) keeps the picker under its visible label, and gets no button: its filter bar is whole",
  );
  assert.equal(strip.split('id="vr-tab-select"').length - 1, 1, "one picker, drawn in whichever row the board has");
  assert.match(
    filterBar,
    /export function PlaceCheckFilterToggle\(\{ board \}: \{ board: PlaceCheckBoard \}\) \{[\s\S]{0,330}aria-expanded=\{filtersOpen\}\s*className="min-h-11 shrink-0"\s*data-filter-toggle\s*onClick=\{\(\) => setFiltersOpen\(\(current\) => !current\)\}/,
    "🔴 it is 44 px tall, says whether the boxes are open, and opens the same boxes",
  );
  assert.ok(
    filterBar.includes('{filtersOpen ? "Hide filters" : narrowedBy.length > 0 ? `Filters (${narrowedBy.length})` : "Filters"}'),
    "🔴 and counts what narrows the board, so a narrowed board never looks whole",
  );
  assert.ok(
    filterBar.includes('lanes && !filtersOpen && (narrowedBy.length === 0 ? "hidden" : "sm:hidden")'),
    "🔴 closed, the box is drawn on a phone only while something narrows the board: what narrows it is never hidden",
  );
  assert.ok(filterBar.includes("const ownToggle = inStrip || !lanes;") && filterBar.includes("{ownToggle ? ("), "the boxed line draws no second button on that board; a board with no lanes keeps its own");
  const shell = raw("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(shell.includes("{lanes ? null : <PlaceCheckFilterBar board={board} />}"), "a board with no lanes keeps its filter bar whole, above the tabs");
  assert.ok(
    shell.indexOf("{lanes ? <PlaceCheckFilterBar board={board} /> : null}") > shell.indexOf("<PlaceCheckTabStrip board={board} />"),
    "🔴 with lanes the boxes open under the strip that holds their button",
  );

  // 🔴 A CLOSED CARD IS A SHORT ONE (owner, 23 Nov 2026: "Fix what is under 9.5"). At 375 px a closed clinic
  // card was 189 to 300 px and a closed building 256 to 300: the whole block, one fact to a line.
  const who = raw("src/components/phoenix-crm/validation-review-queue-evidence.tsx");
  const whoParts = who.slice(who.indexOf("function Who("), who.lastIndexOf('<div className="min-w-0 space-y-1">'));
  const whoWhole = who.slice(who.lastIndexOf('<div className="min-w-0 space-y-1">'), who.indexOf("function Evidence("));
  for (const field of ["row.customerName", "row.listType", "row.repName", "row.territory", "row.createdAtText", "row.waitingText", "row.earlierDecision", "row.systemStillReading", "row.isTest"]) {
    assert.ok((whoWhole.includes(field) || field === "row.listType") && whoParts.includes(field), `🔴 ${field} is on the table's block and on the phone card, closed or opened: nothing is dropped`);
  }
  const whoSummary = whoParts.slice(whoParts.indexOf('if (part === "summary")'));
  assert.ok(whoSummary.includes('<CrmPill tone="warn">{earlierDecisionShort(row.earlierDecision)}</CrmPill>'), "🔴 a closed card still says the customer was decided before (owner, 22 Nov 2026)");
  assert.ok(!whoSummary.includes("row.createdAtText") && !whoSummary.includes("earlierDecisionText("), "the capture time and the full sentence wait inside the card");
  const whoRest = whoParts.slice(whoParts.indexOf('if (part === "rest")'), whoParts.indexOf('if (part === "summary")'));
  assert.ok(whoRest.includes("Captured {row.createdAtText}") && whoRest.includes("{earlierDecisionText(row.earlierDecision)}"), "🔴 and are the first lines of the opened card");
  const clinicCards = raw("src/components/phoenix-crm/validation-review-queue.tsx");
  assert.match(clinicCards, /summary=\{\s*<Who part="summary" row=\{row\}>/, "🔴 a closed clinic card draws the short block");
  assert.ok(clinicCards.indexOf('<Who part="rest" row={row} />') > clinicCards.indexOf('<Who part="summary" row={row}>'), "and the opened card the rest");
  assert.ok(clinicCards.indexOf('<Who part="rest" row={row} />') < clinicCards.indexOf("</CrmCardsOnPhone>"), "on a phone only");
  assert.ok(clinicCards.slice(clinicCards.indexOf("</CrmCardsOnPhone>")).includes("<Who row={row} />"), "🔴 the desktop table draws the block whole, as before");
  const venue = raw("src/components/phoenix-crm/shared-place-list-evidence.tsx");
  assert.ok(venue.includes("{where && part !== \"summary\" ? ("), "a closed building leaves its address for the opened card");
  assert.ok(venue.includes("part === \"summary\" ? `${row.repName} · ${row.territory}` : `${row.repName} · ${row.territory} · Captured ${row.capturedAtText}`"), "and its capture time");
  assert.match(venue, /if \(part === "rest"\) \{[\s\S]{0,200}Captured \{row\.capturedAtText\}[\s\S]{0,200}\{where\}/, "🔴 which are the first lines inside it: nothing is dropped");

  const title = raw("src/components/place-review-deck/place-checks-with-deck.tsx");
  assert.ok(
    title.includes('className="max-sm:[&_h1+p]:hidden max-sm:[&>div:first-child]:gap-2 max-sm:[&>div:first-child]:pb-2"'),
    "🔴 on a phone the band is the title and the board's one line; the classes reach the title row alone, never the hairline rule under it",
  );
  assert.ok(!title.includes("max-sm:[&>div]:"), "🔴 never every child of the band: padding on the hairline rule would draw it eight pixels thick on a phone");
  assert.ok(title.includes("description={title.description}"), "the sentence under the title is still handed in: a desktop draws it");
  assert.ok(title.includes("hero={(line) => <PlaceChecksTitle line={line} title={title} />}"), "and the board draws that band around its one line");
  // The band's own markup, which those classes are written against: a title row first, then the rule.
  const hero = raw("src/components/admin/admin-design-system.tsx");
  const band = hero.slice(hero.indexOf("export function AdminPageHero("), hero.indexOf("export function AdminInsightChip("));
  assert.match(band, /<section className=\{cn\("min-w-0", className\)\}>\s*<div\s/, "the band's first child is the title row");
  assert.match(band, /<h1 className=\{pageHeaderTitleClassName\}>\{title\}<\/h1>\s*<p className=\{pageHeaderDescriptionClassName\}>\{description\}<\/p>/, "the sentence is the paragraph right after the title");
  assert.match(band, /<\/div>\s*<div aria-hidden="true" className=\{pageHeaderRuleClassName\} \/>\s*<\/section>/, "and the rule is its second and last child");
}

export async function runPhoenixCrmPlaceChecksFirstReadTests() {
  checkThePageReadsWhatItSends();
  checkThePageReadsOnlyTheSeatedDecisions();
  checkTheFiguresRoute();
  checkTheReadThatStartedLaterIsKept();
  checkTheNotesComeWithTheRows();
  checkTheBoardSets();
  checkNoCountBeforeTheFigures();
  checkThePhoneTop();
}
