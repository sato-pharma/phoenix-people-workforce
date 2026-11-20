"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  History,
  Inbox,
  MessageSquareText,
  RefreshCcw,
  Search,
  Timer,
  Undo2,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { approvalActionClassName } from "@/components/approvals-hub/approval-action-kit";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LANDING_NAVY_TILE,
  LandingEmpty,
  LandingFigure,
  LandingMeta,
  LandingNavyBoard,
  LandingTitle,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
import { MarketingAdvisoryCommentBox } from "@/components/employee-portal/marketing-advisory-comment-box";
import {
  ApprovalHistory,
  egp,
  formatDate,
} from "@/components/employee-portal/marketing-approval-chain";
import { MarketingRequestHistory } from "@/components/employee-portal/marketing-request-history";
import {
  PortalDesktopTable,
  PortalPagination,
  PortalRecordCard,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { MarketingRequestApproverDetail } from "@/components/marketing-requests/marketing-request-approver-detail";
import { MarketingInboxCancelButton } from "@/components/marketing-requests/marketing-inbox-cancel-button";
import { MarketingRequestedProductHistory } from "@/components/marketing-requests/marketing-requested-product-history";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { NotOnCrmListFlag } from "@/components/marketing-requests/not-on-crm-list-flag";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import type {
  MarketingApproverInboxRow,
  MarketingApproverInboxWorkspace,
  MarketingApproverOversightRow,
  MarketingApproverUpcomingRow,
} from "@/lib/marketing-requests/service";
import { adminChipDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Helpers ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/*                                                                                                                                                                                                             */
/* `egp`, `formatDate` and the whole ApprovalHistory chain now live in marketing-approval-chain.tsx,          */
/* shared with the History tab — a rung must read identically whether it is being decided or remembered.      */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function decisionHref(basePath: string, requestId: string, decision: "approve" | "reject" | "return") {
  return `${basePath}/${requestId}?decision=${decision}`;
}

/**
 * Whole days since submission — the number that turns "a queue" into "a queue with a problem in it".
 *
 * The server already computes this for the two read-only watch lists (`ageDays`), but NOT for the
 * rows awaiting the viewer's own decision, which carry `submittedAt` and nothing else. Derived here
 * rather than added to the payload so the two never disagree: same clock, same arithmetic as
 * `ageDaysSinceSubmission` in the service.
 *
 * Safe to read `Date.now()` during render even though this file is server-rendered as a client
 * component: rows arrive from a browser fetch, so the server always renders the skeleton and never
 * a row. Nothing here can produce a hydration mismatch.
 */
function daysWaiting(submittedAt: string | null): number | null {
  if (!submittedAt) return null;
  const submittedAtMs = Date.parse(submittedAt);
  if (!Number.isFinite(submittedAtMs)) return null;
  return Math.max(0, Math.floor((Date.now() - submittedAtMs) / 86_400_000));
}

function waitLabel(days: number | null): string {
  if (days === null) return "Submitted date not recorded";
  if (days === 0) return "Submitted today";
  return `${days} ${days === 1 ? "day" : "days"} waiting`;
}

/**
 * Escalation, not decoration. A marketing request is money the company has not yet committed and a
 * supplier who has not yet been told either way, so the cost of a stalled rung is real. Three days
 * is the point at which the request stops being "in progress" and starts being "sitting".
 */
function waitTone(days: number | null): { accent: string; text: string } {
  // The landing kit's rail: the card's left edge carries the escalation, the words carry the
  // same colour — no tinted header, no filled pill. A fresh request is navy: it is yours, and
  // nothing about it is late yet.
  if (days !== null && days >= 7) {
    return { accent: "border-l-rose-500", text: "text-rose-700" };
  }
  if (days !== null && days >= 3) {
    return { accent: "border-l-amber-500", text: "text-amber-700" };
  }
  return { accent: "border-l-[#08111f]", text: "text-slate-500" };
}

/**
 * Renders NOTHING when the submission date is missing, which is not a cosmetic choice.
 *
 * The pill is `whitespace-nowrap` because owner rules forbid both alternatives — no ellipsis, no
 * wrapping to a second line — so its width is its longest label. "Submitted date not recorded" is
 * 27 characters of uppercase tracking, and measured on a 375px phone (303px of content on this
 * page, after the shell's `px-3` and the page's `p-6`) that pill plus the step badge pushed the
 * card's right edge to 534px: a sideways-scrolling page. It also says nothing an approver can act
 * on — the fact strip below already reports the missing date, in a cell that is free to wrap.
 *
 * With it gone the longest label this can hold is "365 days waiting".
 */
function WaitPill({ days }: { days: number | null }) {
  if (days === null) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-phx-xs font-bold uppercase tracking-[0.08em] ${waitTone(days).text}`}
    >
      <Timer aria-hidden="true" className="h-3 w-3" />
      {waitLabel(days)}
    </span>
  );
}

/**
 * One heading shape for every queue on the page, so four sections read as one workspace: the kit's
 * tick and navy capitals, nothing under it (owner, 2026-11-20: a header is a title).
 */
function QueueHeading({ title }: { title: string }) {
  return (
    <div className="px-0.5 pt-1">
      <LandingTitle>{title}</LandingTitle>
    </div>
  );
}

/** A step or state in small coloured capitals — the kit's replacement for a filled pill. */
const STATE_TEXT_CLASS = "text-phx-xs font-bold uppercase tracking-[0.08em]";

/** The small-capital label above a figure. */
const FACT_LABEL_CLASS = "text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Skeleton --------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function RowSkeleton() {
  return (
    <div aria-busy="true" className={`space-y-2 border border-slate-200 bg-white p-4 ${adminSoftDepthClassName}`}>
      <span className="sr-only">Loading</span>
      <div aria-hidden="true" className="employee-portal-skeleton h-3 w-32" />
      <div aria-hidden="true" className="employee-portal-skeleton h-2.5 w-48" />
      <div aria-hidden="true" className="flex gap-2">
        <div className="employee-portal-skeleton h-8 w-24" />
        <div className="employee-portal-skeleton h-8 w-24" />
        <div className="employee-portal-skeleton h-8 w-24" />
      </div>
    </div>
  );
}

/** One headline figure on the inbox's navy board: a coloured rail, the label, the figure, one note. */
function BoardTile({
  label,
  note,
  rail,
  tone,
  value,
}: {
  label: string;
  note: string;
  /** The tile's 2px left rail, in the tone the figure reads in. */
  rail: string;
  tone?: string;
  value: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0 border-l-2 px-3 py-2.5", LANDING_NAVY_TILE, rail)}>
      <p className="min-w-0 break-words text-phx-xs font-bold uppercase leading-tight tracking-[0.1em] text-white/60">
        {label}
      </p>
      <div className="mt-1.5">
        <LandingFigure onNavy size="md" tone={tone}>
          {value}
        </LandingFigure>
      </div>
      <p className="mt-1 break-words text-phx-xs font-medium text-white/45">{note}</p>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Row card --------------------------------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function InboxRowCard({
  decisionBasePath,
  isDetailOpen,
  onToggleDetail,
  row,
}: {
  decisionBasePath: string;
  isDetailOpen: boolean;
  onToggleDetail: () => void;
  row: MarketingApproverInboxRow;
}) {
  const days = daysWaiting(row.submittedAt);
  const tone = waitTone(days);
  // The Waiting figure takes the escalation colour once it is late; until then it is navy like
  // every other figure on the card.
  const waitFigureTone = days !== null && days >= 3 ? tone.text : LANDING_INK;

  return (
    <article
      className={`@container min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName} border-l-[3px] ${tone.accent}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <p className="break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
            {row.requestCode}
          </p>
          {/* IT WRAPS. The note here used to read "never truncate with an ellipsis, never wrap to a
              second line" and only the first half is the owner's rule — AGENTS.md §4 says that where
              the no-ellipsis rule meets the no-horizontal-scroll rule, WRAPPING WINS. The measurement
              it quoted is real (459px of pharmacy name in a 317px box) and it is the argument FOR
              wrapping: a name that needs 459px cannot be read in 317px whether it scrolls or not,
              and a sideways scroll on a heading is a gesture nobody makes. The parent is min-w-0,
              so the h3 now takes the second line it needs and the name still arrives whole. */}
          <h3 className="mt-0.5 text-phx-lg font-black tracking-tight text-slate-950">
            {row.requestTitle}
          </h3>
          <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
            Customer: {row.customerName} · {row.requesterRole}
          </p>
          <NotOnCrmListFlag compact flag={row.customerCrmListFlag} />
        </div>
        {/* `w-full` below `sm`, never `shrink-0`: a shrink-0 flex-wrap box is sized by its widest
            child and cannot give way, so the nowrap wait pill and a 31-character step name
            ("National Sales Manager Approval") sat side by side and burst the card. Given the whole
            width on a phone they stack under the customer instead, and neither has to wrap its own
            text — which the owner rules forbid. */}
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 sm:w-auto sm:justify-end">
          <WaitPill days={days} />
          <span className={`${STATE_TEXT_CLASS} break-words ${LANDING_INK}`}>{row.currentStepName}</span>
        </div>
      </div>

      {/* The four numbers an approver checks BEFORE reading anything, moved to the top of the card.
          They used to sit underneath both detail panels, so the money and the pay date were the last
          thing on a very tall row rather than the first — reaching them meant scrolling past every
          product line and every pharmacy on the request. Two to a row on a phone, four once the
          card itself is wide enough (its own width, not the screen's). */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-slate-200 px-4 py-3 @xl:grid-cols-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={FACT_LABEL_CLASS}>Estimated Cost</span>
          <span className={`break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>
            {egp(row.estimatedCost)}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={FACT_LABEL_CLASS}>Pay Date</span>
          <span className={`flex items-center gap-1 break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>
            <CalendarDays aria-hidden="true" className="h-3 w-3 shrink-0 text-slate-400" />
            {formatDate(row.payDate)}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={FACT_LABEL_CLASS}>Submitted</span>
          <span className={`break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>
            {formatDate(row.submittedAt)}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={FACT_LABEL_CLASS}>Waiting</span>
          <span className={`break-words text-phx-md font-bold tabular-nums ${waitFigureTone}`}>
            {waitLabel(days)}
          </span>
        </div>
      </div>

      {/* Sales history for the products THIS request promotes — owner instruction, 2026-08-04.
          Lives on the row itself, not one click away: the approver's first question is whether
          this customer has ever bought what is being pushed, and a request whose promoted products
          have no history here is the one worth stopping before opening anything.

          Deliberately OUTSIDE the collapsible below. It is a one-line strip, and putting it behind
          a disclosure — even one that opens by default — would put it one click away for anyone who
          collapsed the row, which is exactly what that instruction forbids. */}
      <div className="border-b border-slate-200 px-4 py-3">
        <MarketingRequestedProductHistory requestId={row.id} />
      </div>

      <ApprovalHistory requestCode={row.requestCode} rungs={row.approvalHistory} />

      {/* Everything the requester actually submitted, in place. Before this the row showed a
          customer name, a cost and a pay date, and every other detail sat behind a decision
          button — so reading the request meant first clicking an answer.

          It is still in place: this disclosure is OPEN by default, so a row costs exactly what it
          cost before. What it adds is the other direction — an approver holding eight requests can
          now collapse them and scan a queue, which the old wall of always-expanded panels made
          impossible. Collapsing also skips this panel's own per-row fetch. */}
      <div className="border-b border-slate-200">
        <button
          aria-expanded={isDetailOpen}
          className={`flex min-h-11 w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors hover:bg-slate-50 motion-reduce:transition-none ${LANDING_FOCUS}`}
          onClick={onToggleDetail}
          type="button"
        >
          <span className={`inline-flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.12em] ${LANDING_INK}`}>
            {isDetailOpen ? (
              <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            Full request detail
          </span>
          <span className="whitespace-nowrap text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
            {isDetailOpen ? "Hide" : "Show"}
          </span>
        </button>
        {isDetailOpen ? (
          <div className="border-t border-slate-200 px-4 py-3">
            <MarketingRequestApproverDetail requestId={row.id} />
          </div>
        ) : null}
      </div>

      {/* The decision bar. Approve always renders — a rung that cannot be advanced is not a rung.
          Return and reject are PER-STEP powers held on the step row (`allow_return` /
          `allow_reject`), and until now this card ignored both and painted all three.

          Live consequence, measured on production 2026-08-19: EVERY Finance Execution step ever
          created carries `allow_reject: false` — 6 of 6 — and one of them
          (MKT-REQ-20260814-6CD456E4, B-185 Ahmed El Maraghy) is the CURRENT rung as this is
          written. So this card was painting him a Reject button he cannot use.

          What that click actually did, traced rather than assumed: `?decision=reject` only
          PRESELECTS the decision on marketing-request-decision-confirmation.tsx — it never
          auto-submits — and that page has gated its own Reject button on `summary.allowReject`
          all along. So the button vanished on arrival. Not an error, not a 400: a silent
          round trip to a page missing the one control he went there to press. The 400 is the
          backstop below it (decideMarketingRequestWorkflow throws `marketing_reject_not_allowed`),
          which is what makes the affordance provably dead — not what the approver sees.

          It is not a label problem either: that step's decision_labels still read
          `reject: "Reject"`, so only the flag knows. `allow_return` is true on every live step, so
          today the reject gate is the one that bites; the return gate is pinned with it because
          the next step config to turn one off should not need a second bug to find it.

          Same gating the MM inbox (mm-inbox-client.tsx) already applies.

          This is an AFFORDANCE, never an authorisation: the decision page and the decision API each
          re-run the whole gate, so hiding a control here removes a dead end, it grants nothing. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3">
        {/* The decisions wear the one approvals interface (approval-action-kit) — the same Approve,
            Return and Reject the request page and every other approval screen draw. */}
        <Link
          className={approvalActionClassName("approve", "regular", `motion-reduce:transition-none ${LANDING_FOCUS}`)}
          href={decisionHref(decisionBasePath, row.id, "approve")}
        >
          <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
          {row.decisionLabels.approve}
        </Link>
        {row.allowReturn ? (
          <Link
            className={approvalActionClassName("return", "regular", `motion-reduce:transition-none ${LANDING_FOCUS}`)}
            href={decisionHref(decisionBasePath, row.id, "return")}
          >
            <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />
            {row.decisionLabels.return}
          </Link>
        ) : null}
        {row.allowReject ? (
          <Link
            className={approvalActionClassName("reject", "regular", `motion-reduce:transition-none ${LANDING_FOCUS}`)}
            href={decisionHref(decisionBasePath, row.id, "reject")}
          >
            <XCircle aria-hidden="true" className="h-3.5 w-3.5" />
            {row.decisionLabels.reject}
          </Link>
        ) : null}
        <Link
          className={landingActionClassName("outline", "ml-auto")}
          href={`/marketing-requests/${row.id}`}
        >
          <Eye aria-hidden="true" className="h-3.5 w-3.5" />
          Open the full record
        </Link>
      </div>
    </article>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Main ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function AdvisoryRowCard({ onPosted, row }: { onPosted: () => void; row: MarketingApproverInboxRow }) {
  return (
    <article className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName} border-l-[3px] border-l-sky-500`}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <p className="break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{row.requestCode}</p>
          {/* IT WRAPS. The note here used to read "never truncate with an ellipsis, never wrap to a
              second line" and only the first half is the owner's rule — AGENTS.md §4 says that where
              the no-ellipsis rule meets the no-horizontal-scroll rule, WRAPPING WINS. The measurement
              it quoted is real (459px of pharmacy name in a 317px box) and it is the argument FOR
              wrapping: a name that needs 459px cannot be read in 317px whether it scrolls or not,
              and a sideways scroll on a heading is a gesture nobody makes. The parent is min-w-0,
              so the h3 now takes the second line it needs and the name still arrives whole. */}
          <h3 className="mt-0.5 text-phx-lg font-black tracking-tight text-slate-950">
            {row.requestTitle}
          </h3>
          <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
            Customer: {row.customerName} · {row.requesterRole}
          </p>
          <NotOnCrmListFlag compact flag={row.customerCrmListFlag} />
        </div>
        {/* Same width rule as the decision card above — `w-full` below `sm`, never `shrink-0`. */}
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 sm:w-auto sm:justify-end">
          <WaitPill days={daysWaiting(row.submittedAt)} />
          <span className={`${STATE_TEXT_CLASS} text-sky-700`}>For your comment</span>
        </div>
      </div>

      <div className="px-4 py-3">
        <MarketingAdvisoryCommentBox onPosted={onPosted} requestId={row.id} />
      </div>
    </article>
  );
}

/** Which of the four queues the workspace is showing. */
type InboxQueue = "advisory" | "decide" | "oversight" | "upcoming";

/** How the decision queue is ordered. Oldest-first is the default the server already sorts to. */
type DecideSort = "cost" | "newest" | "oldest";

const DECIDE_SORTS: ReadonlyArray<{ key: DecideSort; label: string }> = [
  { key: "oldest", label: "Longest waiting" },
  { key: "newest", label: "Newest first" },
  { key: "cost", label: "Highest value" },
];

function MarketingRequestInboxInner({ decisionBasePath }: { decisionBasePath: string }) {
  const [rows, setRows] = useState<MarketingApproverInboxRow[]>([]);
  const [advisoryRows, setAdvisoryRows] = useState<MarketingApproverInboxRow[]>([]);
  const [upcomingRows, setUpcomingRows] = useState<MarketingApproverUpcomingRow[]>([]);
  // Server-side only: this arrives populated for a Super Admin and empty for everyone else. The
  // component never decides who may see it — see canViewMarketingOversightQueue.
  const [oversightRows, setOversightRows] = useState<MarketingApproverOversightRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<InboxQueue>("decide");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<DecideSort>("oldest");
  // Ids whose "Full request detail" panel the reader has CLOSED. Collapsed-by-exception, so the
  // default for every row — including rows that arrive on a later refresh — stays open.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());

  const loadInbox = useCallback(async () => {
    try {
      const response = await fetch("/api/marketing-requests/inbox", {
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | MarketingApproverInboxWorkspace
        | { message?: string };
      if (!response.ok) {
        setRows([]);
        setAdvisoryRows([]);
        setUpcomingRows([]);
        setOversightRows([]);
        setError(
          ("message" in payload && payload.message) ||
            "Unable to load your approval inbox.",
        );
        return;
      }

      setRows((payload as MarketingApproverInboxWorkspace).rows ?? []);
      setAdvisoryRows((payload as MarketingApproverInboxWorkspace).advisoryRows ?? []);
      setUpcomingRows((payload as MarketingApproverInboxWorkspace).upcomingRows ?? []);
      setOversightRows((payload as MarketingApproverInboxWorkspace).oversightRows ?? []);
      setError(null);
    } catch {
      setRows([]);
      setAdvisoryRows([]);
      setUpcomingRows([]);
      setOversightRows([]);
      setError("Unable to load your approval inbox.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadInbox();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadInbox]);

  /* ------ What the numbers at the top actually say ------------------------------------------- */

  const valueAwaitingMe = useMemo(
    () => rows.reduce((total, row) => total + (Number.isFinite(row.estimatedCost) ? row.estimatedCost : 0), 0),
    [rows],
  );
  const longestWait = useMemo(
    () => rows.reduce((worst, row) => Math.max(worst, daysWaiting(row.submittedAt) ?? 0), 0),
    [rows],
  );

  /* ------ The decision queue: searched, then sorted ------------------------------------------ */

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matched = needle
      ? rows.filter((row) =>
          [row.requestCode, row.requestTitle, row.customerName, row.requesterName, row.requestType, row.currentStepName]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : rows;
    const ordered = [...matched];
    if (sort === "cost") {
      ordered.sort((left, right) => right.estimatedCost - left.estimatedCost);
    } else if (sort === "newest") {
      ordered.sort((left, right) => (right.submittedAt ?? "").localeCompare(left.submittedAt ?? ""));
    } else {
      ordered.sort((left, right) => (left.submittedAt ?? "").localeCompare(right.submittedAt ?? ""));
    }
    return ordered;
  }, [rows, search, sort]);

  /* ------ Queue navigation ------------------------------------------------------------------
      Four queues that used to be one endless scroll. Only a queue that HAS something in it gets a
      segment — an approver with no advisory rungs should not be shown a tab that can only ever say
      "nothing here", and padding the bar to four is exactly the kind of empty list the owner has
      ruled out. The active queue is DERIVED, not stored: if the queue you were on empties on a
      refresh (or you never had one), the first populated queue takes over without an effect. */
  const segments = useMemo(
    () =>
      [
        { count: rows.length, icon: Inbox, key: "decide" as const, label: "Awaiting my decision" },
        { count: upcomingRows.length, icon: Clock3, key: "upcoming" as const, label: "Coming to me" },
        { count: advisoryRows.length, icon: MessageSquareText, key: "advisory" as const, label: "For my comment" },
        { count: oversightRows.length, icon: Eye, key: "oversight" as const, label: "Company queue" },
      ].filter((segment) => segment.count > 0),
    [advisoryRows.length, oversightRows.length, rows.length, upcomingRows.length],
  );
  const activeQueue: InboxQueue = segments.some((segment) => segment.key === queue)
    ? queue
    : (segments[0]?.key ?? "decide");

  /**
   * "Nothing involves you" is a statement about the QUEUE, and it may only be made when the queue
   * was actually read.
   *
   * Every failure path here — a non-ok response and the network catch alike — clears all four row
   * sets and sets `error`. Without the `!error` leg below, those empty arrays took the same branch
   * a genuinely empty inbox takes, so a 500 rendered "No marketing requests involve you right now"
   * in large type with the error banner above it. For the Financial Advisor that panel IS the
   * landing page, and that sentence is the one thing it must never say on a failed load.
   */
  const isCompletelyEmpty =
    !error &&
    rows.length === 0 &&
    advisoryRows.length === 0 &&
    upcomingRows.length === 0 &&
    oversightRows.length === 0;

  const openRowCount = rows.filter((row) => !collapsedIds.has(row.id)).length;

  return (
    <div className="space-y-3" dir="auto">
      {/* ------ What this queue is worth, before any of it is read --------------------------------
          The page opened straight onto row one and answered "how much money is stopped on me" and
          "how long has the worst of it been stopped" only by reading every card to the bottom.
          These are the page's headline figures, so they stand on its ONE navy board (the landing
          kit); the count and the refresh sit in the board's own header. */}
      <LandingNavyBoard
        label="Requests awaiting my decision"
        right={
          <>
            {/* `rows` is emptied on every failure path, so without the error leg a failed load
                reported "0 requests pending" — a count, in the same place a real count goes. */}
            <LandingMeta
              items={[
                isLoading
                  ? "Loading…"
                  : error
                    ? "Could not be counted"
                    : `${rows.length} request${rows.length === 1 ? "" : "s"} pending`,
              ]}
              onNavy
            />
            <button
              aria-label="Refresh inbox"
              className={`flex h-10 w-10 shrink-0 items-center justify-center border border-white/20 text-white/70 transition-colors hover:bg-white/10 hover:text-white motion-reduce:transition-none sm:h-9 sm:w-9 ${LANDING_FOCUS}`}
              onClick={() => {
                setIsLoading(true);
                setError(null);
                void loadInbox();
              }}
              title="Refresh inbox"
              type="button"
            >
              {isLoading ? <LoadingSpinner /> : <RefreshCcw aria-hidden="true" className="h-3.5 w-3.5" />}
            </button>
          </>
        }
      >
        {isLoading ? (
          <div aria-busy="true" className="space-y-3 px-1 py-2">
            <span className="sr-only">Loading</span>
            <div aria-hidden="true" className="employee-portal-skeleton h-[22px] w-24 opacity-20" />
            <div aria-hidden="true" className="employee-portal-skeleton h-1 w-full opacity-20" />
          </div>
        ) : !isCompletelyEmpty ? (
          <div className="@container">
            <div className="grid grid-cols-1 gap-2 @xs:grid-cols-2 @3xl:grid-cols-3">
              <BoardTile
                label="Awaiting my decision"
                note={rows.length === 0 ? "Nothing is stopped on you" : "Your rung is the open one"}
                rail="border-l-white/70"
                value={rows.length}
              />
              {rows.length > 0 ? (
                <BoardTile
                  label="Value awaiting me"
                  note="Estimated cost of the requests above"
                  rail="border-l-emerald-400"
                  value={egp(valueAwaitingMe)}
                />
              ) : null}
              {rows.length > 0 ? (
                <BoardTile
                  label="Longest wait"
                  note="Since the requester submitted it"
                  rail={longestWait >= 7 ? "border-l-rose-400" : longestWait >= 3 ? "border-l-amber-400" : "border-l-white/30"}
                  tone={longestWait >= 7 ? "text-rose-300" : longestWait >= 3 ? "text-amber-300" : undefined}
                  value={waitLabel(longestWait)}
                />
              ) : null}
              {upcomingRows.length > 0 ? (
                <BoardTile
                  label="Coming to me"
                  note="You approve later in the chain"
                  rail="border-l-amber-400"
                  value={upcomingRows.length}
                />
              ) : null}
              {advisoryRows.length > 0 ? (
                <BoardTile
                  label="For my comment"
                  note="Non-blocking — the chain moves without you"
                  rail="border-l-sky-400"
                  value={advisoryRows.length}
                />
              ) : null}
              {oversightRows.length > 0 ? (
                <BoardTile
                  label="In approval company-wide"
                  note="Held by other approvers — view only"
                  rail="border-l-white/30"
                  value={oversightRows.length}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </LandingNavyBoard>

      {/* ------ Error: a rose rail, the words in slate ---------------------------------------------- */}
      {error ? (
        <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 ${adminSoftDepthClassName}`}>
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-rose-500" />
          <span className="min-w-0 break-words text-phx-md font-semibold text-slate-700">{error}</span>
        </div>
      ) : null}

      {/* ------ Queue navigator: navy words on a navy rule, never a filled chip ------------------- */}
      {!isLoading && segments.length > 1 ? (
        <div
          className={`grid w-full grid-cols-2 border border-slate-200 bg-white sm:flex ${adminSoftDepthClassName}`}
          role="tablist"
        >
          {segments.map((segment) => {
            const Icon = segment.icon;
            const isActive = segment.key === activeQueue;
            return (
              <button
                aria-selected={isActive}
                className={cn(
                  "inline-flex min-h-11 min-w-0 flex-1 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 border-b-2 px-2 py-2 text-center text-phx-xs font-bold uppercase tracking-[0.08em] transition-colors motion-reduce:transition-none",
                  LANDING_FOCUS,
                  isActive
                    ? "border-[#08111f] text-[#08111f]"
                    : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-[#08111f]",
                )}
                key={segment.key}
                onClick={() => setQueue(segment.key)}
                role="tab"
                type="button"
              >
                <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="break-words">{segment.label}</span>
                <span className={cn("tabular-nums", isActive ? "text-[#08111f]" : "text-slate-400")}>
                  {segment.count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* ------ Body ------------------------------------------------------------------------------------------------------------------------------------------- */}
      {isLoading ? (
        <div className="space-y-3">
          <RowSkeleton />
          <RowSkeleton />
        </div>
      ) : isCompletelyEmpty ? (
        <section className={`flex flex-col items-center justify-center gap-2 border border-slate-200 bg-white px-4 py-10 text-center ${adminSoftDepthClassName}`}>
          <Inbox aria-hidden="true" className="h-5 w-5 text-slate-400" />
          <p className={`text-phx-base font-black ${LANDING_INK}`}>
            No marketing requests involve you right now
          </p>
          <p className="max-w-sm text-phx-sm font-medium text-slate-500">
            Requests appear here from the moment they are submitted — both the ones waiting on you and
            the ones still moving toward your step.
          </p>
        </section>
      ) : activeQueue === "decide" ? (
        <div className="space-y-3">
          {/* Search, order and a single control that opens or closes every panel at once. An
              approver holding eight requests could previously only read them in submission order,
              in full, one wall of panels after another. */}
          <div className={`flex flex-col gap-2 border border-slate-200 bg-white p-3 sm:flex-row sm:flex-wrap sm:items-center ${adminSoftDepthClassName}`}>
            <label className={`flex min-w-0 flex-1 items-center gap-2 border border-slate-300 bg-white px-3 focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 sm:max-w-xs ${adminChipDepthClassName}`}>
              <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              {/* 16px floor: anything smaller makes iOS Safari zoom the page on focus. */}
              <input
                className="min-h-10 w-full min-w-0 border-0 bg-transparent text-[16px] font-medium text-slate-800 outline-none placeholder:text-slate-400 sm:text-phx-md"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search code, customer, requester, step"
                type="search"
                value={search}
              />
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              {DECIDE_SORTS.map((option) => (
                <button
                  aria-pressed={sort === option.key}
                  className={landingActionClassName(sort === option.key ? "solid" : "outline", "whitespace-nowrap")}
                  key={option.key}
                  onClick={() => setSort(option.key)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              className={landingActionClassName("outline", "whitespace-nowrap sm:ml-auto")}
              onClick={() =>
                setCollapsedIds(
                  openRowCount > 0 ? new Set(rows.map((row) => row.id)) : new Set<string>(),
                )
              }
              type="button"
            >
              {openRowCount > 0 ? "Collapse all detail" : "Expand all detail"}
            </button>
          </div>

          {visibleRows.length === 0 ? (
            <section className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
              <LandingEmpty>No request matches this search.</LandingEmpty>
            </section>
          ) : (
            visibleRows.map((row) => (
              <InboxRowCard
                decisionBasePath={decisionBasePath}
                isDetailOpen={!collapsedIds.has(row.id)}
                key={row.id}
                onToggleDetail={() =>
                  setCollapsedIds((current) => {
                    const next = new Set(current);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  })
                }
                row={row}
              />
            ))
          )}
        </div>
      ) : activeQueue === "upcoming" ? (
        /* ------ Coming to you: you hold a LATER step, so this is read-only tracking ------------------
            Owner instruction, 2026-08-04. The inbox previously queried status='current' only, so an
            approver above rung 1 saw nothing until the request was already theirs. The CEO sits at
            step 4 of 4 and could be on the hook for a request that had been stalled for days without
            any way to see it. No decision buttons here — it is not their turn — but the request, where
            it is stopped, who holds it, and how long it has been in the system are all visible. */
        <div className="space-y-3">
          <QueueHeading title="Coming to you" />
          <ChainWatchList rows={upcomingRows} />
        </div>
      ) : activeQueue === "advisory" ? (
        /* ------ Advisory: requests awaiting your comment (non-blocking) ------------------------------- */
        <div className="space-y-3">
          <QueueHeading title="Awaiting your comment" />
          {advisoryRows.map((row) => (
            <AdvisoryRowCard key={`advisory-${row.id}`} onPosted={() => void loadInbox()} row={row} />
          ))}
        </div>
      ) : (
        /* ------ Everything in approval: Super Admin oversight, read-only ------------------------------
            Owner instruction, 2026-08-18. Every other queue is scoped to the viewer's own rungs, and
            a Super Admin holds none — so this inbox showed him nothing while requests sat pending with
            other people. The server decides who gets these rows (canViewMarketingOversightQueue); for
            every other role the array is empty and this queue never appears in the navigator.

            Last in the file, and with no decision controls, on purpose: it is a watch list, not a
            queue. `tests/marketing-super-admin-oversight.test.ts` reads this module from the heading
            below to the end of the file and fails if a decision link appears anywhere in it — which
            is why ChainWatchList, the renderer both watch lists share, is declared BELOW rather than
            above. The test sees the markup it actually renders. */
        <div className="space-y-3">
          <QueueHeading title="Everything in approval" />
          <ChainWatchList onCancelled={() => void loadInbox()} rows={oversightRows} />
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- The read-only watch lists ------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

/**
 * "Coming to me" and "Everything in approval", drawn once.
 *
 * Both answer the same three questions — where is it stopped, who is holding it, how long has it
 * been there — and neither may ever decide anything. One renderer that carries no decision control
 * is a stronger guarantee than two that happen not to.
 *
 * Desktop gets a table and mobile gets cards, per the admin-shell rule. The `md:` gates come from
 * `PortalDesktopTable` / `PortalResponsiveDataList` themselves and are real CSS, not the decorative
 * `data-portal-desktop-table` attribute — that one is injected by the PORTAL shell only and does
 * nothing at all on an admin page.
 *
 * Windowed at 25. `PortalResponsiveDataList` emits the card markup AND the table markup for every
 * item it is handed and hides one half in CSS, so an uncapped company-wide queue would ship two
 * full renders of itself to a phone.
 */
const WATCH_PAGE_SIZE = 25;

function ChainWatchList({
  onCancelled,
  rows,
}: {
  /**
   * Passed by the oversight queue only. When present, a row the server marked `canCancel` gets a
   * Cancel control that calls this back on success (the inbox's own reload) so the row drops. The
   * "Coming to me" queue omits it, and its rows never carry `canCancel`, so no cancel control can
   * ever appear there — the affordance is a decision, and that list is not the decider's.
   */
  onCancelled?: () => void;
  rows: ReadonlyArray<MarketingApproverOversightRow & { myStepSequence?: number }>;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / WATCH_PAGE_SIZE));
  // Clamped during render rather than reset from an effect: a refresh that shortens the list must
  // not leave the reader on a page that no longer exists, and `setState` inside `useEffect` is a
  // lint error in this repo.
  const safePage = Math.min(page, pageCount - 1);
  const visible = rows.slice(safePage * WATCH_PAGE_SIZE, safePage * WATCH_PAGE_SIZE + WATCH_PAGE_SIZE);

  // tests/marketing-request-service.test.ts pins this sentence in its JSX form — "an upcoming row
  // must state where the actor's own rung sits in the chain" (owner 2026-08-04). Rewriting it as
  // a template literal read identically on screen and silently broke that pin, so it stays JSX.
  const position = (row: MarketingApproverOversightRow & { myStepSequence?: number }) =>
    row.myStepSequence ? (
      <>Your step is {row.myStepSequence} of {row.totalGatingSteps}</>
    ) : (
      <>Step {row.stepSequence} of {row.totalGatingSteps}</>
    );

  const holder = (row: MarketingApproverOversightRow) =>
    row.awaitingStepName
      ? `Now with ${row.awaitingApproverName || "an unassigned approver"} — ${row.awaitingStepName}`
      : "No open approval step on this request.";

  const age = (row: MarketingApproverOversightRow) =>
    row.ageDays === 0 ? "Submitted today" : `${row.ageDays} ${row.ageDays === 1 ? "day" : "days"} in system`;

  /** The age in coloured small capitals — rose past a week, amber past three days, slate before. */
  const ageTone = (row: MarketingApproverOversightRow) =>
    row.ageDays >= 7 ? "text-rose-700" : row.ageDays >= 3 ? "text-amber-700" : "text-slate-500";

  return (
    <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <PortalResponsiveDataList
        empty={<LandingEmpty>Nothing is in this list right now.</LandingEmpty>}
        getKey={(row) => `watch-${row.id}`}
        items={[...visible]}
        renderCard={(row) => (
          <PortalRecordCard
            accent={row.ageDays >= 7 ? "rose" : row.ageDays >= 3 ? "amber" : "slate"}
            actions={
              <div className="flex flex-wrap items-start gap-2">
                <Link className={landingActionClassName("outline")} href={`/marketing-requests/${row.id}`}>
                  <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                  Open the full record
                </Link>
                {onCancelled && row.canCancel ? (
                  <MarketingInboxCancelButton
                    onCancelled={onCancelled}
                    requestCode={row.requestCode}
                    requestId={row.id}
                  />
                ) : null}
              </div>
            }
            className="border-b border-slate-200 last:border-b-0"
            meta={
              <>
                <span className="block">
                  {row.requestCode} · Customer: {row.customerName} ·{" "}
                  <span className={`font-bold tabular-nums ${LANDING_INK}`}>{egp(row.estimatedCost)}</span>
                </span>
                <span className="mt-1 block text-slate-700">{holder(row)}</span>
                <span className="mt-0.5 block text-slate-500">{position(row)}</span>
              </>
            }
            status={<span className={`whitespace-nowrap ${STATE_TEXT_CLASS} ${ageTone(row)}`}>{age(row)}</span>}
            title={row.requestTitle}
          />
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[10%]" />
                <col className="w-[16%]" />
                <col className="w-[13%]" />
                <col className="w-[10%]" />
                <col className="w-[18%]" />
                <col className="w-[12%]" />
                <col className="w-[11%]" />
                <col className="w-[10%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-slate-200">
                {["Request", "Customer", "Raised by", "Value", "Now with", "Position", "In system", ""].map(
                  (heading, index) => (
                    <th
                      className="px-3 py-2.5 text-left text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500"
                      key={`${heading}-${index}`}
                      scope="col"
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  className="border-b border-slate-200 align-top transition-colors last:border-b-0 hover:bg-slate-50 motion-reduce:transition-none"
                  key={`watch-row-${row.id}`}
                >
                  <td className="min-w-0 break-words px-3 py-2.5 text-phx-xs font-bold uppercase tracking-[0.06em] text-slate-500">
                    {row.requestCode}
                  </td>
                  <td className={`min-w-0 break-words px-3 py-2.5 text-phx-md font-bold ${LANDING_INK}`} dir="auto">
                    {row.customerName}
                  </td>
                  <td className="min-w-0 break-words px-3 py-2.5 text-phx-sm font-semibold text-slate-700" dir="auto">
                    {row.requesterName}
                  </td>
                  <td className={`min-w-0 break-words px-3 py-2.5 text-phx-md font-bold tabular-nums ${LANDING_INK}`}>
                    {egp(row.estimatedCost)}
                  </td>
                  <td className="min-w-0 break-words px-3 py-2.5 text-phx-sm font-semibold text-slate-700">
                    {holder(row)}
                  </td>
                  <td className="min-w-0 break-words px-3 py-2.5 text-phx-sm font-medium tabular-nums text-slate-500">
                    {position(row)}
                  </td>
                  <td className="min-w-0 break-words px-3 py-2.5">
                    <span className={`${STATE_TEXT_CLASS} ${ageTone(row)}`}>{age(row)}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex flex-wrap items-start justify-end gap-2">
                      <Link className={landingActionClassName("outline")} href={`/marketing-requests/${row.id}`}>
                        <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                        Open the full record
                      </Link>
                      {onCancelled && row.canCancel ? (
                        <MarketingInboxCancelButton
                          onCancelled={onCancelled}
                          requestCode={row.requestCode}
                          requestId={row.id}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
      {rows.length > WATCH_PAGE_SIZE ? (
        <PortalPagination
          label={`Showing ${safePage * WATCH_PAGE_SIZE + 1}–${safePage * WATCH_PAGE_SIZE + visible.length} of ${rows.length}`}
        >
          <button
            className={landingActionClassName("outline")}
            disabled={safePage === 0}
            onClick={() => setPage(Math.max(0, safePage - 1))}
            type="button"
          >
            Previous
          </button>
          <button
            className={landingActionClassName("outline")}
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
            type="button"
          >
            Next
          </button>
        </PortalPagination>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Tabs: live approvals, and everything already answered ------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

type InboxTab = "approval" | "history";

const INBOX_TABS: ReadonlyArray<{ description: string; icon: typeof Inbox; key: InboxTab; label: string }> = [
  { description: "Still moving through the chain", icon: Inbox, key: "approval", label: "In approval" },
  { description: "Approved, rejected or returned", icon: History, key: "history", label: "History" },
];

/**
 * Two views of the same queue, on the same page — owner instruction, 2026-08-19.
 *
 * The History panel is mounted only once it has actually been opened, so the default view costs
 * exactly what it did before this change; after that BOTH panels stay mounted and the inactive one
 * is hidden. Unmounting on every switch would throw away the loaded rows and re-fire every per-row
 * detail fetch on the way back — the tab would get slower the more it is used.
 */
function MarketingInboxTabs({ decisionBasePath }: { decisionBasePath: string }) {
  const [tab, setTab] = useState<InboxTab>("approval");
  const [historyOpened, setHistoryOpened] = useState(false);

  return (
    <div className="space-y-4">
      {/* The page's two views, drawn like every portal tab bar now: navy words on a navy rule,
          never a filled chip. */}
      <div
        className={`grid w-full grid-cols-2 border border-slate-200 bg-white sm:inline-grid sm:w-auto ${adminSoftDepthClassName}`}
        role="tablist"
      >
        {INBOX_TABS.map((definition) => {
          const Icon = definition.icon;
          const isActive = definition.key === tab;
          return (
            <button
              aria-selected={isActive}
              className={cn(
                "inline-flex min-h-11 min-w-0 items-center justify-center gap-2 border-b-2 px-4 py-2 text-phx-xs font-bold uppercase tracking-[0.1em] transition-colors motion-reduce:transition-none sm:min-w-[10rem]",
                LANDING_FOCUS,
                isActive
                  ? "border-[#08111f] text-[#08111f]"
                  : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-[#08111f]",
              )}
              key={definition.key}
              onClick={() => {
                if (definition.key === "history") setHistoryOpened(true);
                setTab(definition.key);
              }}
              role="tab"
              type="button"
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span>{definition.label}</span>
              <span
                className={`hidden text-phx-xs font-medium normal-case tracking-normal sm:inline ${
                  isActive ? "text-slate-500" : "text-slate-400"
                }`}
              >
                {definition.description}
              </span>
            </button>
          );
        })}
      </div>

      <div className={tab === "approval" ? undefined : "hidden"}>
        <MarketingRequestInboxInner decisionBasePath={decisionBasePath} />
      </div>
      {historyOpened ? (
        <div className={tab === "history" ? undefined : "hidden"}>
          <MarketingRequestHistory />
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Exported wrapper with error boundary --------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export function MarketingRequestInbox({
  decisionBasePath = "/employee-portals/marketing-requests/decision",
}: {
  decisionBasePath?: string;
}) {
  return (
    <WorkspaceErrorBoundary fallbackTitle="Marketing approval inbox error">
      <MarketingInboxTabs decisionBasePath={decisionBasePath} />
    </WorkspaceErrorBoundary>
  );
}
