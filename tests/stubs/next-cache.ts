// Test stub for `next/cache`.
//
// The unit/integration suite loads domain code directly via Node type-stripping
// (see tests/alias-loader.mjs) with no Next.js bundler. `next/cache` cannot be
// resolved in that environment, so any domain file importing it (e.g.
// src/lib/sales-marketing-intelligence/service.ts, src/lib/dashboard/invalidation.ts)
// would crash the whole suite with ERR_MODULE_NOT_FOUND — regardless of whether the
// import used the `next/cache` or `next/cache.js` specifier.
//
// These no-ops let those modules load under test. Caching/revalidation are runtime
// concerns exercised by the app/CI build, not by these unit tests.

export function unstable_cache<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

export function revalidatePath(_path: string, _type?: "layout" | "page"): void {}

export function revalidateTag(_tag: string): void {}

export function unstable_noStore(): void {}
