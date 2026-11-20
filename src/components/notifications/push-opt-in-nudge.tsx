"use client";

import { useEffect, useState } from "react";
import { BellRing, X } from "lucide-react";

import { LandingPanel, landingActionClassName } from "@/components/employee-portal/landing-kit";
import { readHomeNotificationSettings } from "@/components/notifications/home-notification-settings";
import { useHydrated } from "@/hooks/use-hydrated";
import { onesignalAppId, pushUnsupportedMessage, requestOneSignalPermission } from "@/lib/notifications/onesignal-client";
// From the pure rules module, NOT from settings.ts — that file pulls in getSupabaseAdmin,
// writeAuditLog and the `crypto` node built-in, none of which may reach a "use client" bundle.
// See push-opt-in-nudge-rules.ts for the full story (an UnhandledSchemeError on "node:crypto" is
// what this import path used to produce).
import { shouldShowPushOptInNudge } from "@/lib/notifications/push-opt-in-nudge-rules";

type NudgeStatus = "checking" | "hidden" | "visible" | "working" | "granted";

/**
 * The landing kit's button shape (LandingCta) for an action that is a button, not a link — the kit
 * draws its call to action as a <Link>. Same frame, same type, 40px on a phone.
 */

/**
 * A quiet, dismissible card offering to turn push on, for the people who have never found the
 * "Enable push on this device" button — until now the only place that control existed was the
 * Notification Settings panel, reached only through Profile, and nothing anywhere ever pointed a
 * person at it. Measured on production 2026-09-06: 71 of 107 active employees have never enabled
 * push on any device, and 2,276 of the last 30 days' 5,051 push sends skipped with
 * "No active push subscription for recipient."
 *
 * This is a nudge, not a gate: it renders nothing while it is still finding out whether to show
 * itself, and nothing ever blocks on it — no modal, no interstitial, no sign-in step.
 *
 * ASKED ONCE, AND AGAIN ONLY AFTER A DROP (owner, 13 Nov 2026). It reads the same GET
 * /api/notifications/settings the settings panel calls (one request shared with the Telegram card
 * beside it, home-notification-settings.ts) and never shows when either is true: this person has a
 * device receiving push now (`push.deviceCount > 0`), or they answered this card before and no device
 * has stopped receiving since (`shouldShowPushOptInNudge`, in push-opt-in-nudge-rules.ts). Dismissing —
 * or successfully enabling — writes the answer via POST /api/notifications/push/nudge.
 *
 * Uses requestOneSignalPermission() (PushSubscription.optIn()), the exact call the settings panel
 * makes — never Notifications.requestPermission() directly. See onesignal-client.ts for why
 * swapping that back silently breaks push_subscriptions.
 *
 * THE LOOK (owner, 2026-11-20 landing redesign): the landing kit's white panel, worn the same way as
 * the Telegram card under it — the tick title says where this device stands, one body line says what
 * push gives them, the kit's navy buttons act, and dismiss sits in the header's right slot.
 */
export function PushOptInNudge() {
  const hydrated = useHydrated();
  // Plain render-time value, not state: onesignalAppId() reads a build-time env var that never
  // changes across a session, so there is nothing to synchronize and no reason to setState for
  // it. Doing so inside the effect below would be a synchronous setState-in-effect — a lint
  // error in this repo (react-hooks/set-state-in-effect) — for a value that was always knowable
  // at render time.
  const supported = hydrated && Boolean(onesignalAppId());
  const [status, setStatus] = useState<NudgeStatus>("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;

    let active = true;
    void readHomeNotificationSettings().then((settings) => {
      if (!active) return;
      // Unable to learn whether this person already has push or already answered the card —
      // say nothing rather than risk nagging someone who is already covered.
      if (!settings) return setStatus("hidden");
      const show = shouldShowPushOptInNudge({
        deviceCount: settings.pushDeviceCount,
        lastDroppedSubscribedAt: settings.pushLastDroppedSubscribedAt,
        modulePreferences: settings.modulePreferences,
      });
      setStatus(show ? "visible" : "hidden");
    });
    return () => {
      active = false;
    };
  }, [supported]);

  function persistDismissal() {
    void fetch("/api/notifications/push/nudge", { method: "POST" }).catch(() => {
      // Best-effort — worst case this same person sees the card once more on a later visit.
    });
  }

  async function enable() {
    setStatus("working");
    setError(null);
    try {
      const result = await requestOneSignalPermission();
      // optIn() resolves regardless of the actual outcome — check the real state before
      // celebrating, exactly like the settings panel does for the same call.
      if (result.optedIn) {
        setStatus("granted");
        persistDismissal();
      } else {
        setStatus("visible");
        setError(
          result.unsupported
            ? pushUnsupportedMessage(result.unsupported)
            : !result.permission
            ? "Your browser didn't grant notification permission. You can try again anytime from Profile → Notification Settings."
            : "Your browser allowed notifications, but couldn't finish registering with the push service. You can try again from Profile → Notification Settings.",
        );
      }
    } catch (enableError) {
      setStatus("visible");
      setError(enableError instanceof Error ? enableError.message : "Unable to enable push notifications right now.");
    }
  }

  function dismiss() {
    setStatus("hidden");
    persistDismissal();
  }

  if (!supported || status === "checking" || status === "hidden") return null;

  return (
    <LandingPanel
      right={
        status === "granted" ? null : (
          // 40px on a phone, where a thumb has to hit it; pulled into the header's padding so the
          // header stays the height of every other panel's on the landing.
          <button
            aria-label="Dismiss"
            className="-my-1.5 inline-flex h-10 w-10 shrink-0 items-center justify-center border border-slate-300 text-slate-500 transition hover:border-[#08111f] hover:text-[#08111f] disabled:opacity-60 sm:h-8 sm:w-8"
            disabled={status === "working"}
            onClick={dismiss}
            type="button"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        )
      }
      title={status === "granted" ? "Push notifications are on for this device" : "Turn on push notifications for this device?"}
    >
      <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4">
        <div aria-live="polite" className="min-w-0">
          <p className="break-words text-phx-sm leading-snug text-slate-600">
            {status === "granted"
              ? "You will get alerts here even when Phoenix isn't open. Manage this anytime in Profile → Notification Settings."
              : "Get alerted for approvals, reminders and updates even when Phoenix isn't open in your browser."}
          </p>
          {error ? <p className="mt-1.5 break-words text-phx-sm font-semibold text-rose-700">{error}</p> : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {status === "granted" ? (
            <button className={landingActionClassName("outline")} onClick={dismiss} type="button">
              Got it
            </button>
          ) : (
            // No ellipsis on the working label, the same as the Telegram card's "Checking".
            <button className={landingActionClassName("solid")} disabled={status === "working"} onClick={enable} type="button">
              <BellRing aria-hidden="true" className="h-3.5 w-3.5" />
              {status === "working" ? "Enabling" : "Turn on"}
            </button>
          )}
        </div>
      </div>
    </LandingPanel>
  );
}
