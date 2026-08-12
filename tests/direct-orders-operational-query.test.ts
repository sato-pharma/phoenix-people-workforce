import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  clampDirectOrderPage,
  clampDirectOrderPageSize,
  directOrderMatchesStatusGroup,
  expandRequesterHrIdCandidates,
  looksLikeDirectOrderId,
  requesterCandidatesExceedUrlBudget,
  resolveDirectOrderScopePredicate,
  resolveDirectOrderStatusGroup,
  resolveDirectOrderStatusGroupFilter,
  DIRECT_ORDER_MAX_PAGE_SIZE,
  DIRECT_ORDER_PAGE_SIZE,
} from "../src/lib/direct-orders/operational-query.ts";
import { DIRECT_ORDER_STATUS_VALUES } from "../src/lib/direct-orders/types.ts";

/**
 * The operational Orders query: scope BEFORE pagination, and every tier fails closed.
 *
 * WHAT THIS REPLACES. The Orders list was fed by getDirectOrderReport(), which selects every
 * request in scope with no limit, applies the scope tier in JavaScript, decorates all of it, and
 * hands the lot to a client that renders 25 rows. This file pins the properties that make the
 * replacement safe — the ones where a mistake is silent rather than loud.
 */
export async function runDirectOrderOperationalQueryTests() {
  // ── Paging bounds: a caller must not be able to request the whole table ────
  assert.equal(clampDirectOrderPageSize(null), DIRECT_ORDER_PAGE_SIZE, "absent page size falls back to the default");
  assert.equal(clampDirectOrderPageSize(0), DIRECT_ORDER_PAGE_SIZE, "zero is not a page size");
  assert.equal(clampDirectOrderPageSize(-5), DIRECT_ORDER_PAGE_SIZE, "negative is not a page size");
  assert.equal(
    clampDirectOrderPageSize(100000),
    DIRECT_ORDER_MAX_PAGE_SIZE,
    "an enormous page size must be clamped — otherwise 'one page' is just the old full-table read wearing a hat",
  );
  assert.equal(clampDirectOrderPage(0), 1, "pages are 1-indexed");
  assert.equal(clampDirectOrderPage(-3), 1, "a negative page is page 1, never a negative range offset");

  // ── HR_ID expansion: the reason no migration is needed ─────────────────────
  const expanded = expandRequesterHrIdCandidates(["b-185"]);
  assert.ok(expanded.includes("b-185"), "the canonical (lowercase) form must be present");
  assert.ok(expanded.includes("B-185"), "the uppercase form must be present — the directory stores uppercase");

  // The alias case, which is the whole reason a naive .eq() would have lost rows.
  const aliased = expandRequesterHrIdCandidates(["aa"]);
  assert.ok(aliased.includes("aa") && aliased.includes("AA"), "canonical and uppercase of the canonical key");

  // ── FAIL CLOSED: every tier that cannot resolve its basis matches NOTHING ──
  //
  // This is the sharpest set of assertions in the file. A tier that fell back to "no predicate"
  // would not error — it would quietly return the whole company, one page at a time.
  const noneForEmptySubtree = resolveDirectOrderScopePredicate({
    scope: "hierarchy",
    viewerHrId: "B-1",
    visibleRequesterKeys: new Set<string>(),
    viewerLine: null,
  });
  assert.equal(noneForEmptySubtree.kind, "none", "an empty subtree must match nothing, never everything");

  const noneForUnresolvableLine = resolveDirectOrderScopePredicate({
    scope: "line",
    viewerHrId: "B-1",
    visibleRequesterKeys: null,
    viewerLine: "",
  });
  assert.equal(noneForUnresolvableLine.kind, "none", "an unresolvable line must match nothing, never the company");

  const noneForOwnWithoutIdentity = resolveDirectOrderScopePredicate({
    scope: "own",
    viewerHrId: null,
    visibleRequesterKeys: new Set<string>(),
    viewerLine: null,
  });
  assert.equal(noneForOwnWithoutIdentity.kind, "none", "own scope with no identity matches nothing");

  // ── The tiers that DO resolve carry a real predicate ───────────────────────
  const ownPredicate = resolveDirectOrderScopePredicate({
    scope: "own",
    viewerHrId: "B-1",
    visibleRequesterKeys: new Set(["b-1"]),
    viewerLine: null,
  });
  assert.equal(ownPredicate.kind, "requesters", "own scope filters by requester");
  assert.ok(
    ownPredicate.kind === "requesters" && ownPredicate.hrIdCandidates.includes("B-1"),
    "the stored uppercase form must be among the candidates",
  );

  const linePredicate = resolveDirectOrderScopePredicate({
    scope: "line",
    viewerHrId: "B-1",
    visibleRequesterKeys: null,
    viewerLine: "Ivyronc",
  });
  assert.equal(linePredicate.kind, "line", "line scope filters by line");
  assert.equal(
    linePredicate.kind === "line" && linePredicate.line,
    "ivyronc",
    "the line is lowercased for a case-insensitive match, mirroring the report's JS comparison",
  );

  assert.equal(
    resolveDirectOrderScopePredicate({
      scope: "all",
      viewerHrId: "S-1",
      visibleRequesterKeys: null,
      viewerLine: null,
    }).kind,
    "all",
    "company scope applies no requester predicate",
  );

  // ── "Mine" NARROWS at every tier, and never widens one ────────────────────
  for (const scope of ["all", "line", "hierarchy", "own"] as const) {
    const mine = resolveDirectOrderScopePredicate({
      scope,
      viewerHrId: "B-7",
      visibleRequesterKeys: new Set(["b-1", "b-7", "b-9"]),
      viewerLine: "Ivyronc",
      scopeFilter: "mine",
    });
    assert.equal(mine.kind, "requesters", `"mine" must resolve to a requester predicate even at ${scope} scope`);
    assert.ok(
      mine.kind === "requesters" && mine.hrIdCandidates.every((c) => c.toLowerCase() === "b-7"),
      `"mine" at ${scope} scope must match ONLY the viewer — it narrows, it never widens`,
    );
  }

  // ── A subtree too large for the URL must refuse, not truncate ──────────────
  assert.equal(requesterCandidatesExceedUrlBudget(new Array(10).fill("X-1")), false);
  assert.equal(
    requesterCandidatesExceedUrlBudget(new Array(5000).fill("X-1")),
    true,
    "an oversized candidate list must be detected — silently truncating it shrinks a manager's visible set",
  );

  // ── The service must apply scope BEFORE range, and count the scoped set ────
  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const start = service.indexOf("export async function listDirectOrderOperationalPage(");
  assert.ok(start > -1, "listDirectOrderOperationalPage must exist");

  // Cut at the NEXT top-level declaration, not at a named landmark further down the file.
  //
  // This slice previously ran to `resolveDirectOrderReportScope`, three functions away — so every
  // assertion below was really being made about a 15KB region, and ".range( appears after the scope
  // predicate" could be satisfied by an unrelated function's range call. A source assertion is only
  // worth as much as its boundary.
  const nextDecl = /\n(?:export )?(?:async )?function \w+/g;
  nextDecl.lastIndex = start + 1;
  const end = nextDecl.exec(service)?.index ?? service.length;
  const body = service.slice(start, end);
  assert.ok(
    body.includes("listDirectOrderOperationalPage"),
    "the slice must start at the function it names",
  );
  assert.ok(
    // A DEFINITION, not a call: this function legitimately calls decorateDirectOrderPage.
    !/\n(?:export )?(?:async )?function \w+/.test(body.slice(1)),
    "the slice must cover exactly listDirectOrderOperationalPage — if it reaches the next function, " +
      "every assertion below is weaker than it reads",
  );

  assert.ok(body.includes('assertPermission(access, "direct_orders", "read")'), "the read must be permission-gated");
  assert.ok(
    body.includes("resolveDirectOrderReportScope(access)"),
    "scope must come from the SHARED resolver — a second copy of a visibility rule is how `reverse` " +
      "once became reachable by every rep in the company",
  );
  assert.ok(
    body.includes('query.in("requester_hr_id", predicate.hrIdCandidates)'),
    "the requester tiers must be a query predicate",
  );

  // The ordering property, asserted positionally: the authorization predicate must appear in the
  // source BEFORE .range(). If someone moves the range up, this fails.
  const scopeAt = body.indexOf('query.in("requester_hr_id", predicate.hrIdCandidates)');
  const rangeAt = body.indexOf(".range(from,");
  assert.ok(scopeAt > -1 && rangeAt > -1, "both the scope predicate and the range must be present");
  assert.ok(
    scopeAt < rangeAt,
    "SCOPE MUST BE APPLIED BEFORE PAGINATION. Paginating first and trimming after gives short pages " +
      "and a total that counts rows the viewer may not see.",
  );

  assert.ok(
    body.includes('{ count: "exact" }'),
    "the count must come from the database over the scoped+filtered set, not from rows.length",
  );
  assert.ok(
    body.includes('predicate.kind === "none"') && body.includes("rows: [], totalCount: 0"),
    "an unresolvable scope must return an empty page — and must not fall through to an unfiltered query",
  );

  // This query must NOT be the reporting function in disguise.
  assert.ok(
    !body.includes("getDirectOrderReport("),
    "the operational query must not call the reporting function — separating them is the point",
  );

  // ── REGRESSION: the search fallback that leaked scope ──────────────────────
  //
  // The first cut sent `id.eq.${q}` unconditionally. Postgres rejects that cast before evaluating
  // anything else, so EVERY non-uuid search errored — into a retry that built a FRESH query with no
  // scope predicate and none of the filters. An own-scope viewer typing any ordinary word got a
  // page drawn from the whole table.
  //
  // Asserted as "one query builder in this function", because that is the property that made the
  // bug possible: a second builder is a second place to forget the scope. Counting them is a
  // stronger guard than checking the retry is gone, which a future retry would quietly undo.
  const builders = body.match(/\.from\("direct_order_requests"\)/g) ?? [];
  assert.equal(
    builders.length,
    1,
    "listDirectOrderOperationalPage must build exactly ONE query. A second builder is where the " +
      "scope predicate gets forgotten — that is how the uuid-retry fallback leaked the whole table.",
  );
  assert.ok(
    body.includes("looksLikeDirectOrderId(q)"),
    "the id clause must be gated on the term actually looking like an id",
  );
  assert.ok(
    !/invalid input syntax for type uuid/i.test(body),
    "no retry-on-cast-error path: the shape test above means the error cannot happen, and a retry " +
      "is what re-opened the unscoped read",
  );

  assert.equal(looksLikeDirectOrderId("el salam"), false, "an ordinary search term is not an order id");
  assert.equal(looksLikeDirectOrderId(""), false, "empty is not an order id");
  assert.equal(looksLikeDirectOrderId("B-185"), false, "an HR id is not an order id");
  assert.equal(
    looksLikeDirectOrderId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
    true,
    "a real uuid must still search by id — dropping that would break every 'open this order' link",
  );
  assert.equal(
    looksLikeDirectOrderId("  3f2504e0-4f89-11d3-9a0c-0305e82c3301  "),
    true,
    "a pasted id carries whitespace",
  );

  // ── Status GROUPS: the chips and the SQL must be the same rule ─────────────
  assert.equal(resolveDirectOrderStatusGroup(null), "all", "no group means no predicate");
  assert.equal(resolveDirectOrderStatusGroup("nonsense"), "all", "a hand-edited URL falls back to all");
  assert.equal(resolveDirectOrderStatusGroup("IN-PROGRESS"), "in-progress", "case is not the user's problem");
  assert.equal(resolveDirectOrderStatusGroupFilter("all"), null, "'all' adds no predicate at all");

  // THE PROPERTY THAT MATTERS. The chip rule (directOrderMatchesStatusGroup, which the component
  // uses) and the derived SQL buckets must agree for every status, both with and without a booked
  // sales month. If they ever disagree, the list shows one thing and the chip claims another —
  // and nothing else in the suite would notice.
  const GROUPS = ["needs-action", "in-progress", "returned", "completed"] as const;
  for (const group of GROUPS) {
    const filter = resolveDirectOrderStatusGroupFilter(group);
    if (!filter) throw new Error(`${group} must resolve to a filter`);
    for (const status of DIRECT_ORDER_STATUS_VALUES) {
      for (const salesMonth of [null, "2026-03"] as (string | null)[]) {
        const perChip: boolean = directOrderMatchesStatusGroup({ status, salesMonth }, group);
        const perSql: boolean =
          (filter.statuses as string[]).includes(status) ||
          (salesMonth === null && (filter.unbookedStatuses as string[]).includes(status)) ||
          (salesMonth !== null && (filter.bookedStatuses as string[]).includes(status));
        assert.equal(
          perSql,
          perChip,
          `${group}: the chip and the query disagree about ${status} with salesMonth=${salesMonth}`,
        );
      }
    }
  }

  // The split the buckets exist for: ONE status, two groups, decided by the Finance booking.
  const completed = resolveDirectOrderStatusGroupFilter("completed");
  assert.deepEqual(completed?.bookedStatuses, ["approved"], "Completed is approved AND booked");
  assert.deepEqual(completed?.statuses, [], "nothing is completed regardless of its month");
  const inProgress = resolveDirectOrderStatusGroupFilter("in-progress");
  assert.ok(
    inProgress?.unbookedStatuses.includes("approved"),
    "approved-but-unbooked is IN PROGRESS — it is waiting for Finance, not finished",
  );
  assert.ok(
    !inProgress?.statuses.includes("approved"),
    "approved must never be matched regardless of month: that would put every completed order in " +
      "the In Progress chip",
  );
  assert.ok(
    inProgress?.statuses.includes("held") && inProgress.statuses.includes("pending_approval"),
    "In Progress spans the whole chain, not just the rung a status names",
  );
  assert.deepEqual(
    resolveDirectOrderStatusGroupFilter("returned")?.statuses,
    ["returned"],
    "Returned is one exact status — its STAGE is 'approval', so a stage test would fold it into In Progress",
  );

  // ── Search PARITY: the server must not search less than the client did ─────
  //
  // The client-side search matched requester, pharmacy name, pharmacy code, product, area, region
  // and id. Moving it into SQL could quietly narrow it to the three columns this table happens to
  // hold — and nobody would file that as a bug. They would just stop trusting the box.
  assert.ok(
    body.includes("findPharmacyIdsMatchingSearch(q)") && body.includes("findRequesterHrIdsMatchingSearch(q)"),
    "searching by pharmacy and by person must survive the move to the server — neither is a column " +
      "on direct_order_requests, so both have to be resolved to ids first",
  );
  assert.ok(
    body.includes("pharmacy_id.in.(") && body.includes("requester_hr_id.in.("),
    "the resolved ids must reach the query as predicates on the columns this table does hold",
  );

  // Overflow is REFUSED, not truncated. A capped list looks exactly like "no such order".
  assert.ok(
    body.includes("overflowed") && body.includes("badRequest("),
    "a search term matching more than the limit must say so, not silently return a partial set",
  );
  const overflowAt = body.indexOf("pharmacies.overflowed");
  const usesAt = body.indexOf("pharmacy_id.in.(");
  assert.ok(
    overflowAt > -1 && overflowAt < usesAt,
    "the overflow check must come BEFORE the values are used, or the truncated list is already in " +
      "the query by the time anyone notices",
  );

  const helpers = service.slice(
    service.indexOf("async function findRequesterHrIdsMatchingSearch"),
    service.indexOf("export async function listDirectOrderOperationalPage("),
  );
  assert.ok(
    helpers.includes("hrIdLookupKeys(employee.hrId)"),
    "matched people must be expanded through hrIdLookupKeys — the stored casing is not guaranteed, " +
      "and an exact match silently loses rows (the same reason the scope predicate expands)",
  );

  // And the SQL those buckets become.
  assert.ok(
    body.includes("sales_month.is.null") && body.includes("sales_month.not.is.null"),
    "the booked/unbooked split must reach the query as a month predicate",
  );
  const groupAt = body.indexOf("statusGroupClauses.length > 0");
  assert.ok(groupAt > -1 && groupAt < body.indexOf(".range(from,"), "the group predicate must precede pagination");

  console.log("  direct-orders operational query: scope before pagination, fails closed at every tier");
  console.log("  direct-orders operational query: one query builder (no unscoped search retry)");
  console.log("  direct-orders status groups: chip rule and SQL buckets agree for all 9 statuses");
}
