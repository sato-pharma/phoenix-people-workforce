// Test stub for `next/cache`.
//
// The unit/integration suite loads domain code directly via Node type-stripping
// (see tests/alias-loader.mjs) with no Next.js bundler. `next/cache` cannot be
// resolved in that environment, so any domain file importing it (e.g.
// src/lib/sales-marketing-intelligence/service.ts, src/lib/dashboard/invalidation.ts)
// would crash the whole suite with ERR_MODULE_NOT_FOUND — regardless of whether the
// import used the `next/cache` or `next/cache.js` specifier.
//
// These no-ops let those modules load under test. Caching itself is a runtime concern
// exercised by the app/CI build, not by these unit tests.
//
// REVALIDATION CAN BE WATCHED (REC-079, 19 Nov 2026). A test that wants to see which tags a write
// busts calls `watchNextCacheForTests()`: every revalidatePath/revalidateTag is then recorded, in
// order, with the profile it was given, until `stop()`. `{ throwing: true }` makes each call throw
// AFTER it is recorded, the way Next does outside a request scope (a cron), so a test can prove a
// write survives it. Nothing is recorded while no watch is armed, so the rest of the suite is
// unaffected. The test imports this file by path; the alias loader maps `next/cache` to the same
// file, so both see one module.

export type NextCacheCall =
  | { kind: "path"; target: string; type?: "layout" | "page" }
  | { kind: "tag"; target: string; profile?: unknown };

let watch: { calls: NextCacheCall[]; throwing: boolean } | null = null;

export function watchNextCacheForTests(options: { throwing?: boolean } = {}): { calls: NextCacheCall[]; stop(): void } {
  const armed = { calls: [] as NextCacheCall[], throwing: options.throwing === true };
  watch = armed;
  return {
    calls: armed.calls,
    stop() {
      if (watch === armed) watch = null;
    },
  };
}

function observe(call: NextCacheCall): void {
  if (!watch) return;
  watch.calls.push(call);
  if (watch.throwing) throw new Error(`Invariant: ${call.kind === "tag" ? "revalidateTag" : "revalidatePath"} called outside a request scope`);
}

export function unstable_cache<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

export function revalidatePath(path: string, type?: "layout" | "page"): void {
  observe({ kind: "path", target: path, type });
}

export function revalidateTag(tag: string, profile?: unknown): void {
  observe({ kind: "tag", profile, target: tag });
}

export function unstable_noStore(): void {}
