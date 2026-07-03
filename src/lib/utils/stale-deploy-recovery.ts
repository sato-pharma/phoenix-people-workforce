const RELOAD_GUARD_KEY = "phoenix-stale-deploy-reload-at";
const RELOAD_GUARD_WINDOW_MS = 10_000;

/**
 * A live deploy replaces the previous build's JS chunk files. A tab that was already
 * open when that happens will throw one of these the next time it tries to load a
 * route it hasn't fetched yet — the browser is requesting a chunk URL that no longer
 * exists on the server.
 */
export function isStaleDeployChunkError(error: Error) {
  return (
    error.name === "ChunkLoadError" ||
    /loading chunk [\d]+ failed|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(
      error.message ?? "",
    )
  );
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
