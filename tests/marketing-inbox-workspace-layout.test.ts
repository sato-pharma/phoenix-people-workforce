import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

/**
 * The marketing approval inbox as a WORKSPACE rather than one endless scroll.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * Owner instruction, 2026-08-24: restructure `/admin/marketing-requests/inbox`. The page rendered
 * four queues — awaiting my decision, coming to me, awaiting my comment, and (Super Admin)
 * everything in approval — stacked one under the other, every row fully expanded, every number
 * underneath every panel. An approver holding eight requests could only read them in submission
 * order, in full, and had to reach the bottom of a card to find out what it cost.
 *
 * The restructure keeps every one of those queues and adds no new data: it moves the numbers above
 * the detail, puts each queue behind its own segment, and lets the heavy detail panel close.
 *
 * ── WHAT THIS SUITE PROTECTS ─────────────────────────────────────────────────
 * Three earlier owner instructions live inside this component and are the things a later "tidy-up"
 * would silently undo:
 *
 *   1. 2026-08-04 — the requested-product sales strip lives ON the row, "not one click away".
 *   2. 2026-08-04 — everything the requester submitted is shown IN PLACE, not behind a click.
 *   3. desktop shows a full table, mobile never does.
 *
 * The disclosure added by the restructure is the sharp edge: it is open by DEFAULT, so (2) still
 * holds — but the difference between "collapsed by exception" and "expanded by exception" is one
 * `!` in one prop, and flipping it would reverse an owner instruction for every row at once with
 * nothing on screen to say so. §2 below is that `!`.
 *
 * ── WHY IT IS ASSERTED OVER SOURCE TEXT ──────────────────────────────────────
 * `pnpm test` runs under `node --experimental-strip-types`, which strips types and does NOT compile
 * JSX, so no test in this suite can render a component. Assertions are scoped to one function's
 * body wherever a sibling could otherwise satisfy them.
 */
export function runMarketingInboxWorkspaceLayoutTests() {
  const inbox = source("src/components/employee-portal/marketing-request-inbox.tsx");

  /** One component's body, so no assertion can be satisfied by a sibling card in the same file. */
  const componentBody = (declaration: string): string => {
    const start = inbox.indexOf(declaration);
    assert.ok(start > -1, `expected to find ${declaration}`);
    const next = inbox.indexOf("\nfunction ", start + declaration.length);
    return inbox.slice(start, next > -1 ? next : inbox.length);
  };

  const card = componentBody("function InboxRowCard(");

  /* ---------------------------------------------------------------------- */
  /* 1. The money is ABOVE the detail, and the decision is below both        */
  /* ---------------------------------------------------------------------- */

  // The four facts an approver checks before reading anything used to sit UNDERNEATH both detail
  // panels — so on a request promoting a dozen products, the cost and the pay date were the last
  // things on the card. Order is the whole fix here, which is why it is asserted as order.
  const costAt = card.indexOf("Estimated Cost");
  const disclosureAt = card.indexOf("Full request detail");
  const decisionBarAt = card.indexOf('<div className="flex flex-wrap items-center gap-2 border-t');

  assert.ok(costAt > -1, "the row must still state the estimated cost");
  assert.ok(disclosureAt > -1, "the row must still offer the full request detail");
  assert.ok(decisionBarAt > -1, "the row must still carry a decision bar");
  assert.ok(
    costAt < disclosureAt,
    "the cost / pay date / submitted / waiting strip must render ABOVE the detail disclosure, not under it",
  );
  assert.ok(
    disclosureAt < decisionBarAt,
    "the decision bar stays last — an approver answers after reading, not before",
  );

  /* ---------------------------------------------------------------------- */
  /* 2. THE HEADLINE. The detail disclosure is OPEN by default               */
  /* ---------------------------------------------------------------------- */

  // Owner instruction, 2026-08-04: what the requester submitted is shown in place, because before
  // it the only way to read a request was to click a decision. A disclosure that defaulted CLOSED
  // would re-create exactly that, one click cheaper. The state therefore tracks the rows the reader
  // has CLOSED — collapsed by exception — so a row that has never been touched, including one that
  // arrives on a later refresh, is open.
  assert.match(
    inbox,
    /isDetailOpen=\{!collapsedIds\.has\(row\.id\)\}/,
    "the detail panel must be open unless the reader closed that row — `collapsedIds.has(...)` without the `!` silently reverses the 2026-08-04 instruction for every row",
  );
  assert.doesNotMatch(
    inbox,
    /useState<[^>]*>\(new Set\(rows/,
    "the collapsed set must start EMPTY — seeding it from the rows would collapse everything on arrival",
  );

  /* ---------------------------------------------------------------------- */
  /* 3. The product sales strip is NOT inside the disclosure                 */
  /* ---------------------------------------------------------------------- */

  // Same instruction, the other half: "lives on the row itself, not one click away". The approver's
  // first question is whether this customer has ever bought what is being pushed, and a request
  // whose promoted products have no history is the one worth stopping before opening anything. It
  // is a one-line strip, so nothing is gained by hiding it and an owner rule is lost.
  const productStripAt = card.indexOf("<MarketingRequestedProductHistory");
  assert.ok(productStripAt > -1, "the requested-product sales strip must still render on the row");
  assert.ok(
    productStripAt < disclosureAt,
    "the requested-product sales strip must sit OUTSIDE the collapsible detail — owner rule, it is never one click away",
  );

  /* ---------------------------------------------------------------------- */
  /* 4. Both read-only watch lists go through ONE renderer                   */
  /* ---------------------------------------------------------------------- */

  // "Coming to me" and "Everything in approval" answer the same three questions and neither may
  // ever decide anything. One renderer that carries no decision control is a stronger guarantee
  // than two that happen not to — and it is what lets the oversight suite read this module from
  // its heading to EOF and prove no decision link is reachable from the watch list.
  const watchListUses = inbox.match(/<ChainWatchList rows=\{(upcomingRows|oversightRows)\}/g) ?? [];
  assert.deepEqual(
    watchListUses.sort(),
    ["<ChainWatchList rows={oversightRows}", "<ChainWatchList rows={upcomingRows}"],
    "both watch lists must render through the same read-only component",
  );
  const watchList = componentBody("function ChainWatchList(");
  assert.doesNotMatch(
    watchList,
    /decisionHref|allowReject|allowReturn/,
    "the shared watch-list renderer must be incapable of drawing a decision control",
  );

  /* ---------------------------------------------------------------------- */
  /* 5. Desktop gets a table, mobile gets cards — with a REAL gate           */
  /* ---------------------------------------------------------------------- */

  // Owner rule for the admin shell. The gate has to be real CSS: `data-portal-desktop-table` is
  // injected by the PORTAL shell only and does nothing at all on an admin page, so a bare <table>
  // carrying that attribute would be phone-visible with nothing to signal it. Going through the
  // primitives is what supplies the actual `hidden … md:block` / `md:hidden` pair.
  assert.match(
    watchList,
    /<PortalResponsiveDataList/,
    "the watch list must render cards on mobile and a table on desktop through the primitive",
  );
  assert.match(
    watchList,
    /<PortalDesktopTable/,
    "the desktop half must be PortalDesktopTable, which carries the real `hidden … md:block` gate",
  );
  assert.match(
    watchList,
    /<PortalRecordCard/,
    "the mobile half must be a card — the admin shell never shows a table on a phone",
  );

  /* ---------------------------------------------------------------------- */
  /* 6. The watch list is WINDOWED, and windowing is display-only            */
  /* ---------------------------------------------------------------------- */

  // PortalResponsiveDataList emits the card markup AND the table markup for every item it is handed
  // and hides one half in CSS, so an uncapped company-wide queue ships two full renders of itself to
  // a phone. The page reset is clamped during render rather than reset from an effect — `setState`
  // inside `useEffect` is a lint error in this repo, and a refresh that shortens the list must not
  // strand the reader on a page that no longer exists.
  assert.match(watchList, /WATCH_PAGE_SIZE/, "the watch list must be windowed");
  assert.match(
    watchList,
    /const safePage = Math\.min\(page, pageCount - 1\)/,
    "the page must be clamped during render, not corrected from an effect",
  );
  // The CALL form, not the bare word: the clamp above is explained in a comment that names
  // `useEffect` as the thing it exists to avoid, and matching that comment would fail the assertion
  // on the very code that satisfies it.
  assert.doesNotMatch(
    watchList,
    /useEffect\(/,
    "the watch list must not reach for an effect to fix its own page",
  );

  /* ---------------------------------------------------------------------- */
  /* 7. Search and sort span EVERY row awaiting the viewer                   */
  /* ---------------------------------------------------------------------- */

  // A search that only looks at what is already on screen is a silent drop. The decision queue is
  // not windowed, and the filter reads `rows` — the full server payload — not a slice of it.
  assert.match(
    inbox,
    /const visibleRows = useMemo\(\(\) => \{[\s\S]*?rows\.filter\(/,
    "the decision-queue search must filter the full row set",
  );
  assert.match(
    inbox,
    /\[rows, search, sort\]/,
    "the decision queue must re-derive when the rows, the search or the sort change",
  );

  /* ---------------------------------------------------------------------- */
  /* 8. "Waiting" is the same arithmetic the server already uses             */
  /* ---------------------------------------------------------------------- */

  // The two read-only queues get `ageDays` from the service; the rows awaiting the viewer's own
  // decision carry `submittedAt` and nothing else, so the badge on those is derived client-side.
  // Two different divisors, or a ceil against a floor, and the same request reads as a different
  // age depending on which queue it is sitting in.
  const service = source("src/lib/marketing-requests/service.ts");
  assert.match(
    inbox,
    /Math\.max\(0, Math\.floor\(\(Date\.now\(\) - submittedAtMs\) \/ 86_400_000\)\)/,
    "the client-side wait must floor whole days from submission",
  );
  assert.match(
    service,
    /Math\.max\(0, Math\.floor\(\(Date\.now\(\) - submittedAtMs\) \/ 86_400_000\)\)/,
    "the server's ageDays must use the same arithmetic, or one request reads as two different ages",
  );

  /* ---------------------------------------------------------------------- */
  /* 9. No queue is padded to make the navigator look full                   */
  /* ---------------------------------------------------------------------- */

  // Owner rule: never pad a list to hit a number. An approver with no advisory rungs must not be
  // shown a segment that can only ever say "nothing here", and the metric tiles for a queue that is
  // empty must not render either.
  assert.match(
    inbox,
    /\]\.filter\(\(segment\) => segment\.count > 0\)/,
    "only a queue that actually holds something may claim a segment",
  );
  for (const guard of ["upcomingRows.length > 0 ?", "advisoryRows.length > 0 ?", "oversightRows.length > 0 ?"]) {
    assert.ok(
      inbox.includes(guard),
      `the metric tile fed by ${guard.split(" ")[0]} must render only when that queue has rows`,
    );
  }
}
