"use client";

/**
 * The home page's "Connect Telegram" card (owner, 13 Nov 2026: "Every home page, once").
 *
 * The rules — who is asked, and why only once — are in src/lib/notifications/telegram-home-card-rules.ts.
 * This is the card. It sits beside the push card and wears its look, draws nothing until the server has
 * said this person is asked, and is never a step: nothing waits on it.
 *
 * THE LOOK (owner, 2026-11-20 landing redesign): the landing kit's white panel, not an orange block.
 * The tick title says where the person stands, one line under it in the body says what Telegram gives
 * them, and the buttons are the kit's navy outline and solid shapes. Close sits in the header's right
 * slot. Orange is only the tick.
 *
 * Its button goes into the EXISTING connect flow, through the one client helper every screen uses
 * (telegram-connect.ts): a one-time link into the Phoenix bot, where the person presses START. The link
 * is also drawn as a plain link, because a phone may refuse a tab opened after a network wait, and a
 * tap on a link is the person's own gesture. When the page comes back into view the card asks the
 * settings once more, and says so the moment the person is connected.
 *
 * ONCE. Closing the card, or connecting through it, writes the answer through
 * POST /api/notifications/telegram/home-card, and the card is never drawn for that person again.
 */

import { useEffect, useState } from "react";
import { Send, X } from "lucide-react";

import { LandingPanel, landingActionClassName } from "@/components/employee-portal/landing-kit";
import { readHomeNotificationSettings } from "@/components/notifications/home-notification-settings";
import { readTelegramConnectionStatus, requestTelegramConnectLink } from "@/components/notifications/telegram-connect";
import { useHydrated } from "@/hooks/use-hydrated";

type CardState =
  | "checking"
  | "hidden"
  /** Asking the person to connect. */
  | "ask"
  /** Getting the link. */
  | "opening"
  /** The link is out: the person is in Telegram, pressing START. */
  | "finishing"
  /** Reading the settings again after the person says it is done. */
  | "confirming"
  | "connected";

/**
 * The kit's button shape (LandingCta) for an action that is a button, not a link — the kit draws its
 * call to action as a <Link>. Same frame, same type, 40px on a phone.
 */

/** Writes the answer. Best effort: at worst this person sees the card once more on a later visit. */
function recordAnswer() {
  void fetch("/api/notifications/telegram/home-card", { method: "POST" }).catch(() => undefined);
}

export function TelegramHomeCard() {
  const hydrated = useHydrated();
  const [state, setState] = useState<CardState>("checking");
  const [link, setLink] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    void readHomeNotificationSettings().then((settings) => {
      // Unable to learn whether this person is asked: draw nothing, never ask somebody already connected.
      if (active) setState(settings?.telegramCard ? "ask" : "hidden");
    });
    return () => {
      active = false;
    };
  }, [hydrated]);

  // Back from the bot: when the page is in view again while the person is finishing, ask once more, quietly.
  useEffect(() => {
    if (state !== "finishing") return;
    let active = true;
    function onBack() {
      if (document.visibilityState !== "visible") return;
      void readTelegramConnectionStatus().then((status) => {
        if (!active || status !== "connected") return;
        setState("connected");
        recordAnswer();
      });
    }
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
    };
  }, [state]);

  async function connect() {
    setState("opening");
    setProblem(null);
    try {
      const next = await requestTelegramConnectLink();
      if (!next.link) throw new Error("Telegram did not give a link. Try again in a moment.");
      setLink(next.link);
      window.open(next.link, "_blank", "noopener,noreferrer");
      setState("finishing");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Unable to create Telegram link.");
      setState("ask");
    }
  }

  async function checkAgain() {
    setState("confirming");
    setProblem(null);
    const status = await readTelegramConnectionStatus();
    if (status === "connected") {
      setState("connected");
      recordAnswer();
      return;
    }
    setProblem("Not connected yet. Open Telegram, press START in the Phoenix bot, then check again.");
    setState("finishing");
  }

  function close() {
    setState("hidden");
    recordAnswer();
  }

  if (!hydrated || state === "checking" || state === "hidden") return null;

  const finishing = state === "finishing" || state === "confirming";
  const busy = state === "opening" || state === "confirming";

  return (
    <LandingPanel
      right={
        state === "connected" ? null : (
          // 40px on a phone, where a thumb has to hit it; pulled into the header's padding so the
          // header stays the height of every other panel's on the landing.
          <button
            aria-label="Close"
            className="-my-1.5 inline-flex h-10 w-10 shrink-0 items-center justify-center border border-slate-300 text-slate-500 transition hover:border-[#08111f] hover:text-[#08111f] disabled:opacity-60 sm:h-8 sm:w-8"
            disabled={busy}
            onClick={close}
            type="button"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        )
      }
      title={state === "connected" ? "Telegram is connected" : finishing ? "Finish in Telegram" : "Get Phoenix messages on Telegram?"}
    >
      <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4">
        <div aria-live="polite" className="min-w-0">
          <p className="break-words text-phx-sm leading-snug text-slate-600">
            {state === "connected"
              ? "Approvals, reminders and updates will reach you there. Manage this anytime in Profile → Notification Settings."
              : finishing
                ? "Press START in the Phoenix bot, then come back here."
                : "Approvals, reminders and updates reach your phone the moment they happen."}
          </p>
          {problem ? <p className="mt-1.5 break-words text-phx-sm font-semibold text-rose-700">{problem}</p> : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {state === "connected" ? (
            <button className={landingActionClassName("outline")} onClick={() => setState("hidden")} type="button">
              Got it
            </button>
          ) : finishing ? (
            <>
              {link ? (
                <a className={landingActionClassName("solid")} href={link} rel="noopener noreferrer" target="_blank">
                  <Send aria-hidden="true" className="h-3.5 w-3.5" />
                  Open Telegram
                </a>
              ) : null}
              <button className={landingActionClassName("outline")} disabled={busy} onClick={() => void checkAgain()} type="button">
                {state === "confirming" ? "Checking" : "I pressed START"}
              </button>
              {/* A link lives 15 minutes and is used once: a fresh one, through the same flow. */}
              <button className={landingActionClassName("outline")} disabled={busy} onClick={() => void connect()} type="button">
                New link
              </button>
            </>
          ) : (
            <button className={landingActionClassName("solid")} disabled={busy} onClick={() => void connect()} type="button">
              <Send aria-hidden="true" className="h-3.5 w-3.5" />
              {state === "opening" ? "Opening Telegram" : "Connect Telegram"}
            </button>
          )}
        </div>
      </div>
    </LandingPanel>
  );
}
