import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { ApiError, apiRequest } from "./api";
import { clearCache } from "./offline-cache";

/**
 * Who is signed in, and where the proof of it lives.
 *
 * THE TOKEN GOES IN THE OS KEYSTORE, never in AsyncStorage. `expo-secure-store` is the Android
 * Keystore (and the iOS keychain later): encrypted at rest, tied to this app's signature, and gone
 * when the app is uninstalled. AsyncStorage is a plaintext file readable by anything with access to
 * the app's sandbox — on a rooted handset, that is the employee's live Phoenix session in the clear.
 *
 * The token is the same signed session token the web app keeps in an HttpOnly cookie, on the same
 * 12-hour absolute clock, revocable the same way. Nothing here extends a session; this layer only
 * stores one, attaches it, and throws it away the moment the server stops accepting it.
 *
 * ENDING A SESSION ALSO DROPS THE OFFLINE CACHE. `offline-cache.ts` keeps the last answer from each
 * endpoint so a rep out of signal still sees their figures, and those figures belong to the session
 * that fetched them. Both exits — a deliberate sign-out and a server-rejected one — clear it here,
 * so no path out of a session can leave one employee's data readable on the handset.
 */

export type PhoenixUser = {
  hrId: string | null;
  loginId: string;
  role: string;
};

type StoredSession = {
  expiresAt: string;
  landingPath: string;
  token: string;
  user: PhoenixUser;
};

type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; session: StoredSession };

type SessionContextValue = {
  state: SessionState;
  /** The bearer token, or null when signed out. Screens pass this to `apiGetData`. */
  token: string | null;
  user: PhoenixUser | null;
  signIn: (loginId: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Called by a screen when an API call comes back 401/403. Clears the device and drops to the
   * login screen, so a revoked session cannot leave the app sitting on stale data.
   */
  handleExpiredSession: () => Promise<void>;
};

const STORAGE_KEY = "phoenix.session";

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * True when a stored session is still inside its own declared lifetime.
 *
 * This is a convenience, NOT a security check — the server re-validates every token on every call
 * and is the only authority on whether a session is alive. Checking locally just avoids showing a
 * signed-in shell for a second before the first request bounces.
 */
function isUnexpired(session: StoredSession): boolean {
  const expiry = Date.parse(session.expiresAt);
  return Number.isFinite(expiry) && expiry > Date.now();
}

async function readStoredSession(): Promise<StoredSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.token || !parsed?.user?.loginId || !parsed?.expiresAt) return null;
    return isUnexpired(parsed) ? parsed : null;
  } catch {
    // A corrupt or unreadable entry is treated as "signed out" rather than surfaced. The keystore
    // can also throw on a device whose lock screen was just removed, and the right answer to every
    // one of those cases is the same: ask the person to sign in again.
    return null;
  }
}

async function clearStoredSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch {
    // Nothing useful to do — the token is already unusable to us, and the server-side session is
    // what actually matters. Swallowing keeps sign-out from failing in the person's face.
  }
}

type LoginResponse = {
  expiresAt?: string;
  landingPath?: string;
  sessionToken?: string;
  user?: PhoenixUser;
  warning?: string | null;
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    void readStoredSession().then((session) => {
      if (cancelled) return;
      setState(session ? { session, status: "signed-in" } : { status: "signed-out" });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (loginId: string, password: string) => {
    const payload = await apiRequest<LoginResponse>("/api/auth/login", {
      body: { loginId, password, remember: true },
      method: "POST",
    });

    if (!payload.sessionToken || !payload.user || !payload.expiresAt) {
      // The server accepted the credentials but did not return a token, which means the
      // `x-phoenix-client` header did not reach it — a proxy stripping headers, or a server older
      // than this app. Saying so beats a silent bounce back to the login screen.
      throw new ApiError("This server did not return a session for the app. Update the app or contact HR.", 500);
    }

    const session: StoredSession = {
      expiresAt: payload.expiresAt,
      landingPath: payload.landingPath ?? "/employee-portals",
      token: payload.sessionToken,
      user: payload.user,
    };

    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(session));
    setState({ session, status: "signed-in" });
  }, []);

  const signOut = useCallback(async () => {
    const token = state.status === "signed-in" ? state.session.token : null;

    // Clear the device first, then tell the server. If the network call fails the person is still
    // signed out of this handset, which is the outcome they asked for; the server-side session then
    // lapses on its own clock. Doing it the other way round leaves a live token on a phone whose
    // owner believes they signed out.
    await clearStoredSession();
    await clearCache();
    setState({ status: "signed-out" });

    if (token) {
      await apiRequest("/api/auth/logout", { method: "POST", token }).catch(() => undefined);
    }
  }, [state]);

  const handleExpiredSession = useCallback(async () => {
    await clearStoredSession();
    await clearCache();
    setState({ status: "signed-out" });
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      handleExpiredSession,
      signIn,
      signOut,
      state,
      token: state.status === "signed-in" ? state.session.token : null,
      user: state.status === "signed-in" ? state.session.user : null,
    }),
    [handleExpiredSession, signIn, signOut, state],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used inside <SessionProvider>.");
  }
  return context;
}
