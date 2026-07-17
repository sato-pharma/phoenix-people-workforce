import assert from "node:assert/strict";

import {
  subscribeNavBadge,
  _resetNavBadgeChannels,
  BADGE_COUNTS_ENDPOINT,
} from "../src/lib/nav-badge-store.ts";

// ── Minimal browser-environment mock ─────────────────────────────────────────
// subscribeNavBadge guards on `typeof window === "undefined"` and uses
// document.addEventListener / removeEventListener. We install lightweight
// globals once so the store behaves as it would in a real browser.

const visibilityListeners: (() => void)[] = [];
const mockDocument = {
  addEventListener(_evt: string, fn: () => void) {
    visibilityListeners.push(fn);
  },
  removeEventListener(_evt: string, fn: () => void) {
    const i = visibilityListeners.indexOf(fn);
    if (i >= 0) visibilityListeners.splice(i, 1);
  },
  visibilityState: "visible" as string,
};
(globalThis as unknown as Record<string, unknown>)["window"] = {};
(globalThis as unknown as Record<string, unknown>)["document"] = mockDocument;

// ── Fetch mock ────────────────────────────────────────────────────────────────
let fetchCallCount = 0;
let mockCount = 0;

function setupFetch(count: number): void {
  fetchCallCount = 0;
  mockCount = count;
  (globalThis as unknown as Record<string, unknown>)["fetch"] = () => {
    fetchCallCount++;
    return Promise.resolve({
      json: () => Promise.resolve({ count: mockCount }),
    });
  };
}

// Flush all pending microtasks (doFetch has two .then() hops).
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── Tests ─────────────────────────────────────────────────────────────────────
export async function runNavBadgeStoreTests() {
  // ── 1. First subscriber triggers exactly one fetch ──────────────────────────
  {
    setupFetch(5);
    _resetNavBadgeChannels();
    const received: (number | null)[] = [];
    const unsub = subscribeNavBadge("/api/nb-t1", (c) => received.push(c));
    await flush();
    assert.equal(fetchCallCount, 1, "1: first subscriber must trigger exactly one fetch");
    assert.deepEqual(received, [5], "1: listener must receive the fetched count");
    unsub();
    _resetNavBadgeChannels();
  }

  // ── 2. Second subscriber with the same src does NOT trigger another fetch ───
  {
    setupFetch(5);
    _resetNavBadgeChannels();
    const unsub1 = subscribeNavBadge("/api/nb-t2", () => {});
    await flush();
    const countAfterFirst = fetchCallCount;
    // Second subscriber — same src, no new fetch expected
    const unsub2 = subscribeNavBadge("/api/nb-t2", () => {});
    await flush();
    assert.equal(
      fetchCallCount,
      countAfterFirst,
      "2: second subscriber must not trigger another fetch",
    );
    unsub1();
    unsub2();
    _resetNavBadgeChannels();
  }

  // ── 3. Second subscriber receives cached count immediately ──────────────────
  {
    setupFetch(7);
    _resetNavBadgeChannels();
    const unsub1 = subscribeNavBadge("/api/nb-t3", () => {});
    await flush(); // let first fetch resolve and populate channel.count
    const received2: (number | null)[] = [];
    // Cached delivery is synchronous inside subscribeNavBadge
    const unsub2 = subscribeNavBadge("/api/nb-t3", (c) => received2.push(c));
    assert.ok(received2.length > 0, "3: second subscriber must get count without waiting");
    assert.equal(received2[0], 7, "3: cached count must match the fetched value");
    unsub1();
    unsub2();
    _resetNavBadgeChannels();
  }

  // ── 4. Different src values create independent channels ─────────────────────
  {
    setupFetch(3);
    _resetNavBadgeChannels();
    const unsub1 = subscribeNavBadge("/api/nb-t4a", () => {});
    await flush();
    const countAfterFirst = fetchCallCount;
    const unsub2 = subscribeNavBadge("/api/nb-t4b", () => {});
    await flush();
    assert.ok(
      fetchCallCount > countAfterFirst,
      "4: different src must produce a separate fetch",
    );
    unsub1();
    unsub2();
    _resetNavBadgeChannels();
  }

  // ── 5. Unsubscribing all subscribers tears down the channel ─────────────────
  {
    setupFetch(2);
    _resetNavBadgeChannels();
    const unsub1 = subscribeNavBadge("/api/nb-t5", () => {});
    const unsub2 = subscribeNavBadge("/api/nb-t5", () => {});
    await flush();
    unsub1(); // one subscriber remains — channel stays alive
    unsub2(); // last subscriber — channel must be deleted
    await flush();
    const countBeforeReSub = fetchCallCount;
    // Re-subscribing after full teardown must boot a fresh channel (new fetch)
    const unsub3 = subscribeNavBadge("/api/nb-t5", () => {});
    await flush();
    assert.ok(
      fetchCallCount > countBeforeReSub,
      "5: re-subscribing after teardown must trigger a fresh fetch",
    );
    unsub3();
    _resetNavBadgeChannels();
  }

  // ── 6. Polling infrastructure is active (visibilitychange re-fetches) ───────
  {
    setupFetch(4);
    _resetNavBadgeChannels();
    const unsub = subscribeNavBadge("/api/nb-t6", () => {});
    await flush();
    const countAfterBoot = fetchCallCount;
    // Simulate tab becoming visible — the store's onVisible handler must fire
    visibilityListeners.forEach((fn) => fn());
    await flush();
    assert.ok(
      fetchCallCount > countAfterBoot,
      "6: visibilitychange must trigger a re-fetch (polling infrastructure active)",
    );
    unsub();
    _resetNavBadgeChannels();
  }

  // ── 7. inFlight guard prevents overlapping concurrent fetches ───────────────
  {
    _resetNavBadgeChannels();
    // Use a deferred fetch so we can trigger an overlapping call while the
    // first one is still pending.
    let resolveFirstFetch!: () => void;
    let deferredFetchCount = 0;
    (globalThis as unknown as Record<string, unknown>)["fetch"] = () => {
      deferredFetchCount++;
      return new Promise<{ json: () => Promise<{ count: number }> }>((resolve) => {
        resolveFirstFetch = () =>
          resolve({ json: () => Promise.resolve({ count: 99 }) });
      });
    };

    const unsub = subscribeNavBadge("/api/nb-t7", () => {});
    // First fetch is now in-flight (deferredFetchCount === 1, inFlight !== null)

    // Simulate a concurrent trigger via visibilitychange — inFlight guard must block it
    visibilityListeners.forEach((fn) => fn());

    assert.equal(
      deferredFetchCount,
      1,
      "7: inFlight guard must prevent a second fetch while one is already running",
    );

    // Resolve the original fetch and clean up
    resolveFirstFetch();
    await flush();
    unsub();
    _resetNavBadgeChannels();
    // Reset fetch mock to a normal one for any subsequent runs
    setupFetch(0);
  }

  // ── 8. Approval badge srcs share ONE batched fetch (per-src counts intact) ──
  {
    _resetNavBadgeChannels();
    const fetchedUrls: string[] = [];
    (globalThis as unknown as Record<string, unknown>)["fetch"] = (url: string) => {
      fetchedUrls.push(url);
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            plan: { count: 2, overdue: false },
            vacation: { count: 5, overdue: true },
            excuse: { count: 0, overdue: false },
            hub: { count: 9 },
          }),
      });
    };

    const vacationReceived: Array<{ count: number | null; overdue: boolean }> = [];
    const hubReceived: Array<{ count: number | null; overdue: boolean }> = [];
    const unsubVacation = subscribeNavBadge("/api/approvals/vacation/pending-count", (c, o) =>
      vacationReceived.push({ count: c, overdue: o }),
    );
    const unsubHub = subscribeNavBadge("/api/approvals-hub/pending-count", (c, o) =>
      hubReceived.push({ count: c, overdue: o }),
    );
    await flush();

    assert.deepEqual(
      fetchedUrls,
      [BADGE_COUNTS_ENDPOINT],
      "8: two badge srcs must share exactly one batched fetch to the badge-counts endpoint",
    );
    assert.deepEqual(
      vacationReceived,
      [{ count: 5, overdue: true }],
      "8: the vacation channel must receive its own slot from the batched response",
    );
    assert.deepEqual(
      hubReceived,
      [{ count: 9, overdue: false }],
      "8: the hub channel must receive its own slot (no overdue flag → false)",
    );

    unsubVacation();
    unsubHub();
    _resetNavBadgeChannels();
    setupFetch(0);
  }
}
