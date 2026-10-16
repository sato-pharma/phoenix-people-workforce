"use client";

import { ArrowUpRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";

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
 * ── THEN HE TOOK THE BAND PARTITION BY PARTITION, AND THIS IS THE SECOND INSTRUCTION ──
 *
 * 🔴 ONE BLOCK PER KIND, AND PRESSING IT DROPS THE LIST (owner, 2026-10-12, looking at the ledger's
 * three rows: "the first partition, which is the new CV received, the new WhatsApp message, the four
 * CVs received today. We can make it this as one block. And when I press on this block, a drop list
 * appears ... make it look like the number of CVs received today. I press on it, I get the
 * resources."). He was reading a real repetition, not a layout quirk: measured on production the
 * same day, `New CV received` had fired 9 times that Cairo day and 97 times in seven, and
 * `New WhatsApp message — no CV attached` 8 and 53 — every one of them carrying the SAME subject,
 * because the sender and the preview live in the message body, not the title. A ledger of three rows
 * was therefore spending the band on three near-identical lines. So notices of one kind now collapse
 * into one block that carries the count, and the block opens into its own members — the senders, each
 * with its own Cairo stamp and its own link. That is what he meant by "the resources".
 *
 * 🔴 WHAT THE FIGURE ON A BLOCK MEANS, EXACTLY, AND WHY IT IS NOT "TODAY". The band reads the bell's
 * endpoint, which serves the newest 20 notices and nothing more (`listInAppNotificationsForViewer`
 * clamps its own limit to 20). So the only honest reading of the figure is "this many of this kind
 * are in the band", and the block says `today` beside it ONLY when every member really does fall on
 * the current Cairo day AND the payload came back under the cap — because at the cap a count of 4 may
 * be 9 in truth. Recruitment already ships a real daily digest titled `4 CVs arrived today`, fired at
 * 15:04 Cairo, so a block inventing its own day total would not merely be vague — it would contradict
 * a notice sitting in the same band. The member list is the proof of the figure: it shows every row
 * the block counted, which is why the count and the drop list can never drift apart.
 *
 * A SINGLE NOTICE IS STILL A SINGLE ROW. A kind with one member renders as the plain ledger row it
 * always was — a link straight to the thing. Wrapping one notice in a disclosure would cost a press
 * to reveal what the row already said.
 *
 * ── The four facts that are NOT style, and must survive any future restyle ──
 *
 * 🔴 HEIGHT IS STILL THE CONSTRAINT AND IT IS STILL MET — MEASURED, NOT ESTIMATED. The portrait
 * reserves the air this band sits in; outgrowing it pushes the whole dashboard down the page, which
 * is the one thing the identity strip exists to prevent. On the branch with three notices loaded:
 * 120px band against a 120px reserve at 803px, 143px against a 143px reserve at 1440px — the ledger
 * fills the overhang exactly and adds NO page height, against 121px for the two-tile grid it
 * replaced. The row padding is what buys that: at `py-[7px]` the same three rows measured 136px and
 * pushed the page down 16px, so `py-[5px]` and `pt-2` are pinned in
 * `tests/identity-strip-emblem.test.ts` and are the first numbers to re-measure if a row grows.
 * Collapsed is the state that must fit, and three blocks collapsed are three rows — the same height
 * as before the grouping. An open block grows the band because he pressed it, and its list is capped
 * at a scrollable height so one busy kind cannot push the dashboard off the screen. Since 2026-10-13
 * the SHUT band draws those same three rows inside the reserve and nowhere else: it is absolutely
 * positioned over the reserved air, so it cannot add height even if a row ever grew — it would be
 * clipped instead, and a clipped row is a visible fault where a pushed dashboard is a silent one.
 *
 * IT IS THE BELL'S OWN ROWS, NOT A SECOND SOURCE. It reads `/api/notifications/in-app`, the exact
 * endpoint `InAppNotificationsBell` reads, so what the band shows and what the bell shows can never
 * disagree and no fence is re-implemented here: that route resolves the viewer server-side and
 * `listInAppNotificationsForViewer` applies the personal-bell allowlist and the test-login fence. A
 * second query against `notification_events` would be a second place to get those wrong. The band
 * asks it for the 20 it is willing to serve rather than its default 8, because a count over 8 would
 * under-report a kind the owner can see repeating.
 *
 * A FAILURE SAYS SO AND NEVER DRAWS ZERO. "Nothing waiting" and "could not load" are different
 * facts, and a band that renders the first when it means the second is the misleading-zero failure
 * AGENTS.md §7 names. Loading is its own state too — quiet placeholder rules, no numbers.
 *
 * READING A NOTICE MARKS IT READ, the same `PATCH { id }` the bell sends, fired before the
 * navigation and deliberately not awaited: the row the person is opening is the proof they read it,
 * and a failed PATCH must not hold up the page. The badge count is corrected locally at the same
 * moment so the band agrees with itself without a refetch. Opening a BLOCK marks nothing — pressing
 * a disclosure is not reading nine CVs.
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

/** One kind of notice — the title it arrived under, with every arrival that carried it. */
type NoticeKind = {
  allToday: boolean;
  key: string;
  members: NoticeView[];
  module?: string | null;
  newestAt: string | null;
  title: string;
  unread: number;
};

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

/** `en-CA` is the one locale that formats a date as YYYY-MM-DD, which is all this comparison needs. */
const cairoDay = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

const MODULE_ACRONYMS = new Set(["crm", "hr", "kpi", "roi", "sos"]);

/**
 * HOW MANY NOTICES THE BAND ASKS FOR. The endpoint clamps anything above 20 to 20, so this is its
 * ceiling, not a preference — and `payloadAtCap` below is what keeps a block from calling a count
 * taken at that ceiling a day total.
 */
const FETCH_LIMIT = 20;

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

function stampOf(sentAt: string | null) {
  if (!sentAt) return "";
  const date = new Date(sentAt);
  return Number.isNaN(date.getTime()) ? "" : noticeTime.format(date);
}

function dayOf(sentAt: string | null) {
  if (!sentAt) return "";
  const date = new Date(sentAt);
  return Number.isNaN(date.getTime()) ? "" : cairoDay.format(date);
}

const byRecency = (a: NoticeView, b: NoticeView) =>
  new Date(b.sentAt ?? 0).getTime() - new Date(a.sentAt ?? 0).getTime();

/**
 * ONE ENTRY PER KIND, UNREAD KINDS FIRST, EACH HALF NEWEST-FIRST.
 *
 * The key is the module and the title together, which is exactly the grain the owner was reading off
 * the screen: `New CV received` is one kind however many times it fired, and a title that names a
 * person ("Awaiting your response — Hend Shaheen") is its own kind and stays its own row. Nothing is
 * collapsed across modules, so a CRM visit never lands inside a recruitment block.
 */
function groupByKind(notices: NoticeView[], today: string): NoticeKind[] {
  const kinds = new Map<string, NoticeKind>();

  for (const notice of notices) {
    const key = `${notice.module ?? ""}::${notice.title}`;
    const existing = kinds.get(key);
    if (existing) {
      existing.members.push(notice);
      continue;
    }
    kinds.set(key, {
      allToday: true,
      key,
      members: [notice],
      module: notice.module,
      newestAt: notice.sentAt,
      title: notice.title,
      unread: 0,
    });
  }

  const ordered = Array.from(kinds.values());
  for (const kind of ordered) {
    kind.members.sort(byRecency);
    kind.newestAt = kind.members[0]?.sentAt ?? null;
    kind.unread = kind.members.filter((member) => !member.isRead).length;
    kind.allToday = kind.members.every((member) => dayOf(member.sentAt) === today);
  }

  return ordered.sort((left, right) => {
    const leftUnread = left.unread > 0;
    const rightUnread = right.unread > 0;
    if (leftUnread !== rightUnread) return leftUnread ? -1 : 1;
    return new Date(right.newestAt ?? 0).getTime() - new Date(left.newestAt ?? 0).getTime();
  });
}

/**
 * HOW MANY BLOCKS THE BAND SHOWS IS NO LONGER A WIDTH QUESTION, AND THAT IS THE POINT OF THE REBUILD.
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

/* THE STATE LIVES IN THE MARGIN, NOT IN A FILL. An unread row is marked by a solid orange edge and a
   solid orange diamond; a read one keeps the same geometry in warm grey, so both sit on one grid and
   the band never looks like two different lists. Nothing is tinted: a filled pastel row is precisely
   what the house ink rule refuses. */
function MarginEdge({ unread }: { unread: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="absolute bottom-0 left-0 top-0 w-[2px]"
      style={{ background: unread ? ORANGE : "transparent" }}
    />
  );
}

const ROW_SHELL =
  "group relative flex w-full items-center gap-2.5 py-[5px] pl-3 pr-2 text-left transition-colors"
  + " duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset"
  + " focus-visible:ring-orange-500";

function TitleText({ children, unread }: { children: string; unread: boolean }) {
  return (
    <span
      className="min-w-0 flex-1 break-words text-[12.5px] leading-snug"
      style={{ color: unread ? INK : MUTED, fontWeight: unread ? 800 : 600 }}
    >
      {children}
    </span>
  );
}

/**
 * The module caption — the one piece of a row allowed to drop out when the band is narrow.
 *
 * 🔴 IT SWITCHES ON THE BAND'S OWN WIDTH, NEVER ON THE VIEWPORT, and that is the locked rule for a
 * component that can sit in a column: `@container` + `@min-[Npx]`. The band is not viewport-wide —
 * it sits beside the standing portrait, inside a shell with a sidebar — so at a 768px viewport it is
 * 510px across and at 803px it is 545px. A `md:` breakpoint here would reveal the tag at exactly the
 * width that cannot hold it.
 *
 * THE TWO THRESHOLDS ARE MEASURED, NOT CHOSEN. A kind block carries three things on its right (the
 * count, the stamp and this tag) and in a 510px band that cluster takes 230px, leaving the title
 * 210px: `New WhatsApp message — no CV attached` wraps to a second line, the band measures 135px
 * against the portrait's 120px reserve, and the whole dashboard moves down 15px. Dropping the tag put
 * it back to exactly 120px with every row at 28px, and at 545px the title fits with the tag in place
 * — so a block shows it from 540px. The tag is the right thing to drop from a block: every member
 * shares its module, and the count is the reason the block exists at all. A single row has only the
 * stamp beside it and holds both from 380px.
 */
const TAG_FROM = {
  block: "hidden @min-[540px]:inline",
  row: "hidden @min-[380px]:inline",
} as const;

function ModuleTag({
  from = "row",
  module,
}: {
  from?: keyof typeof TAG_FROM;
  module?: string | null;
}) {
  if (!module) return null;
  return (
    <span
      className={`whitespace-nowrap text-[9px] font-black uppercase tracking-[0.18em] ${TAG_FROM[from]}`}
      style={{ color: FAINT }}
    >
      {moduleLabel(module)}
    </span>
  );
}

function Stamp({ children }: { children: string }) {
  if (!children) return null;
  return (
    <span
      className="whitespace-nowrap text-[9.5px] font-bold uppercase tracking-[0.1em] tabular-nums"
      style={{ color: FAINT }}
    >
      {children}
    </span>
  );
}

/** A kind with exactly one arrival: the plain ledger row, straight to the thing. */
function SingleRow({ notice, onOpen }: { notice: NoticeView; onOpen: (id: string) => void }) {
  const unread = !notice.isRead;
  const body = (
    <>
      <MarginEdge unread={unread} />
      <Diamond color={unread ? ORANGE : "#d8cfc2"} />
      <TitleText unread={unread}>{notice.title}</TitleText>
      <span className="flex shrink-0 items-center gap-2.5 pl-1">
        <ModuleTag module={notice.module} />
        <Stamp>{stampOf(notice.sentAt)}</Stamp>
        <ArrowUpRight
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          style={{ color: ORANGE }}
        />
      </span>
    </>
  );

  return (
    <li className="border-t" style={{ borderColor: RULE }}>
      {notice.href ? (
        <Link
          className={`${ROW_SHELL} hover:bg-[#fdfaf6]`}
          href={notice.href}
          onClick={() => onOpen(notice.id)}
        >
          {body}
        </Link>
      ) : (
        <div className={ROW_SHELL}>{body}</div>
      )}
    </li>
  );
}

/** One member of an open block: who it was and when, in the message that arrival carried. */
function MemberRow({ notice, onOpen }: { notice: NoticeView; onOpen: (id: string) => void }) {
  const unread = !notice.isRead;
  const body = (
    <>
      <Diamond color={unread ? ORANGE : "#ded5c8"} />
      {/* The message is where the sender and their words are, so it is the line that identifies a
          member. It WRAPS and is never clamped — the house rule forbids an ellipsis, and a truncated
          applicant's name is the one thing a recruiter cannot act on. */}
      <span
        className="min-w-0 flex-1 break-words text-[11.5px] leading-[1.45]"
        style={{ color: unread ? "#3a3027" : MUTED, fontWeight: unread ? 600 : 500 }}
      >
        {notice.message || notice.title}
      </span>
      <span className="flex shrink-0 items-start gap-2 pl-1 pt-[2px]">
        <Stamp>{stampOf(notice.sentAt)}</Stamp>
        <ArrowUpRight
          aria-hidden="true"
          className="h-3 w-3 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          style={{ color: ORANGE }}
        />
      </span>
    </>
  );

  const shell =
    "group relative flex w-full items-start gap-2 py-[4px] pl-7 pr-2 text-left transition-colors"
    + " duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset"
    + " focus-visible:ring-orange-500";

  return (
    <li className="border-t" style={{ borderColor: "#efe9df" }}>
      {notice.href ? (
        <Link className={`${shell} hover:bg-white`} href={notice.href} onClick={() => onOpen(notice.id)}>
          {body}
        </Link>
      ) : (
        <div className={shell}>{body}</div>
      )}
    </li>
  );
}

/**
 * A KIND WITH SEVERAL ARRIVALS: the block he asked for. Collapsed it is one ledger row carrying the
 * count; pressed, it drops its own members underneath.
 *
 * It is a `<button>` with `aria-expanded` and `aria-controls`, so the drop list is a disclosure to a
 * screen reader and to the keyboard, not a div that happens to respond to a click. The count is in
 * the accessible name because the orange figure beside the title is the whole point of the block, and
 * a reader that announces only the title would be reading a different row from the one on screen.
 */
function KindBlock({
  kind,
  onOpen,
  payloadAtCap,
  peek = false,
}: {
  kind: NoticeKind;
  onOpen: (id: string) => void;
  payloadAtCap: boolean;
  /**
   * THE SHUT BAND'S OWN ROW: everything the pressed row says, with nothing to press. The peek draws
   * inside the air the portrait reserves and is clipped to exactly that air, so a drop list opened
   * there would fall into space nobody can scroll to — and a disclosure that opens into nothing is
   * worse than a row that never offered to open. In this state the rail above is the control.
   */
  peek?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const unread = kind.unread > 0;
  const count = kind.members.length;
  // `today` is a claim about the whole day, so it is only made when the band can actually see the
  // whole day: every member on the current Cairo date AND a payload that did not come back at the
  // endpoint's cap. At the cap the stamp is the honest alternative — it says when, and claims nothing.
  const wholeDayVisible = kind.allToday && !payloadAtCap;
  const caption = wholeDayVisible ? "today" : stampOf(kind.newestAt);
  // ONE BODY FOR BOTH STATES. The peek row and the pressed row say the same thing about the same
  // kind; written twice they would drift the first time a figure changed, and the band's whole claim
  // is that shut and open are the same ledger.
  const body = (
    <>
      <MarginEdge unread={unread} />
      <Diamond color={unread ? ORANGE : "#d8cfc2"} />
      <TitleText unread={unread}>{kind.title}</TitleText>
      <span className="flex shrink-0 items-center gap-2.5 pl-1">
        <span
          className="text-[12px] font-black leading-none tabular-nums"
          style={{ color: unread ? ORANGE : MUTED }}
        >
          {count}
        </span>
        {caption ? <Stamp>{caption}</Stamp> : null}
        <ModuleTag from="block" module={kind.module} />
        {peek ? null : (
          <ChevronDown
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 transition-transform duration-150"
            style={{ color: FAINT, transform: open ? "rotate(180deg)" : "none" }}
          />
        )}
      </span>
    </>
  );

  if (peek) {
    return (
      <li className="border-t" style={{ borderColor: RULE }}>
        <div className={ROW_SHELL}>{body}</div>
      </li>
    );
  }

  return (
    <li className="border-t" style={{ borderColor: RULE }}>
      <button
        aria-controls={listId}
        aria-expanded={open}
        className={`${ROW_SHELL} hover:bg-[#fdfaf6]`}
        onClick={() => setOpen((previous) => !previous)}
        type="button"
      >
        {body}
        <span className="sr-only">
          {`${count} notices of this kind${wholeDayVisible ? ", all today" : ""}. ${
            open ? "Hide them" : "Show them"
          }.`}
        </span>
      </button>

      {/* The drop list scrolls VERTICALLY past seven members and never horizontally: a kind that
          fired nine times today must not push the dashboard off the screen, and the fits-the-screen
          rule bans only the horizontal axis. */}
      {open ? (
        <ul
          className="flex max-h-[184px] flex-col overflow-y-auto overflow-x-hidden"
          id={listId}
          style={{ background: PAPER }}
        >
          {kind.members.map((member) => (
            <MemberRow key={member.id} notice={member} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * WHERE THE BAND REMEMBERS WHETHER IT IS OPEN. Per viewer, per browser, and deliberately nowhere
 * else: it is a preference about one person's own screen, so it never belongs in the database. Every
 * read and write is wrapped, because a private window or blocked site data makes `localStorage`
 * throw on access rather than return nothing.
 */
const OPEN_KEY = "phx:notice-band-open";

function readOpenPreference() {
  try {
    return window.localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function PhoenixIdentityNotices({
  className = "",
  reservesAir = false,
}: {
  className?: string;
  /**
   * 🔴 TRUE WHERE THE STANDING PORTRAIT RESERVES AIR UNDER THE BAR, AND THAT IS WHAT THE SHUT BAND
   * IS ALLOWED TO FILL (owner, 2026-10-13, with the shut band circled: "i donot want this blanque
   * area empty like this").
   *
   * The reserve is the portrait's overhang — air that exists whether or not anything is drawn in it,
   * so a ledger drawn INSIDE it costs the dashboard nothing and leaving it blank buys the dashboard
   * nothing. The peek is clipped to exactly that air and never adds a pixel of page height, which is
   * what keeps his other ruling the same day intact: "the notification should take a small place and
   * be expandable, collapsible".
   *
   * FALSE IS THE HONEST DEFAULT, because a page with no portrait reserves no air: on an initials
   * landing the shut band would have to GROW the page to show the same rows, which is exactly the
   * thing he refused. There the rail stays the whole shut band.
   */
  reservesAir?: boolean;
}) {
  const [state, setState] = useState<BandState>({ status: "loading" });
  /**
   * 🔴 COLLAPSED IS THE DEFAULT, AND THAT IS AN OWNER RULE, NOT A TASTE (2026-10-12, looking at the
   * band on the Talent Acquisition overview: "the notification is taking almost more than half of
   * her overview dashboard. It's not applicable. The notification should take a small place and be
   * expandable, collapsible").
   *
   * So the band never takes page height it was not already given: the rail carries the unread count,
   * and the ledger under it is drawn only inside the air the portrait reserves (`reservesAir`),
   * clipped to it. The page it sits on is a dashboard — the notices are a drawer on it, never a panel
   * competing with it. It opens on HER press and it remembers that, so a person who wants it open
   * pays the press once per browser.
   *
   * 🔴 AND SHUT IS NOT BLANK (owner, 2026-10-13, circling that reserved air: "i donot want this
   * blanque area empty like this"). Shut used to render nothing at all, which left a white hole the
   * height of the portrait's overhang on every landing carrying a photo. The peek fills it with the
   * same rows the open ledger shows and costs the dashboard nothing, because that air is reserved
   * whether anything is drawn in it or not.
   */
  const [expanded, setExpanded] = useState(false);
  const ledgerId = useId();

  // The remembered preference is read AFTER mount, never during render: the server has no
  // `localStorage`, so reading it in the initial state would hydrate a different tree than it
  // rendered. Collapsed is the server's answer and the honest default.
  // It is also DEFERRED rather than called in the effect body: `setState` called synchronously
  // inside an effect is a lint ERROR in this repo (cascading renders), which is the same deferral
  // the command centre uses to restore its collapsed groups.
  useEffect(() => {
    const id = setTimeout(() => {
      if (readOpenPreference()) setExpanded(true);
    }, 0);
    return () => clearTimeout(id);
  }, []);

  const toggle = () => {
    setExpanded((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
      } catch {
        /* a private window must not cost the person the press */
      }
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/notifications/in-app?limit=${FETCH_LIMIT}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
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
      // Same reason as the bell's markRead: survive a navigation that unloads the page.
      keepalive: true,
      method: "PATCH",
    }).catch(() => {});
  };

  const loaded = state.status === "ready" ? state.notices : [];
  const payloadAtCap = loaded.length >= FETCH_LIMIT;
  const kinds =
    state.status === "ready"
      ? groupByKind(loaded, cairoDay.format(new Date())).slice(0, NOTICE_ROWS)
      : [];
  const unreadCount = loaded.filter((notice) => !notice.isRead).length;

  /**
   * THE LEDGER ITSELF, WRITTEN ONCE AND DRAWN IN BOTH STATES. Shut, it fills the portrait's reserved
   * air with its rows unpressable (`peek`); open, it is the same ledger with its blocks live. Two
   * copies of this markup would drift the first time a state or a stamp changed, and the band's
   * whole claim is that what the shut band shows IS what the open one shows.
   */
  const ledger = (peek: boolean) => (
    <>
      {state.status === "loading" ? (
        // THE SKELETON IS THE SAME LEDGER, NOT A GREY BOX. Same rules, same margin, same
        // diamond — only the type is absent. A placeholder that does not share the loaded
        // layout reads as a fault rather than as a wait, which is why it is drawn at all.
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

      {state.status === "ready" && kinds.length === 0 ? (
        <p
          className="border-t px-3 py-2.5 text-[11.5px] font-semibold leading-5"
          style={{ background: PAPER, borderColor: RULE, color: MUTED }}
        >
          Nothing is waiting for you here. New notices land in this band and in the bell at the same
          moment.
        </p>
      ) : null}

      {kinds.length > 0 ? (
        // The closing rule matters: without it the last row dissolves into the page ground and
        // the ledger has a top and no bottom, which is the one thing that makes a ruled list
        // look unfinished rather than deliberate.
        <ul className="flex flex-col border-b bg-white" style={{ borderColor: RULE }}>
          {kinds.map((kind) =>
            kind.members.length > 1 ? (
              <KindBlock
                key={kind.key}
                kind={kind}
                onOpen={markRead}
                payloadAtCap={payloadAtCap}
                peek={peek}
              />
            ) : (
              <SingleRow key={kind.key} notice={kind.members[0]} onOpen={markRead} />
            ),
          )}
        </ul>
      ) : null}
    </>
  );

  // `@container` on the band is what lets a row answer to the BAND's own width instead of the
  // window's — it is 510px across at a 768px viewport and 545px at 803px, because the sidebar and
  // the standing portrait take the rest. See `ModuleTag` for the two measured thresholds.
  return (
    <section
      aria-label="Notification centre"
      className={["@container flex min-w-0 flex-col pt-2", className].join(" ")}
    >
      {/* THE RAIL IS THE WHOLE BAND WHEN IT IS SHUT, so it is the control, not a caption. Flat ink
          under a 2px orange edge, continuing the wave the identity bar ends in; the unread count is
          the one live number on it, so it takes the orange and nothing else competes with it.

          THE COUNT CARRIES A `+` AT THE CAP AND THAT IS NOT DECORATION. The band holds the newest 20
          notices, so a viewer with hundreds unread would otherwise read a flat "20" as the whole
          truth. `20+` is the honest form of a number this surface cannot finish counting. */}
      <button
        aria-controls={ledgerId}
        aria-expanded={expanded}
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-[5px] text-left transition-opacity duration-150 hover:opacity-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-orange-400"
        onClick={toggle}
        style={{ background: INK, boxShadow: `inset 0 -2px 0 0 ${ORANGE}` }}
        type="button"
      >
        <Diamond color={ORANGE} />
        <h2 className="whitespace-nowrap text-[9.5px] font-black uppercase tracking-[0.22em] text-[#f5efe6]">
          Notification centre
        </h2>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {state.status === "ready" ? (
            <>
              <span
                className="text-[12px] font-black leading-none tabular-nums"
                style={{ color: unreadCount === 0 ? "#8d8378" : ORANGE }}
              >
                {payloadAtCap && unreadCount >= FETCH_LIMIT ? `${unreadCount}+` : unreadCount}
              </span>
              <span className="whitespace-nowrap text-[9px] font-black uppercase tracking-[0.18em] text-[#9a9087]">
                unread
              </span>
            </>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 transition-transform duration-150"
            style={{ color: "#9a9087", transform: expanded ? "rotate(180deg)" : "none" }}
          />
        </span>
        <span className="sr-only">
          {expanded ? "Hide the notice list." : "Show the notice list."}
        </span>
      </button>

      {/* OPEN: the ledger is capped and scrolls, and it may grow the band because she pressed for
          it — three kinds with one of them expanded must not take a dashboard over again. */}
      {expanded ? (
        <div
          className="flex min-w-0 flex-col overflow-y-auto overflow-x-hidden"
          id={ledgerId}
          style={{ maxHeight: "248px" }}
        >
          {ledger(false)}
        </div>
      ) : null}

      {/* 🔴 SHUT, THE BAND FILLS THE AIR THE PORTRAIT ALREADY RESERVED — AND NOT ONE PIXEL MORE
          (owner, 2026-10-13, with that air circled: "i donot want this blanque area empty like
          this"). Before this the shut band was the rail alone, so the overhang under it was a white
          hole on every landing with a portrait.

          THE ABSOLUTE FILL IS THE WHOLE MECHANISM, NOT A STYLING CHOICE. The band is a flex item in
          an `items-stretch` row whose height is set by the portrait's spacer, so anything in NORMAL
          flow that is taller than the reserve makes the row grow and pushes the dashboard down the
          page — the one failure the strip exists to prevent, measured and pinned in
          `tests/identity-strip-emblem.test.ts`. Absolutely-positioned content contributes no height
          at all: the ledger can only ever be clipped by the air, never add to it.

          AND THE ROWS DO NOT OPEN HERE (`peek`). A drop list inside a box that cannot scroll would
          fall into space nobody can reach; the rail above is the control, and pressing it swaps this
          peek for the real ledger. */}
      {!expanded && reservesAir ? (
        <div className="relative min-h-0 flex-1">
          <div className="absolute inset-0 flex min-w-0 flex-col overflow-hidden">{ledger(true)}</div>
        </div>
      ) : null}
    </section>
  );
}
