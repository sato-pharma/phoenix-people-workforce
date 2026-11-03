import { toast } from "sonner";

import { resumePageView, sendPageViewsBeforeSignOut } from "@/lib/activity/page-view-queue";
import { browserLocalStorage, clearSignedOutDrafts } from "@/lib/browser-storage/owner-scoped";
import { hardNavigate } from "@/lib/navigation/browser-navigation";
import { logoutOneSignal } from "@/lib/notifications/onesignal-client";

/** What a person is told when sign-out did not reach the server: they are still signed in. */
export const SIGN_OUT_FAILED_MESSAGE =
  "Sign-out did not reach the server, so you are still signed in. Check the connection and press Logout again.";

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
 * signed-out person's pushes. The page views go next and are waited for, up to a short cap, because
 * the track route drops anything that reaches it after the logout. A refused sign-out leaves the
 * person on the page, so its clock starts again.
 *
 * Once the server has answered, the person's unsaved-typing drafts are removed from this browser
 * (cache audit, 2026-10-26) — the next person on a shared PC must not open the Contact HR form to
 * find the last person's message. The offline queues are deliberately kept: they are owner-checked
 * and wait for their owner (src/lib/browser-storage/owner-scoped.ts).
 */
export async function signOutAndLeave(): Promise<boolean> {
  logoutOneSignal();
  await sendPageViewsBeforeSignOut();
  let response: Response;
  try {
    response = await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    resumePageView();
    toast.error(SIGN_OUT_FAILED_MESSAGE);
    return false;
  }
  if (!response.ok) {
    resumePageView();
    const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
    toast.error(typeof payload?.message === "string" && payload.message ? payload.message : SIGN_OUT_FAILED_MESSAGE);
    return false;
  }
  clearSignedOutDrafts(browserLocalStorage());
  hardNavigate("/login");
  return true;
}
