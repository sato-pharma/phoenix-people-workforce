"use client";

/**
 * Phoenix CRM — THE TOUCH TRAIL's collector.
 *
 * Owner, 2026-10-03: "every click or every touch on the touch screen for this module to be saved in a
 * separate audit trail … even if the rep didn't save it … like a file manager grabber."
 *
 * Mounted once per Phoenix CRM subtree (the rep's `app/employee-portals/field-crm/layout.tsx` and the
 * admin twin), renders nothing, and is the ONLY file in the module that listens to the glass. The
 * rules it obeys — what may be stored, how big a batch is, what a secret field does — live in
 * `src/lib/phoenix-crm/touch-trail.ts`, DOM-free so a test can reach them.
 *
 * 🔴 IT IS INVISIBLE AND IT MUST STAY INVISIBLE (golden rule #1). Nothing is drawn, nothing is
 * delayed, nothing is cancelled: every listener is registered `{capture: true, passive: true}`, so it
 * cannot swallow a rep's tap or hold up a scroll, and every handler swallows its own errors. A rep
 * must never be able to tell this exists — not from a slower screen, not from a console error, and
 * not from a failed save.
 *
 * 🔴 IT NEVER COSTS A REP HIS WORK, INCLUDING WHEN THE SIGNAL DROPS. A failed flush goes into
 * `localStorage` and is retried on the next flush or the next page load, so a rep who works a Delta
 * village with no bars still arrives with his morning intact. Past `MAX_QUEUED_EVENTS` the OLDEST are
 * dropped: a full queue must never grow without limit on his phone.
 *
 * WHAT A BROWSER CANNOT SEE, stated plainly so nobody reads this table as more than it is: taps
 * outside this page (the launcher, another app, the camera's own shutter), individual keyboard keys,
 * and anything at all while the page is closed. Inside the page it sees presses, taps, typing,
 * commits, focus, submits, screen changes, scrolling, and going to and from the background.
 */

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import {
  FLUSH_AT_EVENTS,
  FLUSH_EVERY_MS,
  MAX_EVENTS_PER_BATCH,
  MAX_QUEUED_EVENTS,
  SCROLL_SAMPLE_MS,
  containerLabelOf,
  describeElement,
  labelOf,
  valueForTrail,
  type TouchTrailEvent,
} from "@/lib/phoenix-crm/touch-trail";
import { isOwnedByViewer, normalizeOwnerHrId } from "@/lib/browser-storage/owner-scoped";

const ENDPOINT = "/api/phoenix-crm/touch-trail";
const QUEUE_KEY = "phx-crm-touch-trail";

/**
 * A field's typing is coalesced after this much quiet, and on every commit and focus change.
 *
 * 🔴 THIS IS THE ONE PLACE THE TRAIL IS NOT LITERAL, AND IT IS A DELIBERATE TRADE. A row per
 * keystroke is ~50× the volume for no finding the settled text does not already carry: the abandoned
 * comment — the thing the owner asked for by name — survives in full either way, because what is
 * recorded is the field's CONTENTS at each pause, not the key that was pressed. The timing is still
 * there in the `ms_since_load` gaps between successive rows for the same field.
 */
const TYPE_SETTLE_MS = 800;

/** Controls worth naming as themselves rather than as whatever wrapper caught the event. */
const INTERACTIVE = "button,a,input,select,textarea,label,summary,[role=button],[role=tab],[role=switch],[data-trail]";

/**
 * One held batch. `ownerHrId` is whose hands made it: the route files a batch under the session that
 * POSTS it, so before 2026-10-26 a batch held on a shared tablet was sent — and filed — as the NEXT
 * rep's taps. A held batch is now sent only while its owner is signed in, another owner's is left for
 * them, and one with no owner is dropped (src/lib/browser-storage/owner-scoped.ts).
 */
type Queued = { seatId: string | null; events: TouchTrailEvent[]; ownerHrId?: string };

/** What goes over the wire: the batch as the route has always read it, the owner stays on the phone. */
function wireOf(batch: Queued): { seatId: string | null; events: TouchTrailEvent[] } {
  return { events: batch.events, seatId: batch.seatId };
}

function newSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Fall through to the time-and-random id below.
  }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The territory the screen is serving, read off the path.
 *
 * `/employee-portals/field-crm/day/<seatId>` is the only route that names one. Everywhere else this
 * is null, which the table documents as correct rather than missing — `actor_hr_id`, resolved from
 * the session on the server, is what identifies a row.
 */
function seatOf(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const at = parts.indexOf("day");
  const seat = at >= 0 ? parts[at + 1] : undefined;
  return seat ? decodeURIComponent(seat) : null;
}

/** The module screen, for reading a day without parsing paths: `day`, `plans`, `validation-reviews`. */
function screenOf(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const at = parts.indexOf("field-crm");
  if (at < 0) return parts[parts.length - 1] ?? null;
  return parts[at + 1] ?? "field-crm";
}

function elementOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const owner = target.closest<HTMLElement>(INTERACTIVE);
  return owner ?? (target instanceof HTMLElement ? target : null);
}

/**
 * The words a human would have read on the control.
 *
 * 🔴 A CONTROL LABELS ITSELF; A CONTAINER DOES NOT. Owner, 2026-10-03: "trim the touch trail label to
 * the control, not the whole card." `elementOf` returns the interactive OWNER when there is one, and
 * falls back to the bare element under the finger when there is not — and that fallback's `innerText`
 * is every descendant's text joined. Asking `labelOf` last and capping at 160 was not enough: it
 * recorded 139- and 159-character labels in the first hour of real data, which is a whole card.
 *
 * So the subtree text is read through `containerLabelOf` — its first LINE — unless the element is
 * itself interactive, where `innerText` IS its own words and the 160-char cap is the right one. An
 * authored `aria-label`, `title` or `placeholder` is taken as-is either way: an author who wrote one
 * wrote the label, however long.
 */
function labelFor(element: HTMLElement | null): string | null {
  if (!element) return null;
  const input = element as HTMLInputElement;
  const authored =
    labelOf(element.getAttribute("aria-label")) ??
    labelOf(element.getAttribute("title")) ??
    labelOf(input.placeholder);
  if (authored) return authored;
  // `matches` is guarded because this runs against whatever the page hands it, and a target that is
  // an Element without it would otherwise throw inside a listener that must never throw (rule 2).
  const itself = typeof element.matches === "function" && element.matches(INTERACTIVE);
  const fromText = itself ? labelOf(element.innerText) : containerLabelOf(element.innerText);
  return fromText ?? labelOf(element.getAttribute("name"));
}

function descriptorFor(element: HTMLElement | null): string | null {
  if (!element) return null;
  const input = element as HTMLInputElement;
  return describeElement({
    id: element.id || null,
    name: input.name || null,
    role: element.getAttribute("role"),
    tag: element.tagName,
    trailId: element.dataset?.trail ?? null,
    type: input.type || null,
  });
}

export function PhoenixCrmTouchTrail({ test = false, viewerHrId = null }: { test?: boolean; viewerHrId?: string | null }) {
  const pathname = usePathname();
  // Read by the flush, never a reason to re-register the listeners: one layout mount is one person.
  const viewer = useRef(normalizeOwnerHrId(viewerHrId));
  useEffect(() => {
    viewer.current = normalizeOwnerHrId(viewerHrId);
  }, [viewerHrId]);
  // One page load keeps one id and one clock, across every App Router navigation inside the module:
  // that is what turns a heap of rows back into the sequence a reader replays.
  const session = useRef<string | null>(null);
  if (session.current == null) session.current = newSessionId();
  // The territory follows the route, written in an effect rather than during render: the listeners
  // below read it only when a flush happens, which is always after the render that moved it.
  const seat = useRef<string | null>(null);
  useEffect(() => {
    seat.current = seatOf(pathname ?? "");
  }, [pathname]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Minted during the render above, so the fallback is unreachable and exists only to keep the
    // type honest: a null session id would be dropped server-side, which is the one thing that
    // would silently empty this table.
    const sessionId = session.current ?? newSessionId();
    const startedAt = performance.now();
    let buffer: TouchTrailEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastScrollAt = 0;
    let typing: { element: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;
    let stopped = false;

    // ───────── the queue that survives no signal and a closed tab ─────────

    function readQueue(): Queued[] {
      try {
        const raw = window.localStorage.getItem(QUEUE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        return Array.isArray(parsed) ? (parsed as Queued[]) : [];
      } catch {
        return [];
      }
    }

    function writeQueue(batches: Queued[]): void {
      try {
        // Newest first out of the tail: a phone that has been offline for an hour keeps the recent
        // minutes, which are the ones an investigation is about.
        let kept = batches;
        let total = kept.reduce((sum, batch) => sum + batch.events.length, 0);
        while (total > MAX_QUEUED_EVENTS && kept.length > 1) {
          total -= kept[0].events.length;
          kept = kept.slice(1);
        }
        if (kept.length === 0) window.localStorage.removeItem(QUEUE_KEY);
        else window.localStorage.setItem(QUEUE_KEY, JSON.stringify(kept));
      } catch {
        // A full or blocked store costs the trail, never the rep.
      }
    }

    function hold(batch: Queued): void {
      writeQueue([...readQueue(), batch]);
    }

    // ───────── sending ─────────

    async function post(batch: Queued): Promise<boolean> {
      try {
        const response = await fetch(ENDPOINT, {
          body: JSON.stringify({ ...wireOf(batch), sessionId, test }),
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          method: "POST",
        });
        // A 4xx is the server refusing this shape for good — retrying it forever would be the one way
        // this file could become a cost. Only a network failure or a 5xx is worth holding.
        return response.ok || (response.status >= 400 && response.status < 500);
      } catch {
        return false;
      }
    }

    function flush(reason: "timer" | "full" | "leaving"): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      settleTyping();
      const pending = buffer;
      buffer = [];
      const owner = viewer.current;
      const queued = reason === "leaving" ? [] : readQueue();
      // Only the signed-in person's held batches go out under this session; another person's stay
      // on the phone for them, and an un-owned one is nobody's to send.
      const batches: Queued[] = queued.filter((batch) => isOwnedByViewer(batch.ownerHrId, owner));
      const othersHeld = queued.filter(
        (batch) => normalizeOwnerHrId(batch.ownerHrId) !== "" && !isOwnedByViewer(batch.ownerHrId, owner),
      );
      for (let at = 0; at < pending.length; at += MAX_EVENTS_PER_BATCH) {
        batches.push({
          events: pending.slice(at, at + MAX_EVENTS_PER_BATCH),
          ownerHrId: owner || undefined,
          seatId: seat.current,
        });
      }
      if (batches.length === 0) {
        if (othersHeld.length !== queued.length) writeQueue(othersHeld);
        return;
      }

      if (reason === "leaving") {
        // The page is going away, so there is no promise left to await: `sendBeacon` hands the bytes
        // to the browser, which sends them after this document is gone. What it refuses to take is
        // held for the next load instead of being lost.
        for (const batch of batches) {
          if (!beacon(batch)) hold(batch);
        }
        return;
      }

      writeQueue(othersHeld);
      void (async () => {
        const failed: Queued[] = [];
        for (const batch of batches) {
          if (!(await post(batch))) failed.push(batch);
        }
        if (failed.length > 0) writeQueue([...failed, ...readQueue()]);
      })();
    }

    function beacon(batch: Queued): boolean {
      try {
        if (typeof navigator.sendBeacon !== "function") return false;
        const body = new Blob([JSON.stringify({ ...wireOf(batch), sessionId, test })], { type: "application/json" });
        return navigator.sendBeacon(ENDPOINT, body);
      } catch {
        return false;
      }
    }

    // ───────── recording ─────────

    function record(event: Partial<TouchTrailEvent> & { kind: string }): void {
      if (stopped) return;
      try {
        buffer.push({
          deviceAt: new Date().toISOString(),
          element: null,
          elementLabel: null,
          // No `kind` here on purpose: the parameter requires one and `...event` below always supplies
          // it, so a default would be a fallback that can never apply (TS2783 says so outright).
          msSinceLoad: Math.round(performance.now() - startedAt),
          pointerX: null,
          pointerY: null,
          route: pathname ?? window.location.pathname,
          screen: screenOf(pathname ?? window.location.pathname),
          value: null,
          valueLength: null,
          viewportH: window.innerHeight || null,
          viewportW: window.innerWidth || null,
          ...event,
        });
        if (buffer.length >= FLUSH_AT_EVENTS) flush("full");
        else if (!timer) timer = setTimeout(() => flush("timer"), FLUSH_EVERY_MS);
      } catch {
        // A row that cannot be built is a row that is missing. Never a rep who is stuck.
      }
    }

    function recordPointer(kind: string, nativeEvent: Event): void {
      const pointer = nativeEvent as PointerEvent;
      const element = elementOf(nativeEvent.target);
      record({
        element: descriptorFor(element),
        elementLabel: labelFor(element),
        kind,
        pointerX: Number.isFinite(pointer.clientX) ? Math.round(pointer.clientX) : null,
        pointerY: Number.isFinite(pointer.clientY) ? Math.round(pointer.clientY) : null,
      });
    }

    /** File whatever the field being typed in holds right now, and stop waiting on it. */
    function settleTyping(): void {
      if (!typing) return;
      const { element, timer: pending } = typing;
      typing = null;
      clearTimeout(pending);
      const field = element as HTMLInputElement;
      const { value, valueLength } = valueForTrail(
        { autocomplete: field.autocomplete, name: field.name, type: field.type },
        field.value ?? (element as HTMLElement).textContent,
      );
      record({ element: descriptorFor(element), elementLabel: labelFor(element), kind: "type", value, valueLength });
    }

    // ───────── the listeners ─────────

    const onPointerDown = (nativeEvent: Event) => recordPointer("press", nativeEvent);
    const onClick = (nativeEvent: Event) => recordPointer("tap", nativeEvent);

    const onInput = (nativeEvent: Event) => {
      const element = nativeEvent.target instanceof HTMLElement ? nativeEvent.target : null;
      if (!element) return;
      // A new field settles the one before it, so two fields filled in turn never merge into one row.
      if (typing && typing.element !== element) settleTyping();
      if (typing) clearTimeout(typing.timer);
      typing = { element, timer: setTimeout(settleTyping, TYPE_SETTLE_MS) };
    };

    const onChange = (nativeEvent: Event) => {
      settleTyping();
      const element = elementOf(nativeEvent.target);
      const field = element as HTMLInputElement | null;
      if (!field) return;
      const { value, valueLength } = valueForTrail(
        { autocomplete: field.autocomplete, name: field.name, type: field.type },
        field.type === "checkbox" || field.type === "radio" ? String(field.checked) : field.value,
      );
      record({ element: descriptorFor(element), elementLabel: labelFor(element), kind: "change", value, valueLength });
    };

    const onFocusIn = (nativeEvent: Event) => {
      settleTyping();
      const element = elementOf(nativeEvent.target);
      record({ element: descriptorFor(element), elementLabel: labelFor(element), kind: "focus" });
    };

    const onSubmit = (nativeEvent: Event) => {
      settleTyping();
      const element = elementOf(nativeEvent.target);
      record({ element: descriptorFor(element), elementLabel: labelFor(element), kind: "submit" });
      // A submit is a decision point: file it now rather than up to thirty seconds later, so a crash on the
      // next line still leaves the attempt on the record.
      flush("full");
    };

    const onScroll = () => {
      const now = performance.now();
      if (now - lastScrollAt < SCROLL_SAMPLE_MS) return;
      lastScrollAt = now;
      record({ kind: "scroll", pointerY: Math.round(window.scrollY) || 0 });
    };

    const onVisibility = () => {
      record({ kind: document.visibilityState === "visible" ? "show" : "hide" });
      if (document.visibilityState !== "visible") flush("leaving");
    };

    const onPageHide = () => {
      record({ kind: "hide" });
      flush("leaving");
    };

    const onOnline = () => {
      record({ kind: "online" });
      // Back on the air: push whatever the dead spot held before anything else happens.
      flush("timer");
    };
    const onOffline = () => record({ kind: "offline" });

    const options = { capture: true, passive: true } as const;
    document.addEventListener("pointerdown", onPointerDown, options);
    document.addEventListener("click", onClick, options);
    document.addEventListener("input", onInput, options);
    document.addEventListener("change", onChange, options);
    document.addEventListener("focusin", onFocusIn, options);
    document.addEventListener("submit", onSubmit, options);
    document.addEventListener("scroll", onScroll, options);
    document.addEventListener("visibilitychange", onVisibility, options);
    window.addEventListener("pagehide", onPageHide, options);
    window.addEventListener("online", onOnline, options);
    window.addEventListener("offline", onOffline, options);

    // The screen this load opened on, and the first drain of anything an earlier load held.
    record({ kind: "screen" });
    flush("timer");

    return () => {
      stopped = true;
      document.removeEventListener("pointerdown", onPointerDown, options);
      document.removeEventListener("click", onClick, options);
      document.removeEventListener("input", onInput, options);
      document.removeEventListener("change", onChange, options);
      document.removeEventListener("focusin", onFocusIn, options);
      document.removeEventListener("submit", onSubmit, options);
      document.removeEventListener("scroll", onScroll, options);
      document.removeEventListener("visibilitychange", onVisibility, options);
      window.removeEventListener("pagehide", onPageHide, options);
      window.removeEventListener("online", onOnline, options);
      window.removeEventListener("offline", onOffline, options);
      if (timer) clearTimeout(timer);
      if (typing) clearTimeout(typing.timer);
      // Leaving the module: hand over what is in hand rather than dropping it.
      const pending = buffer;
      buffer = [];
      if (pending.length > 0) hold({ events: pending, seatId: seat.current });
    };
    // `pathname` is read through the closure for `route`, and re-binding every listener on each
    // in-module navigation would restart the session clock. The effect runs once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test]);

  // A route change inside the module is its own row, recorded by the effect below so the one above
  // keeps its single mount.
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    if (lastPath.current === null) {
      lastPath.current = pathname ?? null;
      return;
    }
    if (lastPath.current === pathname) return;
    lastPath.current = pathname ?? null;
    try {
      void fetch(ENDPOINT, {
        body: JSON.stringify({
          events: [
            {
              deviceAt: new Date().toISOString(),
              kind: "screen",
              msSinceLoad: Math.round(performance.now()),
              route: pathname,
              screen: screenOf(pathname ?? ""),
              viewportH: window.innerHeight || null,
              viewportW: window.innerWidth || null,
            },
          ],
          seatId: seatOf(pathname ?? ""),
          sessionId: session.current,
          test,
        }),
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        method: "POST",
      }).catch(() => {
        // Best-effort, like every other path here.
      });
    } catch {
      // Swallow — a screen row is never worth an error a rep could see.
    }
  }, [pathname, test]);

  return null;
}
