import assert from "node:assert/strict";

import {
  isStaleDeployChunkError,
  isTransientRouterMountError,
  recoverFromStaleDeployOnce,
} from "../src/lib/utils/stale-deploy-recovery.ts";

class FakeSessionStorage {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

export function runStaleDeployRecoveryTests() {
  // ── isStaleDeployChunkError: matches known stale-deploy failure shapes ──────
  assert.equal(isStaleDeployChunkError(Object.assign(new Error("x"), { name: "ChunkLoadError" })), true);
  assert.equal(isStaleDeployChunkError(new Error("Loading chunk 42 failed.")), true);
  assert.equal(
    isStaleDeployChunkError(new Error("Failed to fetch dynamically imported module: https://x/y.js")),
    true,
  );
  assert.equal(isStaleDeployChunkError(new Error("Importing a module script failed")), true);
  // Webpack's own runtime symptom of a missing/stale module factory — seen in production
  // (app_error_events, module=command_center) going unrecovered before this was added.
  assert.equal(
    isStaleDeployChunkError(new TypeError("Cannot read properties of undefined (reading 'call')")),
    true,
  );

  // ── isStaleDeployChunkError: does not swallow unrelated application errors ──
  assert.equal(isStaleDeployChunkError(new Error("Forbidden: cannot read payroll")), false);
  assert.equal(isStaleDeployChunkError(new TypeError("Cannot read properties of undefined")), false);
  // Same "Cannot read properties of undefined" prefix but a different property — must stay
  // unmatched, since only "(reading 'call')" is the specific webpack-chunk signature.
  assert.equal(
    isStaleDeployChunkError(new TypeError("Cannot read properties of undefined (reading 'email')")),
    false,
  );

  // ── isTransientRouterMountError: matches the App Router mount-race invariant ─
  assert.equal(
    isTransientRouterMountError(new Error("invariant expected layout router to be mounted")),
    true,
  );
  assert.equal(isTransientRouterMountError(new Error("Forbidden: cannot read payroll")), false);
  assert.equal(isStaleDeployChunkError(new Error("invariant expected layout router to be mounted")), false);

  // ── recoverFromStaleDeployOnce: reloads once and sets a guard timestamp ─────
  let reloadCount = 0;
  const fakeSessionStorage = new FakeSessionStorage();
  (globalThis as { window?: unknown }).window = {
    location: { reload: () => { reloadCount += 1; } },
    sessionStorage: fakeSessionStorage,
  };

  try {
    const firstAttempt = recoverFromStaleDeployOnce();
    assert.equal(firstAttempt, true, "first stale-deploy error triggers a reload");
    assert.equal(reloadCount, 1);

    // A second error arriving immediately after (e.g. from another route in the same
    // tab) must not trigger a second reload — that would be a reload loop.
    const secondAttempt = recoverFromStaleDeployOnce();
    assert.equal(secondAttempt, false, "reload is guarded within the cooldown window");
    assert.equal(reloadCount, 1);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }

  // ── recoverFromStaleDeployOnce: no-op outside the browser (SSR/tests) ───────
  assert.equal(recoverFromStaleDeployOnce(), false);
}
