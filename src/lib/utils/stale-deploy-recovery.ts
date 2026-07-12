const RELOAD_GUARD_KEY = "phoenix-stale-deploy-reload-at";
const RELOAD_GUARD_WINDOW_MS = 10_000;

/**
 * A live deploy replaces the previous build's JS chunk files. A tab that was already
 * open when that happens will throw one of these the next time it tries to load a
 * route it hasn't fetched yet — the browser is requesting a chunk URL that no longer
 * exists on the server. "Cannot read properties of undefined (reading 'call')" is
 * webpack's own runtime symptom of the same failure — it tries to invoke a module
 * factory function that never finished loading — and was observed in production
 * (app_error_events, module=command_center) going unrecovered because this detector
 * didn't previously recognize that message shape; only the byte-for-byte string
 * "(reading 'call')" is matched, not the generic "Cannot read properties of
 * undefined" prefix alone, which covers countless unrelated real application bugs.
 */
export function isStaleDeployChunkError(error: Error) {
  return (
    error.name === "ChunkLoadError" ||
    /loading chunk [\d]+ failed|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|cannot read properties of undefined \(reading 'call'\)/i.test(
      error.message ?? "",
    )
  );
}

/**
 * A distinct failure mode from a stale chunk: Next.js App Router's own internal
 * invariant, thrown when a navigation transition races the router's own mount state
 * (observed in production on `/login` and `/`, both of which redirect unconditionally
 * on load — a classic trigger for this exact race). Investigated 2026-07-12: no
 * app-code path calls `router.push`/`replace` synchronously during render on either
 * route, so this isn't independently fixable at the app-code level — it's a Next.js
 * framework-internal timing issue. A full reload always clears it regardless of cause
 * (it's a transient mount-state problem, not a persistent one), so it gets the same
 * recovery action as a stale chunk without being conflated with that detector.
 */
export function isTransientRouterMountError(error: Error) {
  return /invariant expected layout router to be mounted/i.test(error.message ?? "");
}

/**
 * A full reload re-fetches the current deployment's manifest instead of retrying the
 * (now-nonexistent) old chunk URL, so it clears the error automatically. Guarded by a
 * timestamp in sessionStorage so a persistent error that happens to match the same
 * message can't force a reload loop.
 */
export function recoverFromStaleDeployOnce() {
  if (typeof window === "undefined") return false;

  const lastReload = Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
  if (Date.now() - lastReload < RELOAD_GUARD_WINDOW_MS) return false;

  window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  window.location.reload();
  return true;
}
