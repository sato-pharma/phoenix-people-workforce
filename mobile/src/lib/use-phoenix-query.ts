import { useCallback, useEffect, useState } from "react";

import { ApiError, NetworkError, apiGetData } from "./api";
import { readCache, writeCache } from "./offline-cache";
import { useSession } from "./session";

type QueryState<T> = {
  data: T | null;
  error: string | null;
  /** True on the first load only — a refresh keeps the previous data on screen. */
  loading: boolean;
  /** True while a pull-to-refresh is in flight. */
  refreshing: boolean;
  /**
   * When the data on screen was actually fetched, or null when it came straight from the server.
   * A screen showing a non-null value here MUST say so — that is what `OfflineNotice` is for.
   */
  cachedAt: string | null;
};

/**
 * Fetch a Phoenix endpoint for the current session, with refresh, expiry and offline handling.
 *
 * Every screen's read goes through this so four behaviours are consistent everywhere:
 *
 *   1. A 401/403 signs the app out rather than showing an error — the session is genuinely over
 *      (expired, revoked from "Log out everywhere", or the employee record went inactive), and
 *      leaving the person staring at "Forbidden" with no way forward is the wrong answer.
 *   2. A refresh keeps the last good data visible. A rep pulling to refresh on a weak connection
 *      should not lose the screen they were reading.
 *   3. A network failure is reported as a network failure, not as a server error. They have
 *      different remedies and a field user can act on the difference.
 *   4. When the phone could not reach Phoenix at all, the last good answer is served from the
 *      keystore — LABELLED, never silently. `cachedAt` is non-null exactly then, and a screen that
 *      renders cached data without saying so is a defect.
 *
 * ON WHICH FAILURES FALL BACK TO CACHE. Only `NetworkError` — the request never landed. An
 * `ApiError` means the server answered and said no, and showing yesterday's figures on top of a
 * live 500 would hide a real fault behind data that looks perfectly fine. That distinction is the
 * whole reason a cache is safe to have here at all.
 */
export function usePhoenixQuery<T>(path: string): QueryState<T> & { refresh: () => void } {
  const { handleExpiredSession, token, user } = useSession();
  const [state, setState] = useState<QueryState<T>>({
    cachedAt: null,
    data: null,
    error: null,
    loading: true,
    refreshing: false,
  });

  // What scopes a cached entry to one employee. `loginId` rather than the token, because the token
  // changes every time they sign in and the cache should survive that; and rather than `hrId`,
  // which is null for accounts with no employee record.
  const scope = user?.loginId ?? null;

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (!token) return;

      setState((previous) => ({
        ...previous,
        error: null,
        loading: mode === "initial",
        refreshing: mode === "refresh",
      }));

      try {
        const data = await apiGetData<T>(path, token);
        setState({ cachedAt: null, data, error: null, loading: false, refreshing: false });

        if (scope) {
          // Deliberately not awaited into the render path — a keystore write must never be what
          // keeps a rep waiting to see data the app already has in hand.
          void writeCache(path, scope, data);
        }
        return;
      } catch (error) {
        if (error instanceof ApiError && error.isSessionExpired) {
          // `handleExpiredSession` clears the cache along with the token — it is the session layer's
          // job, not this hook's, so that every path out of a session drops the figures with it.
          await handleExpiredSession();
          return;
        }

        const message =
          error instanceof NetworkError || error instanceof ApiError
            ? error.message
            : "Something went wrong loading this screen.";

        if (error instanceof NetworkError && scope) {
          const cached = await readCache<T>(path, scope);
          if (cached) {
            setState({
              cachedAt: cached.cachedAt,
              data: cached.payload,
              // No error banner alongside it. The screen is working, with data whose age it states
              // plainly; stacking a red failure notice on top of a labelled offline notice reads as
              // two problems when there is one situation.
              error: null,
              loading: false,
              refreshing: false,
            });
            return;
          }
        }

        setState((previous) => ({ ...previous, error: message, loading: false, refreshing: false }));
      }
    },
    [handleExpiredSession, path, scope, token],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const refresh = useCallback(() => {
    void load("refresh");
  }, [load]);

  return { ...state, refresh };
}
