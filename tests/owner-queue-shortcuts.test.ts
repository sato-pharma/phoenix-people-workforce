import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadOwnerQueueBadges, OWNER_QUEUE_KEYS, OWNER_QUEUE_SLOT_BY_NAME } from "../src/lib/approvals-hub/owner-queue-badges.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { forbiddenError } from "../src/lib/http/api-errors.ts";
import { adminNavigationSections } from "../src/config/system-navigation.ts";
import { adminSidebarDomains } from "../src/config/sidebar-domains.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import { buildPermissionLookup, permissionMatrix, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { subscribeNavBadge, _resetNavBadgeChannels } from "../src/lib/nav-badge-store.ts";

/**
 * The owner's seven queue shortcuts (27 Nov 2026): "Add a customer to the list", "Visits held for SFE (far
 * visits)", "Double-visit request (up to 3 days)", "Visit ask: double, product manager or chain", "Probation",
 * "Contract renewal" and "Held emails (a check stopped the send)" — sidebar rows that show how many items wait
 * in each.
 *
 * Pins, by behaviour:
 *   1. each slot is the count its reader returned; a failed read is UNAVAILABLE (never a bare 0) and keeps the
 *      answer out of the batched poll's memory; a refusal is an empty slot, never "unavailable";
 *   2. nobody but the Super Admin pays a single read;
 *   3. the badge store hands `unavailable` to the badge, so it can draw a dash instead of nothing;
 *   4. the seven rows reach the Super Admin's rail, under the Approvals Hub door, carry his exact words, are
 *      his alone, and leave the five rows that already open those pages where they were.
 */

const SEVEN_FULL_LABELS = [
  "Add a customer to the list",
  "Visits held for SFE (far visits)",
  "Double-visit request (up to 3 days)",
  "Visit ask: double, product manager or chain",
  "Probation",
  "Contract renewal",
  "Held emails (a check stopped the send)",
];

const lookupForRole = (role: PhoenixRole) => buildPermissionLookup(permissionMatrix, role);

const asAccess = (role: string) => ({ role, hrId: "B-10", loginId: "test", scope: "all" }) as unknown as AccessContext;

export async function runOwnerQueueShortcutsTests() {
  // ── 1. counts, unavailable, refusals ────────────────────────────────────────────────────────────────
  {
    const counts = [27, 98, 4, 1, 3, 1, 0];
    const readers = Object.fromEntries(OWNER_QUEUE_KEYS.map((key, index) => [key, async () => counts[index]])) as unknown as Parameters<typeof loadOwnerQueueBadges>[1];
    const badges = await loadOwnerQueueBadges(asAccess("Super Admin"), readers);
    OWNER_QUEUE_KEYS.forEach((key, index) => assert.deepEqual(badges[key], { count: counts[index] }, `1a: ${key} carries its reader's count`));
    assert.equal(badges.available, true, "1a: every slot read, so the answer may be remembered");
  }
  {
    const readers = Object.fromEntries(OWNER_QUEUE_KEYS.map((key) => [key, async () => 5])) as unknown as NonNullable<Parameters<typeof loadOwnerQueueBadges>[1]>;
    readers.ownerFarVisitHolds = async () => {
      throw new Error("canceling statement due to statement timeout");
    };
    readers.ownerHeldEmails = async () => {
      throw forbiddenError("Only the Super Admin reads held emails.");
    };
    readers.ownerProbation = async () => {
      throw new Error("Forbidden: Super Admin cannot read probation.");
    };
    const badges = await loadOwnerQueueBadges(asAccess("Super Admin"), readers);
    assert.deepEqual(badges.ownerFarVisitHolds, { count: 0, unavailable: true }, "1b: a failed read is UNAVAILABLE, never a bare 0");
    assert.equal(badges.available, false, "1b: a failed read keeps the answer out of the 20 s memory");
    assert.deepEqual(badges.ownerHeldEmails, { count: 0 }, "1b: a 403 refusal is an empty slot, not 'unavailable'");
    assert.deepEqual(badges.ownerProbation, { count: 0 }, "1b: a 'Forbidden:' refusal is an empty slot, not 'unavailable'");
    assert.deepEqual(badges.ownerListAdds, { count: 5 }, "1b: one failed slot never blanks its neighbours");
  }
  assert.deepEqual(
    Object.values(OWNER_QUEUE_SLOT_BY_NAME).sort(),
    [...OWNER_QUEUE_KEYS].sort(),
    "1c: the route's ?queue= names cover exactly the seven slots",
  );

  // ── 2. nobody else pays a read ───────────────────────────────────────────────────────────────────────
  {
    let reads = 0;
    const readers = Object.fromEntries(OWNER_QUEUE_KEYS.map((key) => [key, async () => { reads += 1; return 9; }])) as unknown as Parameters<typeof loadOwnerQueueBadges>[1];
    for (const role of ["CEO", "SFE Manager", "HR Operations", "District Manager", "Medical Rep"]) {
      const badges = await loadOwnerQueueBadges(asAccess(role), readers);
      OWNER_QUEUE_KEYS.forEach((key) => assert.deepEqual(badges[key], { count: 0 }, `2: ${role} gets an empty ${key}`));
    }
    assert.equal(reads, 0, "2: no count is read for anyone but the Super Admin");
  }

  // ── 3. the store hands `unavailable` to the badge ────────────────────────────────────────────────────
  {
    const saved = { window: (globalThis as Record<string, unknown>).window, document: (globalThis as Record<string, unknown>).document, fetch: globalThis.fetch };
    try {
      (globalThis as Record<string, unknown>).window = {};
      (globalThis as Record<string, unknown>).document = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
      let answer: Record<string, unknown> = { count: 0, unavailable: true };
      (globalThis as Record<string, unknown>).fetch = () => Promise.resolve({ json: () => Promise.resolve(answer) });
      _resetNavBadgeChannels();
      const seen: [number | null, boolean, boolean][] = [];
      const unsubscribe = subscribeNavBadge("/api/owner-queue-test", (count, overdue, unavailable) => seen.push([count, overdue, unavailable]));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(seen, [[0, false, true]], "3: an unreadable count reaches the badge as unavailable");
      unsubscribe();
      answer = { count: 4 };
      _resetNavBadgeChannels();
      const later: [number | null, boolean, boolean][] = [];
      const again = subscribeNavBadge("/api/owner-queue-test", (count, overdue, unavailable) => later.push([count, overdue, unavailable]));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(later, [[4, false, false]], "3: a read count is not unavailable");
      again();
    } finally {
      _resetNavBadgeChannels();
      (globalThis as Record<string, unknown>).window = saved.window;
      (globalThis as Record<string, unknown>).document = saved.document;
      globalThis.fetch = saved.fetch;
    }
  }
  const navBadgeSource = readFileSync(new URL("../src/components/layout/nav-badge.tsx", import.meta.url), "utf8");
  assert.match(navBadgeSource, /if \(unavailable\) return <UnavailableNavBadge/, "3: NavBadge draws the unavailable mark before its `!count` early return");
  const storeSource = readFileSync(new URL("../src/lib/nav-badge-store.ts", import.meta.url), "utf8");
  for (const name of Object.keys(OWNER_QUEUE_SLOT_BY_NAME)) {
    const src = `/api/approvals/owner-queues/pending-count?queue=${name}`;
    assert.ok(navBadgeSource.includes(`"${src}"`), `3: navBadgeSrc maps a kind to ${src}`);
    assert.ok(storeSource.includes(`"${src}": "${OWNER_QUEUE_SLOT_BY_NAME[name]}"`), `3: ${src} rides the batched poll as ${OWNER_QUEUE_SLOT_BY_NAME[name]}`);
  }

  // ── 4. the rows ──────────────────────────────────────────────────────────────────────────────────────
  const band = adminNavigationSections.find((section) => section.id === "owner-queues");
  assert.ok(band, "4: the owner-queues band exists");
  assert.deepEqual(band.items.map((item) => item.fullLabel), SEVEN_FULL_LABELS, "4: the seven rows carry his exact words, in his order");
  for (const item of band.items) {
    assert.deepEqual(item.roles, ["Super Admin"], `4: ${item.label} is the Super Admin's alone`);
    assert.equal(item.permissions, undefined, `4: ${item.label} has no OR-ed permissions list to widen it`);
    assert.ok(item.navBadge?.startsWith("owner-"), `4: ${item.label} carries its own count`);
    assert.ok(item.href.includes("from=queues"), `4: ${item.label}'s href is marked so dedupe never moves another row`);
  }
  assert.ok(
    adminSidebarDomains.find((domain) => domain.id === "approvals")?.groups.some((group) => group.sectionIds.includes("owner-queues")),
    "4: the band sits under the Approvals Hub door",
  );

  const superAdmin = getSections(adminNavigationSections, "admin", lookupForRole("Super Admin"), "Super Admin");
  const hrefs = superAdmin.flatMap((section) => section.items.map((item) => item.href));
  for (const item of band.items) assert.ok(hrefs.includes(item.href), `4: the Super Admin's rail shows ${item.label}`);
  for (const kept of ["/admin/phoenix-crm/far-visit-holds", "/admin/phoenix-crm/double-visit-requests", "/probation", "/contracts", "/admin/notification-confidence"]) {
    const before = getSections(adminNavigationSections.filter((section) => section.id !== "owner-queues"), "admin", lookupForRole("Super Admin"), "Super Admin")
      .find((section) => section.items.some((item) => item.href === kept))?.id;
    const after = superAdmin.find((section) => section.items.some((item) => item.href === kept))?.id;
    assert.equal(after, before, `4: ${kept} stays in its own band (${before ?? "none"})`);
  }
  for (const role of ["CEO", "SFE Manager", "HR Operations", "Finance Manager"] as PhoenixRole[]) {
    const theirs = getSections(adminNavigationSections, "admin", lookupForRole(role), role).flatMap((section) => section.items);
    assert.equal(theirs.filter((item) => item.navBadge?.startsWith("owner-")).length, 0, `4: ${role} sees none of the seven shortcuts`);
  }
}
