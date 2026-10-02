"use client";

/**
 * Phoenix CRM — "Get Phoenix CRM messages on Telegram" (owner, 2026-10-02).
 *
 * The rules — who is asked, when it hides, why it exists — are in src/lib/phoenix-crm/telegram-card.ts.
 * This is the card: one compact square at the top of Phoenix CRM, drawn only when the server says the
 * viewer is offered it and NOT connected (`overview.telegram`), and gone for the rest of the Cairo day
 * once he presses Later.
 *
 * Its button goes into the EXISTING connect flow through the one client helper the Notification
 * Settings panel uses too (src/components/notifications/telegram-connect.ts): a one-time link into the
 * Phoenix bot, opened in a new tab, where he presses START. The link is ALSO drawn as a plain link,
 * because a phone may refuse a tab opened after a network wait — a tap on the link is his own gesture
 * and is never refused. When the page comes back into view, the card asks the settings read once more,
 * and says so the moment he is connected.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { Send } from "lucide-react";

import { CrmButton } from "@/components/phoenix-crm/ui";
import { useHydrated } from "@/hooks/use-hydrated";
import { readTelegramConnectionStatus, requestTelegramConnectLink } from "@/components/notifications/telegram-connect";
import { TELEGRAM_CARD_LATER_KEY, telegramCardLaterToday } from "@/lib/phoenix-crm/telegram-card";

/** Fired in this tab when Later is pressed, so every copy of the card on the page hides at once. */
const LATER_EVENT = "phoenix-crm-telegram-card-later";

/** The day Later was pressed, or null — every read wrapped: a phone that refuses storage shows the card again. */
function readLaterDay(): string | null {
  try {
    return window.localStorage.getItem(TELEGRAM_CARD_LATER_KEY);
  } catch {
    return null;
  }
}

function subscribeLater(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(LATER_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(LATER_EVENT, callback);
  };
}

function noLaterDayOnTheServer(): string | null {
  return null;
}

type CardState =
  /** Asking him to connect. */
  | "ask"
  /** Getting the link. */
  | "opening"
  /** The link is out: he is in Telegram, pressing START. */
  | "finishing"
  /** Reading the settings again after he says he is done. */
  | "checking"
  | "connected";

export function TelegramConnectCard({ cairoToday }: { cairoToday: string }) {
  const hydrated = useHydrated();
  const laterDay = useSyncExternalStore(subscribeLater, readLaterDay, noLaterDayOnTheServer);
  const [state, setState] = useState<CardState>("ask");
  const [link, setLink] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Later hides the card on THIS page even when the browser refuses to remember it.
  const [dismissed, setDismissed] = useState(false);

  // Back from the bot: when the page is in view again while he is finishing, ask once more, quietly.
  useEffect(() => {
    if (state !== "finishing") return;
    let active = true;
    function onBack() {
      if (document.visibilityState !== "visible") return;
      void readTelegramConnectionStatus().then((status) => {
        if (active && status === "connected") setState("connected");
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
    setState("checking");
    setProblem(null);
    const status = await readTelegramConnectionStatus();
    if (status === "connected") {
      setState("connected");
      return;
    }
    setProblem("Not connected yet. Open Telegram, press START in the Phoenix bot, then check again.");
    setState("finishing");
  }

  function later() {
    setDismissed(true);
    try {
      window.localStorage.setItem(TELEGRAM_CARD_LATER_KEY, cairoToday);
      window.dispatchEvent(new Event(LATER_EVENT));
    } catch {
      // Storage refused: hidden on this page, and the card simply shows again on the next one.
    }
  }

  // Nothing until the page is live: the Later day lives in this browser, and the server cannot know it.
  if (!hydrated || dismissed) return null;
  if (state === "ask" && telegramCardLaterToday(laterDay, cairoToday)) return null;

  if (state === "connected") {
    return (
      <div className="flex min-w-0 items-start gap-3 rounded-none border border-emerald-200 bg-emerald-50 px-4 py-3 sm:px-5" role="status">
        <Send aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
        <p className="min-w-0 break-words text-sm font-black text-emerald-900">Telegram is connected. Phoenix CRM messages will reach you there.</p>
      </div>
    );
  }

  const finishing = state === "finishing" || state === "checking";
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-none border border-l-[3px] border-orange-200 border-l-orange-500 bg-orange-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex min-w-0 items-start gap-3">
        <Send aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
        <div className="min-w-0">
          <p className="break-words text-sm font-black text-slate-950">
            {finishing ? "Finish in Telegram" : "Get Phoenix CRM messages on Telegram"}
          </p>
          <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-600">
            {finishing
              ? "Press START in the Phoenix bot, then come back here."
              : "Plans, requests and reminders reach your phone the moment they happen."}
          </p>
          {problem ? <p className="mt-1 break-words text-xs font-bold leading-5 text-rose-700">{problem}</p> : null}
        </div>
      </div>
      <div className="flex min-w-0 shrink-0 flex-wrap gap-2">
        {finishing ? (
          <>
            {link ? (
              <a
                className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-none border border-orange-600 bg-orange-600 px-3 py-1.5 text-center text-xs font-black text-white transition hover:bg-orange-700 md:min-h-9"
                href={link}
                rel="noopener noreferrer"
                target="_blank"
              >
                Open Telegram
              </a>
            ) : null}
            <CrmButton busy={state === "checking"} onClick={() => void checkAgain()} size="sm">
              I pressed START
            </CrmButton>
            {/* A link lives 15 minutes and is used once: a fresh one, through the same flow. */}
            <CrmButton disabled={state === "checking"} onClick={() => void connect()} size="sm" variant="ghost">
              New link
            </CrmButton>
          </>
        ) : (
          <>
            <CrmButton busy={state === "opening"} onClick={() => void connect()} size="sm" variant="primary">
              Connect Telegram
            </CrmButton>
            <CrmButton disabled={state === "opening"} onClick={later} size="sm">
              Later
            </CrmButton>
          </>
        )}
      </div>
    </div>
  );
}
