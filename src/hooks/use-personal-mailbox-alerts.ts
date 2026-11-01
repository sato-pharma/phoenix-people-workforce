"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  newMailAlertText,
  newUnreadSince,
  parseMailAlertBaseline,
  PERSONAL_MAILBOX_CHANGED_EVENT,
  PERSONAL_MAILBOX_POLL_MS,
  PERSONAL_MAILBOX_READ_EVENT,
  type MailAlertBaseline,
} from "@/lib/personal-mailbox/rules";
import type { PersonalMailboxAlertItem, PersonalMailboxInboxStatus } from "@/lib/personal-mailbox/types";

/**
 * The envelope's watch on the person's OWN connected mailbox ("My email"): the unread count for its
 * badge, and a pop-up when new email arrives — plus a desktop notification when Phoenix is not the
 * window in front, the same way the sidebar's approval badges alert (src/lib/nav-badge-store.ts).
 *
 * It asks /api/messages/mailbox/unread, which decides whose mailbox from the session alone and
 * answers repeat asks from a short cache. Someone with no connection is asked about once and then
 * left alone until they connect (the panel fires PERSONAL_MAILBOX_CHANGED_EVENT), and a refused
 * password stops the asking too — nothing here ever retries a password Turbify turned down.
 *
 * Where the person last stood in their inbox (the baseline) lives in their own browser, so a reload
 * or a second tab does not announce the same email twice, and the very first look announces nothing.
 */

const BASELINE_STORAGE_KEY = "phx.personalMailbox.alertBaseline";
const NOTIFICATION_ICON = "/brand/phoenix-notification-icon.png";
/** The first check waits this long after the page loads, so it never competes with the page itself. */
const FIRST_CHECK_DELAY_MS = 3_000;
/** Coming back to the tab re-checks at once when the last check is older than this. */
const RECHECK_ON_RETURN_MS = 60_000;

function readStoredBaseline(): MailAlertBaseline | null {
  try {
    return parseMailAlertBaseline(window.localStorage.getItem(BASELINE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function storeBaseline(baseline: MailAlertBaseline): void {
  try {
    window.localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(baseline));
  } catch {
    /* private window or blocked storage: this tab's memory still holds it */
  }
}

/**
 * Ask once for permission to show desktop notifications. Call it from a click — browsers ignore or
 * silence a permission prompt that no click led to.
 */
export function askForDesktopMailAlerts(): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "default") void Notification.requestPermission();
}

export function usePersonalMailboxAlerts({
  canOpenEmail,
  enabled,
  onOpenEmail,
}: {
  /** Whether "Open" can show the email right now (the envelope is drawn on this page). */
  canOpenEmail: () => boolean;
  /**
   * Whether this person has a mailbox connected, as the shell's render already knows it (1 Nov 2026).
   * `false` asks nothing — no first check, no poll, no re-check on return — until the panel reports
   * a connection (PERSONAL_MAILBOX_CHANGED_EVENT), which arms the check for the rest of the page's
   * life. `true` or `undefined` polls as before. The check used to run on every page view for
   * everyone, five reads deep, only to learn that most people have nothing connected.
   */
  enabled?: boolean;
  onOpenEmail: (uid: number) => void;
}): { unread: number | null } {
  const [unread, setUnread] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  // Armed by the shell (enabled is not false) or by a connection made on this page (the CHANGED event).
  const [armedByPage, setArmedByPage] = useState(false);
  const armed = armedByPage || enabled !== false;
  const callbacks = useRef({ canOpenEmail, onOpenEmail });
  const memoryBaseline = useRef<MailAlertBaseline | null>(null);

  useEffect(() => {
    callbacks.current = { canOpenEmail, onOpenEmail };
  }, [canOpenEmail, onOpenEmail]);

  useEffect(() => {
    const onChanged = () => {
      // A connection made (or dropped) on this page: the next check decides, whatever the shell said.
      setArmedByPage(true);
      setGeneration((current) => current + 1);
    };
    const onRead = () => setUnread((current) => (current !== null && current > 0 ? current - 1 : current));
    window.addEventListener(PERSONAL_MAILBOX_CHANGED_EVENT, onChanged);
    window.addEventListener(PERSONAL_MAILBOX_READ_EVENT, onRead);
    return () => {
      window.removeEventListener(PERSONAL_MAILBOX_CHANGED_EVENT, onChanged);
      window.removeEventListener(PERSONAL_MAILBOX_READ_EVENT, onRead);
    };
  }, []);

  useEffect(() => {
    if (!armed) return;
    let stopped = false;
    let checking = false;
    let lastCheckAt = 0;

    function announce(fresh: PersonalMailboxAlertItem[]) {
      const text = newMailAlertText(fresh);
      if (!text) return;
      const uid = fresh[0].uid;
      const open = () => callbacks.current.onOpenEmail(uid);
      const canOpen = callbacks.current.canOpenEmail();
      toast(text.title, {
        action: canOpen ? { label: "Open", onClick: open } : undefined,
        description: text.body,
        duration: 12_000,
        id: `personal-mail-${uid}`,
      });
      // The pop-up is enough while Phoenix is the window in front; otherwise the desktop is told too.
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      if (document.visibilityState === "visible" && document.hasFocus()) return;
      const notification = new Notification(text.title, { body: text.body, icon: NOTIFICATION_ICON, tag: "phx-personal-mail" });
      notification.onclick = () => {
        window.focus();
        if (canOpen) open();
        notification.close();
      };
    }

    async function check() {
      if (stopped || checking) return;
      checking = true;
      lastCheckAt = Date.now();
      try {
        const response = await fetch("/api/messages/mailbox/unread", { headers: { Accept: "application/json" } });
        if (stopped) return;
        if (response.status === 401) {
          stopped = true;
          setUnread(null);
          return;
        }
        // A busy minute (429) or a server hiccup keeps the last count and asks again later.
        if (!response.ok) return;
        const status = (await response.json()) as PersonalMailboxInboxStatus;
        if (stopped) return;
        if (status.kind === "not_connected" || status.kind === "needs_reconnect") {
          stopped = true;
          setUnread(null);
          return;
        }
        if (status.kind !== "ok") return;
        setUnread(status.unread);
        const { fresh, next } = newUnreadSince(readStoredBaseline() ?? memoryBaseline.current, status);
        memoryBaseline.current = next;
        storeBaseline(next);
        if (fresh.length > 0) announce(fresh);
      } catch {
        /* offline for a moment: the next tick asks again */
      } finally {
        checking = false;
      }
    }

    const firstId = window.setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    const intervalId = window.setInterval(() => void check(), PERSONAL_MAILBOX_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheckAt > RECHECK_ON_RETURN_MS) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(firstId);
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [armed, generation]);

  return { unread };
}
