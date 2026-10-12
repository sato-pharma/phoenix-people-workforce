"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * THE NOTICE BAND — what fills the air the standing portrait opened under the identity strip.
 *
 * The owner, 2026-10-12, with the empty band circled in red: "the market space donot leave it like
 * this make use of it for example for a notification center or any other idea workable". The
 * reversed-L portrait hangs below the bar, so the page already reserves a band the width of the
 * screen minus the portrait — and it was reserved air with nothing in it.
 *
 * IT IS THE BELL'S OWN ROWS, NOT A SECOND SOURCE. It reads `/api/notifications/in-app`, which is the
 * exact endpoint `InAppNotificationsBell` reads, so what the band shows and what the bell shows can
 * never disagree and no fence is re-implemented here: that route resolves the viewer server-side and
 * `listInAppNotificationsForViewer` applies the personal-bell allowlist and the test-login fence. A
 * second query against `notification_events` would have been a second place to get those wrong.
 *
 * THE NEWEST THREE UNREAD, THEN THE NEWEST READ TO FILL THE ROW. Unread is the point of the band;
 * padding it out with read rows is what keeps a three-column grid from collapsing to one tile and
 * reading as broken. The count in the header is the UNREAD count and only ever that.
 *
 * A FAILURE SAYS SO AND NEVER DRAWS ZERO. "Nothing waiting" and "could not load" are different
 * facts, and a band that renders the first when it means the second is the misleading-zero failure
 * AGENTS.md §7 names. Loading is its own state too — three quiet placeholder tiles, no numbers.
 *
 * READING A NOTICE MARKS IT READ, same `PATCH { id }` the bell sends, fired before the navigation
 * and deliberately not awaited: the row the person is opening is the proof they read it, and a
 * failed PATCH must not hold up the page. The badge count is corrected locally at the same moment
 * so the band agrees with itself without a refetch.
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
 * HOW MANY TILES FIT IS A WIDTH QUESTION, AND IT IS ANSWERED IN CSS. The band is as wide as the page
 * minus the standing portrait, so at 803px three tiles are 175px each and every title wraps to three
 * lines — measured: the band came to 157px against the 120px the portrait reserves. Two tiles at the
 * same width are 267px and the band fits inside its own reserve. So the third tile exists in the
 * markup and is revealed at `xl`, where there is room for it, and the phone shows one: a column of
 * three stacked tiles is exactly the page-space the strip exists to protect.
 *
 * THE COUNT IN THE HEADER IS NOT AFFECTED BY THIS. It says how many are unread, not how many are
 * drawn — otherwise the band would under-report at the width it is most often read on.
 */
const TILE_REVEAL = ["flex", "hidden sm:flex", "hidden xl:flex"];

function NoticeTile({
  notice,
  onOpen,
  reveal,
}: {
  notice: NoticeView;
  onOpen: (id: string) => void;
  reveal: string;
}) {
  const stamp = stampOf(notice);
  const unread = !notice.isRead;
  const body = (
    <>
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-0 top-0 w-[3px]"
        style={{ background: unread ? "#f47b20" : "#d8cfc2" }}
      />
      {/* THE TITLE CARRIES THE TILE AND THE BODY DOES NOT APPEAR HERE, WHICH IS A HEIGHT DECISION
          AND NOT AN OVERSIGHT. These messages are paragraphs — the recruitment digest alone runs to
          a bulleted list of roles and arrival channels — and with the body in, the band measured
          326px against the 120px the portrait reserves, which pushes the dashboard down the page
          and undoes the one thing the strip exists to protect. Clipping it is not the alternative
          either: an ellipsis is banned outright (owner's standing rule) and a fixed-height clip
          cuts a sentence mid-word. So the tile shows what a notice IS, and opening it shows what it
          SAYS — the bell's panel is one click away and renders the body in full. */}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="break-words text-[12.5px] font-black leading-snug text-slate-900">
          {notice.title}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
        {notice.module ? (
          <span className="whitespace-nowrap text-[9.5px] font-black uppercase tracking-[0.12em] text-slate-400">
            {moduleLabel(notice.module)}
          </span>
        ) : null}
        {stamp ? (
          <span className="whitespace-nowrap text-[9.5px] font-bold uppercase tracking-[0.1em] text-slate-400">
            {stamp}
          </span>
        ) : null}
        {notice.href ? (
          <ArrowUpRight
            aria-hidden="true"
            className="ml-auto h-3.5 w-3.5 shrink-0 text-orange-400 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          />
        ) : null}
      </span>
    </>
  );

  const shell =
    `group relative ${reveal} min-w-0 flex-col gap-1.5 border border-slate-200/70 bg-white py-3 pl-4 pr-3 text-left`
    + " transition-colors duration-150 hover:bg-slate-50/80 focus-visible:outline-none focus-visible:ring-2"
    + " focus-visible:ring-inset focus-visible:ring-orange-500";

  if (!notice.href) {
    return <div className={shell}>{body}</div>;
  }
  return (
    <Link className={shell} href={notice.href} onClick={() => onOpen(notice.id)}>
      {body}
    </Link>
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

  const notices = state.status === "ready" ? orderNotices(state.notices) : [];
  const unreadCount =
    state.status === "ready" ? state.notices.filter((notice) => !notice.isRead).length : 0;

  return (
    <section
      aria-label="Notification centre"
      className={["flex min-w-0 flex-col gap-2.5 pt-3", className].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0"
          style={{
            background: unreadCount > 0 ? "#f47b20" : "#cbd5e1",
            boxShadow: unreadCount > 0 ? "0 0 8px rgba(244,123,32,0.55)" : "none",
          }}
        />
        <h2 className="whitespace-nowrap text-[11px] font-black uppercase tracking-[0.16em] text-slate-950">
          Notification centre
        </h2>
        {state.status === "ready" ? (
          <span
            className={[
              "whitespace-nowrap text-[10px] font-black uppercase tracking-[0.12em]",
              // A live count carries the band's weight; "nothing unread" is a calm fact and reads
              // in the muted grey the sibling panels use for their own quiet states.
              unreadCount === 0 ? "text-slate-400" : "text-orange-600",
            ].join(" ")}
          >
            {unreadCount === 0 ? "Nothing unread" : `${unreadCount} unread`}
          </span>
        ) : null}
      </div>

      {state.status === "loading" ? (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((slot) => (
            <div
              aria-hidden="true"
              className={`h-[72px] border border-slate-200/70 bg-slate-50/60 ${TILE_REVEAL[slot]}`}
              key={slot}
            />
          ))}
        </div>
      ) : null}

      {state.status === "error" ? (
        <p className="border border-amber-300/70 bg-amber-50/70 px-4 py-3 text-[12px] font-bold leading-5 text-amber-800">
          Your notices could not be loaded just now, so this band is showing none rather than a
          count it cannot stand behind. The bell in the top bar reads the same list.
        </p>
      ) : null}

      {state.status === "ready" && notices.length === 0 ? (
        <p className="border border-slate-200/70 bg-white px-4 py-3 text-[12px] font-bold leading-5 text-slate-500">
          Nothing is waiting for you here. New notices land in this band and in the bell at the same
          moment.
        </p>
      ) : null}

      {notices.length > 0 ? (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {notices.map((notice, index) => (
            <NoticeTile
              key={notice.id}
              notice={notice}
              onOpen={markRead}
              reveal={TILE_REVEAL[index] ?? "flex"}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
