"use client";

/**
 * Phoenix CRM — what wakes the sending pass, and the real network behind it.
 *
 * Loaded by `visit-outbox-runner.tsx` only once a phone actually holds a visit, so this file and the API client
 * it pulls in reach no page's first bundle for the people who never lose signal on a save.
 *
 * 🔴 NO SERVICE WORKER. The push provider holds that scope, and a second one would fight it. So a visit sends
 * while a Phoenix page is open, which is exactly what the rep is told.
 */

import { crmGet, crmPostWithin, crmUrl } from "@/components/phoenix-crm/api";
import { notifyVisitOutboxChanged, reportVisitResend, VISIT_RESEND_REPORT_PATH } from "@/components/phoenix-crm/visit-outbox-client";
import { browserLocalStorage, VISIT_OUTBOX_CHANGED_EVENT } from "@/lib/browser-storage/owner-scoped";
import { drainVisitOutbox, readQueuedVisits, type OutboxDeps } from "@/lib/phoenix-crm/visit-outbox";
import { VISIT_RESEND_TICK_MS, VISIT_SAVE_TIMEOUT_MS } from "@/lib/phoenix-crm/visit-resend-rules";

type StatusAnswer = { enabled: boolean; savedVisitIds: string[]; serverNow: string };

async function readStatus(visitIds: string[]): Promise<{ enabled: boolean; savedVisitIds: string[]; serverNowMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISIT_SAVE_TIMEOUT_MS);
  try {
    const answer = await crmGet<StatusAnswer>(crmUrl(VISIT_RESEND_REPORT_PATH, { ids: visitIds.join(",") }), "resend", controller.signal);
    const serverNowMs = Date.parse(answer.serverNow);
    // No usable clock proves nothing about 02:00, so nothing is decided on this pass.
    if (Number.isNaN(serverNowMs)) throw new Error("No server clock.");
    return { enabled: answer.enabled, savedVisitIds: answer.savedVisitIds, serverNowMs };
  } finally {
    clearTimeout(timer);
  }
}

export type VisitOutboxEngine = { wake: () => void; stop: () => void };

export function startVisitOutbox(ownerHrId: string): VisitOutboxEngine {
  const storage = browserLocalStorage();
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const deps: OutboxDeps = {
    storage,
    ownerHrId,
    now: () => Date.now(),
    readStatus,
    send: async (body) => {
      const saved = await crmPostWithin<{ duplicate?: boolean }>("/api/phoenix-crm/visits", body, "visit", VISIT_SAVE_TIMEOUT_MS);
      return { duplicate: saved?.duplicate === true };
    },
    report: reportVisitResend,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    changed: notifyVisitOutboxChanged,
  };

  const anythingWaiting = () => readQueuedVisits(storage, ownerHrId).some((entry) => entry.status === "waiting");

  /** The timer lives only while something is waiting, so a settled phone goes back to doing nothing. */
  function arm() {
    if (timer) clearTimeout(timer);
    timer = !stopped && anythingWaiting() ? setTimeout(() => void pass(), VISIT_RESEND_TICK_MS) : null;
  }

  async function pass() {
    if (stopped || running) return;
    // The phone already knows it has no signal: a request would only fail, so it is not made.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      arm();
      return;
    }
    running = true;
    try {
      await drainVisitOutbox(deps);
    } catch (error) {
      console.error("[phoenix-crm] visit outbox pass failed", error);
    } finally {
      running = false;
      arm();
    }
  }

  const wake = () => void pass();
  const onVisible = () => {
    if (document.visibilityState === "visible") wake();
  };

  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener(VISIT_OUTBOX_CHANGED_EVENT, arm);
  wake();

  return {
    wake,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(VISIT_OUTBOX_CHANGED_EVENT, arm);
    },
  };
}
