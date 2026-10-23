import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  BADGE_COUNTS_CACHE_MAX_ENTRIES,
  BADGE_COUNTS_CACHE_TTL_MS,
  _badgeCountsCacheSize,
  _resetBadgeCountsCache,
  badgeCountsAreCacheable,
  badgeCountsViewerKey,
  serveViewerBadgeCounts,
  type BadgeCountsComputation,
} from "../src/lib/approvals-hub/badge-counts-cache.ts";
import {
  SELF_ONLY_OTHER_APPROVALS_ROLES,
  otherApprovalsInboxIsAlwaysEmptyFor,
} from "../src/lib/action-center/inbox-reach.ts";
import {
  canSeeEmployee,
  canSeeHrScopedRecord,
  createAccessContext,
  phoenixRoles,
  type AccessContext,
} from "../src/lib/auth/permissions.ts";

/**
 * 2026-10-23, every page change under 1 second. The batched sidebar badge poll
 * (/api/approvals/badge-counts) cost 226 s of server time in about 27 minutes of production — 141
 * calls at about 1.6 s each. Two changes cut it, and this pins both:
 *
 *   • A PER-VIEWER 20 s MEMORY (src/lib/approvals-hub/badge-counts-cache.ts). It must never hand one
 *     viewer another's count, never remember a response with a failed read in it, join two tabs onto
 *     one read, age from the START of the read, and stay bounded.
 *   • THE "OTHER APPROVALS" EARLY ZERO (src/lib/action-center/inbox-reach.ts). Seats that can only
 *     ever see their OWN resignation and contract records answer 0 without reading either dashboard.
 *     The probe below drives the two real visibility helpers those dashboards scope with, for every
 *     listed role, so a role widened to see a report goes red HERE before it can hide a request.
 *
 * Pure: the cache and the two visibility helpers are driven directly; the dashboards, the route and
 * the company-reader predicates are pinned by source, because this suite runs with production
 * credentials and driving the reads would touch live resignations and contracts.
 */
export async function runBadgeCountsViewerCacheTests() {
  await cacheServesOneViewerForTwentySeconds();
  cacheNeverSharesAcrossViewers();
  await cacheNeverRemembersTheUnidentified();
  await cacheJoinsConcurrentReads();
  await cacheNeverRemembersAFailedRead();
  cacheabilityAcceptsOnlyRefusals();
  await cacheStaysBounded();
  inboxEarlyZeroHoldsForEveryListedRole();
  inboxEarlyZeroIsWiredBeforeTheReads();
  routeServesThroughTheMemory();
}

type Body = { who: string; n: number };

function counter(who: string, cacheable = true) {
  let calls = 0;
  const compute = async (): Promise<BadgeCountsComputation<Body>> => {
    calls += 1;
    return { body: { who, n: calls }, cacheable };
  };
  return { compute, calls: () => calls };
}

const viewer = (overrides: Partial<Parameters<typeof createAccessContext>[0]> = {}): AccessContext =>
  createAccessContext({ hrId: "MR-101", loginId: "mr-101", role: "Medical Rep", source: "session", ...overrides });

async function cacheServesOneViewerForTwentySeconds() {
  _resetBadgeCountsCache();
  let now = 5_000_000;
  const clock = () => now;
  const key = badgeCountsViewerKey(viewer());
  assert.ok(key, "a signed-in viewer must get a memory key");

  // The read takes 4 s: the age must run from its START, so the copy expires 20 s after the read began.
  let calls = 0;
  const slow = async (): Promise<BadgeCountsComputation<Body>> => {
    calls += 1;
    now += 4_000;
    return { body: { who: "a", n: calls }, cacheable: true };
  };
  const started = now;
  const first = await serveViewerBadgeCounts(key, slow, clock);
  assert.equal(first.cache, "miss", "the first ask must read");
  assert.equal(calls, 1);

  now = started + BADGE_COUNTS_CACHE_TTL_MS - 1;
  const second = await serveViewerBadgeCounts(key, slow, clock);
  assert.equal(second.cache, "hit", "the same viewer asking again inside 20 s must be served the remembered counts");
  assert.equal(calls, 1, "a remembered answer must not read again");
  assert.deepEqual(second.body, first.body, "a remembered answer must be the very counts the read returned");

  now = started + BADGE_COUNTS_CACHE_TTL_MS;
  const third = await serveViewerBadgeCounts(key, slow, clock);
  assert.equal(
    third.cache,
    "miss",
    "a copy must expire 20 s after its read STARTED — measured from the end it would be up to a whole read older than the data",
  );
  assert.equal(calls, 2);
  _resetBadgeCountsCache();
}

function cacheNeverSharesAcrossViewers() {
  const base = viewer();
  const variants: Array<[string, AccessContext]> = [
    ["another HR id", viewer({ hrId: "MR-102" })],
    ["another login id", viewer({ loginId: "mr-101-second" })],
    ["another role", viewer({ role: "District Manager" })],
    ["a dev-header context", viewer({ source: "dev-header" })],
    ["a test persona", viewer({ testPersona: { loginId: "TEST-1", mirrorsHrId: "MR-101" } })],
    [
      "the owner viewing this seat",
      viewer({ seatView: { ownerLoginId: "owner", personName: "Medical Rep One", expiresAt: 1_900_000_000 } }),
    ],
  ];
  const baseKey = badgeCountsViewerKey(base);
  const seen = new Set([baseKey]);
  for (const [label, context] of variants) {
    const key = badgeCountsViewerKey(context);
    assert.ok(key, `${label} must still be remembered`);
    assert.notEqual(key, baseKey, `${label} must never share the viewer's remembered counts`);
    assert.ok(!seen.has(key), `${label} must get a key of its own`);
    seen.add(key);
  }
  const reordered = { scope: base.scope, source: base.source, role: base.role, loginId: base.loginId, hrId: base.hrId } as AccessContext;
  assert.equal(badgeCountsViewerKey(reordered), baseKey, "field order must not split one viewer into two entries");
}

async function cacheNeverRemembersTheUnidentified() {
  _resetBadgeCountsCache();
  for (const [label, context] of [
    ["a guest", createAccessContext({ source: "guest" })],
    ["a guest carrying an id", createAccessContext({ hrId: "MR-101", loginId: "mr-101", source: "guest" })],
    ["a system context", createAccessContext({ hrId: "SYS", role: "Super Admin", source: "system" })],
    ["a context with no identity", createAccessContext({ role: "Employee", source: "session" })],
  ] as const) {
    assert.equal(badgeCountsViewerKey(context), null, `${label} must never be remembered`);
  }
  const reads = counter("anyone");
  const one = await serveViewerBadgeCounts(null, reads.compute);
  const two = await serveViewerBadgeCounts(null, reads.compute);
  assert.equal(one.cache, "bypass");
  assert.equal(two.cache, "bypass");
  assert.equal(reads.calls(), 2, "an unidentified ask must read every time");
  assert.equal(_badgeCountsCacheSize(), 0, "an unidentified ask must leave nothing behind");

  // Two different viewers each read their own counts, and each is served only its own afterwards.
  const keyA = badgeCountsViewerKey(viewer());
  const keyB = badgeCountsViewerKey(viewer({ hrId: "MR-102" }));
  const readsA = counter("A");
  const readsB = counter("B");
  await serveViewerBadgeCounts(keyA, readsA.compute);
  const firstB = await serveViewerBadgeCounts(keyB, readsB.compute);
  assert.equal(firstB.cache, "miss", "a second viewer must read for themselves, never take the first viewer's counts");
  assert.equal(firstB.body.who, "B");
  assert.equal((await serveViewerBadgeCounts(keyA, readsA.compute)).body.who, "A");
  assert.equal((await serveViewerBadgeCounts(keyB, readsB.compute)).body.who, "B");
  _resetBadgeCountsCache();
}

async function cacheJoinsConcurrentReads() {
  _resetBadgeCountsCache();
  const key = badgeCountsViewerKey(viewer());
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const compute = async (): Promise<BadgeCountsComputation<Body>> => {
    calls += 1;
    await gate;
    return { body: { who: "a", n: calls }, cacheable: true };
  };
  const first = serveViewerBadgeCounts(key, compute);
  const second = serveViewerBadgeCounts(key, compute);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1, "two tabs of one viewer asking together must share ONE read");
  assert.equal(a.cache, "miss");
  assert.equal(b.cache, "joined");
  assert.deepEqual(b.body, a.body, "the joined ask must get the same counts");

  // A read that throws must not stay registered, or the viewer would wait on it forever.
  _resetBadgeCountsCache();
  let throwing = 0;
  const failing = async (): Promise<BadgeCountsComputation<Body>> => {
    throwing += 1;
    throw new Error("network");
  };
  await assert.rejects(serveViewerBadgeCounts(key, failing));
  await assert.rejects(serveViewerBadgeCounts(key, failing));
  assert.equal(throwing, 2, "a read that threw must be forgotten, so the next ask reads again");
  _resetBadgeCountsCache();
}

async function cacheNeverRemembersAFailedRead() {
  _resetBadgeCountsCache();
  const key = badgeCountsViewerKey(viewer());
  const reads = counter("a", false);
  await serveViewerBadgeCounts(key, reads.compute);
  const again = await serveViewerBadgeCounts(key, reads.compute);
  assert.equal(again.cache, "miss", "a response marked not cacheable must never be served again from memory");
  assert.equal(reads.calls(), 2);
  assert.equal(_badgeCountsCacheSize(), 0, "a response marked not cacheable must not be stored");
  _resetBadgeCountsCache();
}

function cacheabilityAcceptsOnlyRefusals() {
  // The route passes isForbiddenError; this stand-in has its message-prefix half.
  const isRefusal = (reason: unknown) => reason instanceof Error && reason.message.toLowerCase().startsWith("forbidden:");
  const ok = <T>(value: T): PromiseSettledResult<T> => ({ status: "fulfilled", value });
  const no = (reason: unknown): PromiseSettledResult<never> => ({ status: "rejected", reason });

  assert.equal(badgeCountsAreCacheable([ok({ count: 2 }), ok(3), ok({ count: 0, available: true })], isRefusal), true);
  assert.equal(
    badgeCountsAreCacheable([ok({ count: 1 }), no(new Error("Forbidden: Medical Rep cannot read deductions."))], isRefusal),
    true,
    "a permission refusal is the viewer's standing — the same answer every time — so it may be remembered",
  );
  assert.equal(
    badgeCountsAreCacheable([ok({ count: 1 }), no(new Error("fetch failed"))], isRefusal),
    false,
    "any rejection that is not a refusal is a failed read, and a failed read must never be remembered",
  );
  assert.equal(
    badgeCountsAreCacheable([ok({ count: 0, overdue: false, available: false })], isRefusal),
    false,
    "a domain that reports available:false failed its own read, and must never be remembered as a real zero",
  );
}

async function cacheStaysBounded() {
  _resetBadgeCountsCache();
  const now = 7_000_000;
  const clock = () => now;
  const keyFor = (i: number) => badgeCountsViewerKey(viewer({ hrId: `MR-${i}` }));
  for (let i = 0; i <= BADGE_COUNTS_CACHE_MAX_ENTRIES; i += 1) {
    await serveViewerBadgeCounts(keyFor(i), counter(`v${i}`).compute, clock);
  }
  assert.equal(_badgeCountsCacheSize(), BADGE_COUNTS_CACHE_MAX_ENTRIES, "the memory must hold no more than its cap");
  const oldest = counter("again");
  assert.equal(
    (await serveViewerBadgeCounts(keyFor(0), oldest.compute, clock)).cache,
    "miss",
    "past the cap the OLDEST viewer must be the one let go",
  );
  assert.equal(
    (await serveViewerBadgeCounts(keyFor(BADGE_COUNTS_CACHE_MAX_ENTRIES), counter("x").compute, clock)).cache,
    "hit",
    "the newest viewer must still be remembered",
  );

  // Expired copies are swept as new ones arrive, so a quiet hour does not leave hundreds behind.
  _resetBadgeCountsCache();
  let later = 9_000_000;
  const laterClock = () => later;
  await serveViewerBadgeCounts(keyFor(1), counter("1").compute, laterClock);
  later += BADGE_COUNTS_CACHE_TTL_MS;
  await serveViewerBadgeCounts(keyFor(2), counter("2").compute, laterClock);
  assert.equal(_badgeCountsCacheSize(), 1, "an expired copy at the front must be swept when a new one is stored");
  _resetBadgeCountsCache();
}

function inboxEarlyZeroHoldsForEveryListedRole() {
  const VIEWER = "VW-1";
  for (const role of SELF_ONLY_OTHER_APPROVALS_ROLES) {
    const access = createAccessContext({ hrId: VIEWER, role, source: "session" });
    assert.ok(
      access.scope !== "system" && access.scope !== "company",
      `${role} resolves to the ${access.scope} scope — a company reader sees every resignation and contract and must never be short-circuited`,
    );
    assert.equal(otherApprovalsInboxIsAlwaysEmptyFor(access), true, `${role} must take the early zero`);

    // Their own record: visible (and dropped later by survivesAwaitingInbox, as their own).
    assert.equal(canSeeEmployee(access, { hrId: VIEWER, managerHrId: "DM-9" }), true, `${role} must still see their own resignation`);
    assert.equal(
      canSeeHrScopedRecord(access, { employeeHrId: VIEWER, managerHrId: "DM-9" }),
      true,
      `${role} must still see their own contract`,
    );

    // Anyone else — a direct report, a seat-continuity report, an unrelated colleague — never.
    const others = [
      { hrId: "RP-1", managerHrId: VIEWER },
      { hrId: "RP-2", managerHrId: "DM-9", pendingManagerReplacementForHrId: VIEWER },
      { hrId: "RP-3", managerHrId: "DM-9" },
    ];
    const byCanonicalHrId = new Map([
      ["rp-1", { managerHrId: VIEWER, pendingManagerReplacementForHrId: null }],
      ["rp-4", { managerHrId: "RP-1", pendingManagerReplacementForHrId: null }],
    ]);
    for (const other of [...others, { hrId: "RP-4", managerHrId: "RP-1" }]) {
      const why = `${role} can see ${other.hrId}'s resignation — the "Other Approvals" early zero would then hide a request that is theirs to act on. Take ${role} out of SELF_ONLY_OTHER_APPROVALS_ROLES`;
      assert.equal(canSeeEmployee(access, other), false, why);
      assert.equal(canSeeEmployee(access, other, { byCanonicalHrId }), false, why);
      assert.equal(
        canSeeHrScopedRecord(access, { employeeHrId: other.hrId, managerHrId: other.managerHrId }),
        false,
        `${role} can see ${other.hrId}'s contract — take ${role} out of SELF_ONLY_OTHER_APPROVALS_ROLES`,
      );
    }

    // Even a listed role reads in full if its context ever carries a company or system scope.
    const reader = "a company or system reader sees every resignation and contract, so it must keep the full read";
    assert.equal(otherApprovalsInboxIsAlwaysEmptyFor({ ...access, scope: "company" }), false, `${role} at company scope: ${reader}`);
    assert.equal(otherApprovalsInboxIsAlwaysEmptyFor({ ...access, scope: "system" }), false, `${role} at system scope: ${reader}`);
  }

  // Every other role keeps the full read — including the retired HR Advisory seat, which is unproven.
  for (const role of phoenixRoles) {
    if (SELF_ONLY_OTHER_APPROVALS_ROLES.has(role)) continue;
    const access = createAccessContext({ hrId: VIEWER, role, source: "session" });
    assert.equal(otherApprovalsInboxIsAlwaysEmptyFor(access), false, `${role} is not proven self-only and must keep the full read`);
  }
  for (const manager of ["District Manager", "Manager", "Regional Manager", "National Sales Manager"] as const) {
    assert.ok(!SELF_ONLY_OTHER_APPROVALS_ROLES.has(manager), `${manager} sees reports and must never take the early zero`);
  }
  assert.equal(otherApprovalsInboxIsAlwaysEmptyFor(createAccessContext({ source: "guest" })), true, "a guest sees nothing anywhere");
}

function inboxEarlyZeroIsWiredBeforeTheReads() {
  const read = (path: string) => stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  const bodyOf = (source: string, signature: string, file: string) => {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in ${file}`);
    const end = source.indexOf("\n}\n", start);
    return source.slice(start, end < 0 ? undefined : end);
  };
  const ACTION = "src/lib/action-center/service.ts";
  const RESIGNATIONS = "src/lib/resignations/service.ts";
  const CONTRACTS = "src/lib/contracts/service.ts";
  const action = read(ACTION);
  const resignations = read(RESIGNATIONS);
  const contracts = read(CONTRACTS);

  // The early zero sits in the count, before either dashboard is read, and only with outstation off.
  const count = bodyOf(action, "export async function countAwaitingMyActionItems(", ACTION);
  const early = count.indexOf("if (!includeOutstationAdminSource && otherApprovalsInboxIsAlwaysEmptyFor(access)) return 0;");
  assert.ok(early >= 0, "countAwaitingMyActionItems must answer 0 for a self-only seat without reading the two dashboards");
  assert.ok(early < count.indexOf("getResignationsDashboardData(access)"), "the early zero must come BEFORE the resignations read");
  assert.ok(early < count.indexOf("getContractRenewalDashboardData(access)"), "the early zero must come BEFORE the contracts read");

  // The proof leans on these exact lines; if one moves, the early zero must be re-proven.
  assert.match(
    bodyOf(action, "function survivesAwaitingInbox(", ACTION),
    /!hrIdsMatch\(item\.employeeHrId, access\.hrId\)/,
    "the inbox must still drop the viewer's own items — the early zero is only true because it does",
  );
  assert.match(bodyOf(action, "function mapResignationItem(", ACTION), /employeeHrId: record\.employeeHrId,/);
  assert.match(bodyOf(action, "function mapContractRenewalItem(", ACTION), /employeeHrId: w\.employeeHrId,/);
  assert.match(
    bodyOf(resignations, "export async function getResignationsDashboardData(", RESIGNATIONS),
    /return employee \? canSeeEmployee\(scopedAccess, employee\) : false;/,
    "a non-company resignation reader must still be scoped by canSeeEmployee, the helper probed above",
  );
  assert.match(
    bodyOf(contracts, "function canSeeContractRow(", CONTRACTS),
    /return canSeeHrScopedRecord\(access, \{/,
    "a non-company contract reader must still be scoped by canSeeHrScopedRecord, the helper probed above",
  );
  for (const [file, source, signature] of [
    [RESIGNATIONS, resignations, "function isCompanyResignationReader("],
    [CONTRACTS, contracts, "function isCompanyContractReader("],
  ] as const) {
    const body = bodyOf(source, signature, file);
    for (const role of SELF_ONLY_OTHER_APPROVALS_ROLES) {
      assert.ok(
        !body.includes(`"${role}"`),
        `${signature.slice(9, -1)} now names ${role} — a company reader sees everyone's records, so ${role} must leave SELF_ONLY_OTHER_APPROVALS_ROLES`,
      );
    }
  }
}

function routeServesThroughTheMemory() {
  const route = stripComments(readFileSync(new URL("../app/api/approvals/badge-counts/route.ts", import.meta.url), "utf8"));
  assert.match(
    route,
    /serveViewerBadgeCounts\(badgeCountsViewerKey\(access\), async \(\) => \{/,
    "the batched poll must be served through the per-viewer memory, keyed on the viewer's whole access context",
  );
  assert.match(
    route,
    /cacheable: badgeCountsAreCacheable\(settled, isForbiddenError\)/,
    "only a response whose every rejection is a permission refusal may be remembered",
  );
  assert.match(route, /recordTiming\("badge_counts", Date\.now\(\) - startedAt\)/, "a real read keeps its process_health name");
  assert.match(route, /recordTiming\("badge_counts_cached", Date\.now\(\) - startedAt\)/, "a remembered answer is counted apart");
}
