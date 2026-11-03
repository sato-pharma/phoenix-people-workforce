import { toast } from "sonner";

import { browserLocalStorage, clearSignedOutDrafts } from "@/lib/browser-storage/owner-scoped";
import { hardNavigate } from "@/lib/navigation/browser-navigation";
import { logoutOneSignal } from "@/lib/notifications/onesignal-client";

/** What a person is told when sign-out did not reach the server: they are still signed in. */
export const SIGN_OUT_FAILED_MESSAGE =
  "Sign-out did not reach the server, so you are still signed in. Check the connection and press Logout again.";

const signOutStartTasks = new Set<() => void>();

/**
 * Work that must leave this browser while the session still exists, run as a sign-out starts. The
 * activity tracker's queued page views use it: posted after the logout, the track route drops them.
 */
export function onSignOutStart(task: () => void): void {
  signOutStartTasks.add(task);
}

/**
 * EVERY SIGN-OUT BUTTON CALLS THIS (technical audit, 2026-10-23, P7-03).
 *
 * The buttons used to go to /login whether or not the request landed — the admin top bar swallowed
 * a network failure silently, and the portal's buttons navigated in a `finally`. On a shared PC that
 * left the last person signed in behind a login screen. Now the browser leaves only once the server
 * has answered (and the server clears the cookies before anything else can fail); otherwise the
 * person is told, and stays where they are to press it again.
 *
 * The OneSignal unbind comes first and never blocks, so a shared device stops receiving the
 * signed-out person's pushes.
 *
 * Once the server has answered, the person's unsaved-typing drafts are removed from this browser
 * (cache audit, 2026-10-26) — the next person on a shared PC must not open the Contact HR form to
 * find the last person's message. The offline queues are deliberately kept: they are owner-checked
 * and wait for their owner (src/lib/browser-storage/owner-scoped.ts).
 */
export async function signOutAndLeave(): Promise<boolean> {
  for (const task of signOutStartTasks) {
    try {
      task();
    } catch {
      // Nothing queued for the session may stop the person signing out.
    }
  }
  logoutOneSignal();
  let response: Response;
  try {
    response = await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    toast.error(SIGN_OUT_FAILED_MESSAGE);
    return false;
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
    toast.error(typeof payload?.message === "string" && payload.message ? payload.message : SIGN_OUT_FAILED_MESSAGE);
    return false;
  }
  clearSignedOutDrafts(browserLocalStorage());
  hardNavigate("/login");
  return true;
}
