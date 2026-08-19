import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The Marketing Case File SCREEN.
//
// The data layer (tests/marketing-case-file.test.ts) proves the contract: every fallible section is
// `ok` | `unavailable` | `not_applicable`, and every check is `clear` | `flagged` | `unavailable`.
// That contract buys nothing if the screen paints two of the three arms the same — which is exactly
// the defect being fixed. The screen this replaces renders a failed check, a check that could not
// run, and a clean pass identically, so a read that fell over gets acted on as a result.
//
// So this file asserts the RENDERING rule the data layer cannot:
//
//  1. THREE STATES, THREE LOOKS. Every CaseFileBlock the contract declares is routed through the
//     one primitive that switches on `state`, `unavailable` never borrows `clear`'s or `ok`'s
//     appearance, and no section folds a block to a fallback value.
//  2. A REJECTED REQUEST HAS A SURFACE. Who refused it, when, and why — the lifecycle stage with no
//     surface anywhere in the product today, because a rejected request drops out of the
//     requester's workspace entirely.
//  3. The house rules that are checkable from source: desktop tables / mobile cards, no ellipsis,
//     Africa/Cairo timestamps, no raw enum on screen, and no navigation entry added.
//
// Checked as source text because the harness runs `node --experimental-strip-types`, which cannot
// load a .tsx at all. That is enough for "is the branch there and is it different"; it is NOT a
// claim about how the screen looks, and nothing here pretends otherwise.
// ─────────────────────────────────────────────────────────────────────────────

const PRIMITIVES = "../src/components/marketing-requests/case-file-primitives.tsx";
const SCREEN = "../src/components/marketing-requests/marketing-request-case-file.tsx";
const CONTRACT = "../src/lib/marketing-requests/case-file-types.ts";
const NAVIGATION = "../src/config/system-navigation.ts";

const MOUNTS = [
  "../app/(admin)/admin/marketing-requests/[requestId]/page.tsx",
  "../app/employee-portals/marketing-requests/[requestId]/page.tsx",
  "../app/(admin)/workspace/marketing-requests/[requestId]/page.tsx",
];

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/**
 * The same source with its comments removed.
 *
 * Needed for the rules stated as "this class must never appear": the primitives file explains in
 * prose why it dropped Tailwind's `truncate`, and a file-wide match cannot tell the explanation
 * apart from the offence.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The body of one top-level function, so a branch can be asserted where it actually lives. */
function fn(source: string, name: string): string {
  // Tolerates a generic parameter list — `function CaseFileBlockView<T>(` is still that function.
  const start = source.search(new RegExp(`function ${name}(?:<[^>]*>)?\\(`));
  assert.notEqual(start, -1, `expected a function named ${name} in the source under test`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:export )?(?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

// ── 1. the three block states ────────────────────────────────────────────────

/**
 * `unavailable` and `not_applicable` must not look alike, and neither may look like an empty `ok`.
 *
 * The dashed border is load-bearing rather than decorative: it is the one cue a reader gets WITHOUT
 * reading a word that the screen is admitting it does not know, instead of reporting a result.
 */
function testTheTwoNonOkStatesRenderDifferently() {
  const source = read(PRIMITIVES);
  const notice = fn(source, "BlockNotice");

  assert.match(
    notice,
    /state === "unavailable"/,
    "BlockNotice must branch on the state: rendering `unavailable` and `not_applicable` through one shared style is the defect this screen exists to fix",
  );

  const classes = [...notice.matchAll(/"([^"]*(?:border|bg-)[^"]*)"/g)].map((match) => match[1]);
  const dashed = classes.filter((value) => value.includes("border-dashed"));
  const solid = classes.filter((value) => /\bbg-sky-50\b/.test(value) && !value.includes("border-dashed"));
  assert.ok(
    dashed.length > 0,
    "the `unavailable` arm must carry a dashed border — the one cue that reads as 'we could not find out' before a single word is read",
  );
  assert.ok(
    solid.length > 0,
    "the `not_applicable` arm must have its OWN solid treatment, distinct from the dashed `unavailable` arm",
  );
  for (const dashedClass of dashed) {
    for (const solidClass of solid) {
      assert.notEqual(
        dashedClass,
        solidClass,
        "`unavailable` and `not_applicable` must not share a class string: same pixels, opposite meanings, real money",
      );
    }
  }

  assert.match(
    notice,
    /data-case-file-block-state=\{state\}/,
    "BlockNotice must stamp the state it rendered, so the three arms stay distinguishable in the DOM and not only by colour",
  );
  assert.match(
    notice,
    /\{reason\}/,
    "BlockNotice must render the service's `reason` verbatim — it is already a full sentence, and summarising it back into a dash is how an empty state stops explaining itself",
  );

  // Two different headline words, or the two arms read the same at a glance regardless of colour.
  const headlines = [...source.matchAll(/^\s+(not_applicable|unavailable): "([^"]+)",$/gm)].map((match) => match[2]);
  assert.equal(headlines.length, 2, "both non-ok arms need their own headline word");
  assert.notEqual(headlines[0], headlines[1], "`unavailable` and `not_applicable` must not share a headline word");
}

/**
 * Every block in the contract is rendered as a block.
 *
 * Counted against the CONTRACT rather than a number typed here, so adding a block to the data layer
 * fails this test until the screen renders it — which is the only way a new fallible section cannot
 * quietly ship as a silent empty.
 */
function testEveryBlockInTheContractIsRenderedThroughTheStateSwitch() {
  const contract = read(CONTRACT);
  const screen = read(SCREEN);

  const declaredBlocks = [...contract.matchAll(/^\s+\w+: CaseFileBlock</gm)].length;
  assert.ok(declaredBlocks >= 10, `the contract should declare at least 10 blocks (found ${declaredBlocks})`);

  const rendered = [...screen.matchAll(/<CaseFileBlockView\b/g)].length;
  assert.equal(
    rendered,
    declaredBlocks,
    `every CaseFileBlock the contract declares must be rendered through CaseFileBlockView: the contract declares ${declaredBlocks} and the screen routes ${rendered}. ` +
      "A block read straight off the payload is a block whose `unavailable` arm silently renders as nothing.",
  );

  const view = fn(read(PRIMITIVES), "CaseFileBlockView");
  assert.match(
    view,
    /block\.state === "ok"/,
    "CaseFileBlockView must gate on the ok arm before touching `value`",
  );
  assert.match(
    view,
    /<BlockNotice reason=\{block\.reason\} state=\{block\.state\} \/>/,
    "every non-ok arm must fall through to BlockNotice, so no section can invent its own quieter empty state",
  );
}

/**
 * No section folds a block down to a fallback.
 *
 * `caseFileValueOr(block, 0)` type-checks, reads innocently, and re-creates the exact defect: a read
 * that failed becomes a zero nobody can tell apart from a real one.
 */
function testTheScreenNeverFoldsABlockToAFallbackValue() {
  const screen = read(SCREEN);
  assert.doesNotMatch(
    screen,
    /caseFileValueOr/,
    "the screen must never fold a block to a fallback: `caseFileValueOr(block, 0)` turns a failed read into a zero that reads exactly like a real result",
  );
  assert.doesNotMatch(
    screen,
    /state === "ok" \? [\w.]+\.value[^:]*: 0\b/,
    "a hand-rolled `ok ? value : 0` is the same defect as caseFileValueOr with a nicer face",
  );
}

// ── 2. the three warning states ──────────────────────────────────────────────

/**
 * A check that could not run is UNKNOWN, never clear.
 *
 * The live example: `loadMarketingRequestOverlaps` is wrapped in `.catch(() => [])` on the approval
 * screen, so a double-spend check that fell over renders identically to one that passed.
 */
function testAnUnavailableCheckNeverBorrowsTheClearLook() {
  const source = read(PRIMITIVES);
  const row = fn(source, "WarningRow");

  assert.match(
    row,
    /warning\.state === "unavailable"/,
    "WarningRow must test `unavailable` explicitly, and before falling through to any clear/flagged split",
  );
  assert.ok(
    row.indexOf('warning.state === "unavailable"') < row.indexOf('warning.state === "clear"'),
    "`unavailable` must be tested BEFORE `clear`: a check that could not run must never fall into the clear arm",
  );

  // Slice the unavailable arm: from its test up to the clear arm's test.
  const unavailableArm = row.slice(
    row.indexOf('warning.state === "unavailable"'),
    row.indexOf('warning.state === "clear"'),
  );
  assert.doesNotMatch(
    unavailableArm,
    /emerald/,
    "the `unavailable` look must not use the clear arm's green — colour is the first thing read, and a green UNKNOWN is a lie told faster than the sentence can correct it",
  );
  assert.match(
    unavailableArm,
    /Unknown/,
    "the `unavailable` chip must say Unknown in words, not only differ by colour",
  );
  assert.match(
    row,
    /data-case-file-warning-state=\{warning\.state\}/,
    "WarningRow must stamp which of the three states it rendered",
  );
}

/** All six checks are shown, including the ones that passed — a clear check is evidence too. */
function testEveryCheckIsRendered() {
  const screen = read(SCREEN);
  assert.match(
    screen,
    /warnings\.map\(\(warning\) => \(\s*<WarningRow key=\{warning\.key\} warning=\{warning\} \/>/,
    "the screen must render every warning the service returns, not a filtered subset: dropping the clear ones leaves a reader unable to tell 'checked and fine' from 'never checked'",
  );
}

// ── 3. a rejected request has a surface ──────────────────────────────────────

/**
 * The stage with no surface anywhere today.
 *
 * A rejected request vanishes from the requester's workspace, so who refused it, when, and why has
 * never been readable. The lead banner must carry all three, and must say so in a sentence when the
 * refusal carries no written reason — a blank there reads as "no reason was needed".
 */
function testARejectedRequestLeadsWithWhoRefusedItWhenAndWhy() {
  const screen = read(SCREEN);
  const lead = fn(screen, "LeadSection");

  assert.match(
    lead,
    /header\.status === "rejected" \|\| header\.lifecycleStage === "rejected"/,
    "the lead banner must fire for a rejected request — this is the lifecycle stage with no surface at all today",
  );
  assert.match(
    lead,
    /rungs\.find\(\(row\) => row\.status === "rejected"\)/,
    "a rejected request must name WHO refused it, read off the rung that actually carries the rejection",
  );
  assert.match(lead, /rung\.approverName/, "the refusing approver must be named");
  assert.match(
    lead,
    /cairoDateTime\(rung\?\.decisionAt \?\? header\.decidedAt\)/,
    "the refusal must carry WHEN, in Africa/Cairo, falling back to the request's own terminal stamp",
  );
  assert.match(lead, /rung\.decisionNote/, "the refusal must carry WHY — the note the approver wrote");
  assert.match(
    lead,
    /No reason was written when this request was refused/,
    "a refusal with no written reason must say so in a sentence: a blank reads as 'no reason was needed'",
  );

  // draft / returned lead with the return reason, for the same reason.
  assert.match(
    lead,
    /header\.status === "returned" \|\| header\.status === "draft"/,
    "a returned or draft request must lead with why it was sent back",
  );
  assert.match(lead, /chain\.value\.returnReason/, "the return reason must come from the chain block");
}

/** A rejected request re-orders the page: the decision is what a reader came for. */
function testTheRejectedStageReordersTheSections() {
  const screen = read(SCREEN);
  assert.match(
    screen,
    /stage === "rejected"\s*\?\s*\(\["chain",/,
    "a rejected request must lead with the chain that decided it, not with the ask",
  );
  assert.match(
    screen,
    /stage === "measuring" \|\| stage === "judged"\s*\?\s*\(\["outcome",/,
    "a request being measured must promote what came back to the top",
  );
}

/** Zero approval steps is a legitimate state, and a bar with no segments reads as broken. */
function testTheApprovalTrackerEmptyNoteIsASentence() {
  const primitives = read(PRIMITIVES);
  const tracker = fn(primitives, "ApprovalTracker");
  assert.match(
    tracker,
    /emptyNote \|\| steps\.length === 0/,
    "ApprovalTracker must handle both an explicit note and zero steps",
  );
  assert.match(
    tracker,
    /No approval steps have been recorded for this request yet\./,
    "the fallback must be a sentence ending in a full stop, never a bare dash or an empty bar",
  );

  const header = fn(read(SCREEN), "HeaderSection");
  assert.match(
    header,
    /This request carries no gating approval steps/,
    "zero gating steps must be explained in words rather than rendered as an empty tracker",
  );
  assert.match(
    header,
    /: caseFile\.chain\.reason/,
    "when the chain itself could not be read, the tracker must say why — an unreadable chain is not an empty one",
  );
}

// ── 4. house rules ───────────────────────────────────────────────────────────

/** Desktop shows full tables; mobile gets cards. Never a squeezed table on a phone. */
function testDesktopTablesAlwaysHaveAMobileCardCounterpart() {
  const screen = read(SCREEN);
  const tables = [...screen.matchAll(/<PortalDesktopTable\b/g)].length;
  const cards = [...screen.matchAll(/renderCard=\{/g)].length;
  const lists = [...screen.matchAll(/<PortalResponsiveDataList</g)].length;

  assert.ok(tables >= 3, `the case file should carry its product, chain and pharmacy tables (found ${tables})`);
  assert.equal(
    cards,
    tables,
    `every desktop table needs a mobile card block: ${tables} tables but ${cards} renderCard branches — the owner's standing admin-shell rule is desktop tables, mobile cards`,
  );
  assert.equal(
    lists,
    tables,
    "every table must go through PortalResponsiveDataList, which is what actually swaps cards in below md",
  );
  assert.doesNotMatch(
    screen,
    /<table\b/,
    "no raw <table>: PortalDesktopTable is the primitive that carries `hidden md:block`, and a bare table is a table on a 375px phone",
  );
}

/** Never truncate with an ellipsis; the per-cell horizontal scroll is how long values are handled. */
function testNothingIsTruncatedWithAnEllipsis() {
  for (const file of [PRIMITIVES, SCREEN]) {
    const source = code(read(file));
    assert.doesNotMatch(
      source,
      /\btruncate\b/,
      `${file} must not use Tailwind's \`truncate\` — it IS an ellipsis, and the house rule forbids one. Long values get the per-cell overflow-x-auto instead.`,
    );
    assert.doesNotMatch(source, /text-ellipsis/, `${file} must not clip text with an ellipsis`);
  }
  assert.match(
    read(PRIMITIVES),
    /overflow-x-auto whitespace-nowrap/,
    "long values must scroll within their own cell rather than wrapping or being clipped",
  );
}

/** Report every time in Africa/Cairo, and never a raw enum on screen. */
function testTimesAreCairoAndEnumsAreResolvedToWords() {
  const screen = read(SCREEN);
  assert.match(
    screen,
    /timeZone: PHOENIX_BUSINESS_TIME_ZONE/,
    "every timestamp must be rendered in Africa/Cairo, never raw UTC",
  );
  assert.match(screen, /Cairo`/, "a rendered moment must name its timezone, or a reader cannot tell which clock it is");

  for (const map of [
    "STATUS_LABELS",
    "STEP_STATUS_LABELS",
    "VALIDATION_LABELS",
    "LIFECYCLE_LABELS",
    "ADMISSION_LABELS",
    "REFERENCE_STATUS_LABELS",
    "ORIGIN_LABELS",
  ]) {
    assert.match(screen, new RegExp(`const ${map}`), `${map} must exist: a raw enum on screen is a code, and codes are not shown here`);
  }
  assert.match(
    screen,
    /ROI_RESULT_STATUS_LABEL\[outcome\.resultStatus\]/,
    "the ROI verdict must come from the canonical label map, or this screen and ROI Tracking disagree about the same request",
  );
  assert.match(
    screen,
    /ROI_DATA_COVERAGE_LABEL\[outcome\.dataCoverage\]/,
    "data coverage must be rendered as words, not as `partial_pending`",
  );
}

/** A missing field says so. A vanished field reads as "the screen forgot to ask". */
function testMissingFieldsAreNamedRatherThanDropped() {
  const screen = read(SCREEN);
  assert.match(screen, /function textOr\(/, "there must be one helper that turns an absent value into a sentence-shaped label");
  assert.match(
    read(PRIMITIVES),
    /function NotProvided\(\{ what = "Not provided" \}/,
    "absence must render as words, never as a bare dash",
  );
  assert.ok(
    [...screen.matchAll(/<NotProvided\b/g)].length >= 8,
    "the screen must state absence explicitly wherever a field can be missing, rather than letting the row disappear",
  );
}

/**
 * The requester's own line and area are labelled as the REQUESTER's.
 *
 * On the approval screen they sit under the Customer heading while carrying the requester's values,
 * so an approver reading "Area: Giza" believes it describes the customer. It never did.
 */
function testTheRequestersGeographyIsNotFiledUnderTheCustomer() {
  const pointed = fn(read(SCREEN), "PointedAtSection");
  assert.match(
    pointed,
    /title="The requester — this is the requester's own geography, not the customer's"/,
    "the requester's line/area must sit in the REQUESTER's own group, named as such",
  );
  assert.match(pointed, /label: "Their line"/, "the requester's line must be labelled as theirs");
  assert.match(pointed, /label: "Their area"/, "the requester's area must be labelled as theirs");
  assert.match(
    pointed,
    /customer\.validation\.status/,
    "the customer's validation state must be visible — 155 of 157 customers have never been validated, and silence there reads as validated",
  );
}

// ── 5. wiring ────────────────────────────────────────────────────────────────

/** One component, three shells, so each role reaches it in their own layout. */
function testAllThreeShellsMountTheSameComponent() {
  for (const mount of MOUNTS) {
    const source = read(mount);
    assert.match(
      source,
      /MarketingRequestCaseFile/,
      `${mount} must mount the one Case File component — multi-shell mounting is intentional, and dropping a shell strands the roles that live in it`,
    );
  }

  // The admin and portal shells each carry their own server-side gate.
  assert.match(read(MOUNTS[0]), /assertMarketingAdminPageAccess/, "the admin mount must keep its own page guard");
  assert.match(
    read(MOUNTS[1]),
    /assertEmployeePortalMarketingPageAccess/,
    "the employee-portal mount must keep its own page guard",
  );
  assert.match(
    read(MOUNTS[2]),
    /WorkspaceMarketingCaseFilePage/,
    "the workspace mount must delegate to the workspace shell's own page function, which carries its role gate",
  );
}

/** The primitives are an independent COPY, not an import of another module's internal file. */
function testThePrimitivesAreIndependentOfTheApprovalsHubCopy() {
  const primitives = read(PRIMITIVES);
  assert.doesNotMatch(
    primitives,
    /from "@\/components\/approvals-hub\//,
    "the Case File must own its presentation primitives rather than importing Direct Orders' internal file — coupling two modules' redesigns together is the wrong kind of reuse",
  );
  assert.doesNotMatch(
    read(SCREEN),
    /from "@\/components\/approvals-hub\//,
    "the screen must take its primitives from the module's own copy",
  );
  for (const name of ["PanelSection", "FieldGroup", "FieldTable", "HeroStat", "ApprovalTracker"]) {
    assert.match(primitives, new RegExp(`export function ${name}\\b`), `the copy must carry ${name}`);
  }
}

/** Build alongside, retire later: linking it into the sidebar is a separate, deliberate step. */
function testNoNavigationEntryWasAdded() {
  assert.doesNotMatch(
    read(NAVIGATION),
    /case-file/i,
    "no navigation entry may be added for the Case File yet — the owner's standing rule is build-new-alongside, retire-later, and linking it in is its own decision",
  );
}

/** The email deep-link resolver owns no UI and must stay untouched. */
function testTheEmailDeepLinkResolverWasNotRepurposed() {
  const resolver = read("../app/marketing-requests/[requestId]/page.tsx");
  assert.doesNotMatch(
    resolver,
    /MarketingRequestCaseFile/,
    "app/marketing-requests/[requestId]/page.tsx is a deliberate email deep-link resolver that owns no UI — it must not become a fourth mount",
  );
}

export function runMarketingCaseFileUiTests() {
  testTheTwoNonOkStatesRenderDifferently();
  testEveryBlockInTheContractIsRenderedThroughTheStateSwitch();
  testTheScreenNeverFoldsABlockToAFallbackValue();

  testAnUnavailableCheckNeverBorrowsTheClearLook();
  testEveryCheckIsRendered();

  testARejectedRequestLeadsWithWhoRefusedItWhenAndWhy();
  testTheRejectedStageReordersTheSections();
  testTheApprovalTrackerEmptyNoteIsASentence();

  testDesktopTablesAlwaysHaveAMobileCardCounterpart();
  testNothingIsTruncatedWithAnEllipsis();
  testTimesAreCairoAndEnumsAreResolvedToWords();
  testMissingFieldsAreNamedRatherThanDropped();
  testTheRequestersGeographyIsNotFiledUnderTheCustomer();

  testAllThreeShellsMountTheSameComponent();
  testThePrimitivesAreIndependentOfTheApprovalsHubCopy();
  testNoNavigationEntryWasAdded();
  testTheEmailDeepLinkResolverWasNotRepurposed();
}
