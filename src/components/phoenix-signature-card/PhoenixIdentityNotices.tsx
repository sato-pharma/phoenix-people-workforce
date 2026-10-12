"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * THE WIRE — the notice centre under the identity bar, rebuilt from nothing on 2026-10-12.
 *
 * 🔴 WHY IT WAS REBUILT, IN HIS WORDS. The first version put the three newest notices in three white
 * boxes with hairline borders. The owner's verdict, with this band and the day panel under it in one
 * screenshot: "the place where I screenshot to you is a fucking oven. It needs to be burned out and
 * re-created from scratch a premium polished ... I want this account to be the fucking best of the
 * world." In the same breath he ruled the identity bar and the portrait FINISHED — "do not touch, do
 * not ever touch. They're perfect right now" — so the bar above this band and the standing portrait
 * beside it are untouched by this file and must stay that way.
 *
 * WHAT WAS ACTUALLY WRONG WITH IT, because "premium" is not a colour. Three boxes, each holding one
 * short line, in a band measured at 545px wide: two were visible and the third was revealed only at
 * `xl`, so at the width this page is most often read the band was two squat boxes and a hole. A box
 * whose content fills a fifth of it reads as something that failed to load. The answer was not a
 * nicer box — it was to stop using boxes for a list of three one-line facts.
 *
 * SO IT IS A RULED LEDGER NOW, AND THE LEDGER IS WHAT READS AS CRAFT. Every notice is a row the full
 * width of the band: the state in the left margin, the title in ink, the module and the Cairo stamp
 * right-aligned against a hairline. Rows use the width instead of fighting it, all three are visible
 * at every size, and the right edge lines up — which is the whole difference between a ledger and
 * three cards.
 *
 * IT CONTINUES THE BAR'S OWN INK, WHICH IS WHY IT BELONGS TO THE LETTERHEAD ABOVE IT. The identity
 * bar ends in a wave filled #231e18 under an #f47b20 stroke. This band opens with a flat rail in
 * that same ink carrying that same orange, so the eye reads one document continuing rather than a
 * widget parked under a banner. Every hairline here is warm (#e6e0d6), never slate: a cool grey
 * hairline against cream paper is exactly the mismatch that made the old band look cheap.
 *
 * 🔴 HEIGHT IS STILL THE CONSTRAINT AND IT IS STILL MET — MEASURED, NOT ESTIMATED. The portrait
 * reserves the air this band sits in; outgrowing it pushes the whole dashboard down the page, which
 * is the one thing the identity strip exists to prevent. On the branch with three notices loaded:
 * 120px band against a 120px reserve at 803px, 143px against a 143px reserve at 1440px — the ledger
 * fills the overhang exactly and adds NO page height, against 121px for the two-tile grid it
 * replaced. The row padding is what buys that: at `py-[7px]` the same three rows measured 136px and
 * pushed the page down 16px, so `py-[5px]` and `pt-2` are pinned in
 * `tests/identity-strip-emblem.test.ts` and are the first numbers to re-measure if a row grows.
 *
 * ── The three facts that are NOT style, and must survive any future restyle ──
 *
 * IT IS THE BELL'S OWN ROWS, NOT A SECOND SOURCE. It reads `/api/notifications/in-app`, the exact
 * endpoint `InAppNotificationsBell` reads, so what the band shows and what the bell shows can never
 * disagree and no fence is re-implemented here: that route resolves the viewer server-side and
 * `listInAppNotificationsForViewer` applies the personal-bell allowlist and the test-login fence. A
 * second query against `notification_events` would be a second place to get those wrong.
 *
 * A FAILURE SAYS SO AND NEVER DRAWS ZERO. "Nothing waiting" and "could not load" are different
 * facts, and a band that renders the first when it means the second is the misleading-zero failure
 * AGENTS.md §7 names. Loading is its own state too — quiet placeholder rules, no numbers.
 *
 * READING A NOTICE MARKS IT READ, the same `PATCH { id }` the bell sends, fired before the
 * navigation and deliberately not awaited: the row the person is opening is the proof they read it,
 * and a failed PATCH must not hold up the page. The badge count is corrected locally at the same
 * moment so the band agrees with itself without a refetch.
 */

type NoticeView = {
  href: string | null;
  id: string;
  isRead?: boolean;
  message: string;
  module?: string | null;
  priority?: string;
  sentAt: string | null;
  title: string;
};

type BandState =
  | { notices: NoticeView[]; status: "ready" }
  | { status: "error" }
  | { status: "loading" };

/**
 * THE LETTERHEAD'S OWN PALETTE, not the slate one. Every value is taken from
 * `PhoenixIdentityStrip` or mixed from its paper, so the band and the bar are one surface: #231e18
 * is the closing wave's fill, #f47b20 is its stroke and the brand's orange, and the hairlines are
 * warm greys off the #fdf8f3 paper rather than Tailwind's cool `slate-200`.
 */
const INK = "#231e18";
const ORANGE = "#f47b20";
const RULE = "#e6e0d6";
const PAPER = "#fdfaf6";
const MUTED = "#8a7a66";
const FAINT = "#a8907a";

/** Cairo wall-clock, whatever zone the device is on — the same formatter the bell uses. */
const noticeTime = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

const MODULE_ACRONYMS = new Set(["crm", "hr", "kpi", "roi", "sos"]);

/** `phoenix_crm` -> "Phoenix CRM". A code is not a name (owner's standing rule). */
function moduleLabel(code: string) {
  return code
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) =>
      MODULE_ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

function stampOf(notice: NoticeView) {
  if (!notice.sentAt) return "";
  const date = new Date(notice.sentAt);
  return Number.isNaN(date.getTime()) ? "" : noticeTime.format(date);
}

/** Unread first, each half newest-first, then the first three. */
function orderNotices(notices: NoticeView[]) {
  const byRecency = (a: NoticeView, b: NoticeView) =>
    new Date(b.sentAt ?? 0).getTime() - new Date(a.sentAt ?? 0).getTime();
  const unread = notices.filter((notice) => !notice.isRead).sort(byRecency);
  const read = notices.filter((notice) => notice.isRead).sort(byRecency);
  return [...unread, ...read].slice(0, 3);
}

/**
 * HOW MANY ROWS THE BAND SHOWS IS NO LONGER A WIDTH QUESTION, AND THAT IS THE POINT OF THE REBUILD.
 * The old grid revealed its second tile at `sm` and its third only at `xl`, because three tiles side
 * by side in a 545px band wrapped every title onto three lines. A row is the full width of the band
 * at every size, so all three are visible at 375px, at 803px and at 1440px — the band stopped having
 * a width at which it under-reports itself.
 */
const NOTICE_ROWS = 3;

/** The marker. A rotated square, because the admin shell zeroes every radius (globals RULE 1). */
function Diamond({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-[6px] w-[6px] shrink-0 rotate-45"
      style={{ background: color }}
    />
  );
}

function NoticeRow({ notice, onOpen }: { notice: NoticeView; onOpen: (id: string) => void }) {
  const stamp = stampOf(notice);
  const unread = !notice.isRead;

  const body = (
    <>
      {/* THE STATE LIVES IN THE MARGIN, NOT IN A FILL. An unread row is marked by a solid orange
          diamond and a 2px orange edge; a read one keeps the same geometry in warm grey, so both
          sit on one grid and the band never looks like two different lists. Nothing is tinted: a
          filled pastel row is precisely what the house ink rule refuses. */}
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-0 top-0 w-[2px]"
        style={{ background: unread ? ORANGE : "transparent" }}
      />
      <Diamond color={unread ? ORANGE : "#d8cfc2"} />
      <span
        className="min-w-0 flex-1 break-words text-[12.5px] leading-snug"
        style={{ color: unread ? INK : MUTED, fontWeight: unread ? 800 : 600 }}
      >
        {notice.title}
      </span>
      <span className="flex shrink-0 items-center gap-2.5 pl-1">
        {notice.module ? (
          <span
            className="hidden whitespace-nowrap text-[9px] font-black uppercase tracking-[0.18em] sm:inline"
            style={{ color: FAINT }}
          >
            {moduleLabel(notice.module)}
          </span>
        ) : null}
        {stamp ? (
          <span
            className="whitespace-nowrap text-[9.5px] font-bold uppercase tracking-[0.1em] tabular-nums"
            style={{ color: FAINT }}
          >
            {stamp}
          </span>
        ) : null}
        <ArrowUpRight
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          style={{ color: ORANGE }}
        />
      </span>
    </>
  );

  const shell =
    "group relative flex w-full items-center gap-2.5 py-[5px] pl-3 pr-2 text-left transition-colors"
    + " duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset"
    + " focus-visible:ring-orange-500";

  return (
    <li className="border-t" style={{ borderColor: RULE }}>
      {notice.href ? (
        <Link className={`${shell} hover:bg-[#fdfaf6]`} href={notice.href} onClick={() => onOpen(notice.id)}>
          {body}
        </Link>
      ) : (
        <div className={shell}>{body}</div>
      )}
    </li>
  );
}

export function PhoenixIdentityNotices({ className = "" }: { className?: string }) {
  const [state, setState] = useState<BandState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/notifications/in-app", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`notice band: HTTP ${response.status}`);
        const payload: unknown = await response.json();
        const rows = (payload as { data?: unknown })?.data;
        return Array.isArray(rows) ? (rows as NoticeView[]) : [];
      })
      .then((notices) => {
        if (!cancelled) setState({ notices, status: "ready" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fire-and-forget, exactly as the bell does it — see the header.
  const markRead = (id: string) => {
    setState((previous) =>
      previous.status === "ready"
        ? {
            notices: previous.notices.map((notice) =>
              notice.id === id ? { ...notice, isRead: true } : notice,
            ),
            status: "ready",
          }
        : previous,
    );
    void fetch("/api/notifications/in-app", {
      body: JSON.stringify({ id }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    }).catch(() => {});
  };

  const notices = state.status === "ready" ? orderNotices(state.notices).slice(0, NOTICE_ROWS) : [];
  const unreadCount =
    state.status === "ready" ? state.notices.filter((notice) => !notice.isRead).length : 0;

  return (
    <section
      aria-label="Notification centre"
      className={["flex min-w-0 flex-col pt-2", className].join(" ")}
    >
      {/* THE RAIL. Flat ink under a 2px orange edge, continuing the wave the identity bar ends in.
          The unread count is the one live number on the band, so it takes the orange and nothing
          else on the rail competes with it. */}
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-[5px]"
        style={{ background: INK, boxShadow: `inset 0 -2px 0 0 ${ORANGE}` }}
      >
        <Diamond color={ORANGE} />
        <h2 className="whitespace-nowrap text-[9.5px] font-black uppercase tracking-[0.22em] text-[#f5efe6]">
          Notification centre
        </h2>
        {state.status === "ready" ? (
          <span className="ml-auto flex shrink-0 items-baseline gap-1.5">
            <span
              className="text-[12px] font-black leading-none tabular-nums"
              style={{ color: unreadCount === 0 ? "#8d8378" : ORANGE }}
            >
              {unreadCount}
            </span>
            <span className="whitespace-nowrap text-[9px] font-black uppercase tracking-[0.18em] text-[#9a9087]">
              unread
            </span>
          </span>
        ) : null}
      </div>

      {state.status === "loading" ? (
        // THE SKELETON IS THE SAME LEDGER, NOT A GREY BOX. Same rules, same margin, same diamond —
        // only the type is absent. A placeholder that does not share the loaded layout reads as a
        // fault rather than as a wait, which is the whole reason the loading state is drawn at all.
        <ul aria-hidden="true" className="flex flex-col border-b" style={{ borderColor: RULE }}>
          {Array.from({ length: NOTICE_ROWS }, (_, slot) => (
            <li
              className="flex items-center gap-2.5 border-t px-3 py-[5px]"
              key={slot}
              style={{ background: PAPER, borderColor: RULE }}
            >
              <Diamond color="#e2dacd" />
              <span
                className="block h-[9px] flex-1"
                style={{ background: "#efe9e0", maxWidth: `${62 - slot * 11}%` }}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {state.status === "error" ? (
        <p
          className="border-t px-3 py-2.5 text-[11.5px] font-semibold leading-5"
          style={{ background: PAPER, borderColor: RULE, color: "#8a5a1f" }}
        >
          Your notices could not be loaded just now, so this band is showing none rather than a count
          it cannot stand behind. The bell in the top bar reads the same list.
        </p>
      ) : null}

      {state.status === "ready" && notices.length === 0 ? (
        <p
          className="border-t px-3 py-2.5 text-[11.5px] font-semibold leading-5"
          style={{ background: PAPER, borderColor: RULE, color: MUTED }}
        >
          Nothing is waiting for you here. New notices land in this band and in the bell at the same
          moment.
        </p>
      ) : null}

      {notices.length > 0 ? (
        // The closing rule matters: without it the last row dissolves into the page ground and the
        // ledger has a top and no bottom, which is the one thing that makes a ruled list look
        // unfinished rather than deliberate.
        <ul className="flex flex-col border-b bg-white" style={{ borderColor: RULE }}>
          {notices.map((notice) => (
            <NoticeRow key={notice.id} notice={notice} onOpen={markRead} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
