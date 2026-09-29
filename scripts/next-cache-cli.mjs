// `next/cache` for a command-line run. scripts/alias-loader.mjs resolves the specifier here.
//
// The real module cannot be used outside a Next server. It IMPORTS fine — which is what made this
// easy to get wrong — and then throws the moment a wrapped function is actually called:
//
//   Error: Invariant: incrementalCache missing in unstable_cache async function loadAllVacationRequestRowsRaw()
//
// So an ops script that only touches a domain module importing `unstable_cache` would start, and
// one that calls through it would die mid-run. Both happen: scripts/import-crm-vacation-backfill.ts
// is the first kind, a script reading getVacationReportData is the second.
//
// Caching and revalidation are server-runtime concerns; a CLI run has no request, no incremental
// cache and no page to revalidate. Reading live is what an ops script wants anyway — a cached read
// would be the bug, since these scripts exist to act on the database as it is right now.
//
// The email templates are deliberately NOT treated this way — the loader compiles those for real,
// because a stubbed render would let a run believe it had produced something it had not. Nothing is
// faked here either: the work still happens, it simply happens uncached.

/** Runs the function, uncached. The real signature also takes keyParts and options; both only
 * affect cache identity and lifetime, so they are accepted and ignored. */
export function unstable_cache(fn) {
  return fn;
}

/** No page cache exists in a CLI run, so there is nothing to invalidate. */
export function revalidatePath() {}

/** No page cache exists in a CLI run, so there is nothing to invalidate. */
export function revalidateTag() {}

/** Opting out of a cache that is not there. */
export function unstable_noStore() {}
