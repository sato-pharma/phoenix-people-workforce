"use client";

// Recruitment / ATS — AREA 2: the candidate queue.
//
// A COMPACT VERTICAL LIST, NOT A TABLE. The screen this replaces put the pool in a wide grid, which
// forced a horizontal scroll on anything under a very large monitor and made "who should I read
// next" a scanning exercise across eleven columns. Here each candidate is one block, three lines
// tall, and the eye only ever moves down.
//
// THE VACANCY IS BIGGER THAN THE JOB TITLE. That inversion is the owner's own instruction and it is
// the single most load-bearing thing on this list: a recruiter is filling a SEAT, so "applying for
// Office Coordinator" is the fact that decides whether to open the CV, and "currently a Social
// Media Executive" is context for that decision. Every previous version of this screen led with the
// current title, which reads as a directory of people rather than a queue of applications.
//
// ── IT RENDERS A WINDOW, NOT THE POOL ───────────────────────────────────────────────────────────
//
// 555 candidate blocks is ~4,000 DOM nodes re-rendered on every keystroke of the search box, which
// is most of why the old screen felt slow. This paints the first page and extends as the reader
// scrolls, so typing costs the filter and not the paint. The window RESETS whenever the narrowing
// changes — a reader who switches queue is at the top of a new list, and keeping a 400-row window
// open across that change would hand them the cost of the old list plus the new one.
//
// SELECTION SURVIVES EVERYTHING. Changing status, adding a note, sending to a manager: none of them
// re-sort the list or move the reader. A decided row STAYS where it is, wearing what was decided,
// until the reader navigates away — a queue that yanks a row out from under the cursor the instant
// it is actioned is a queue that loses your place on every single decision.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eye, Search, X } from "lucide-react";

import { candidateStatusLabel, type CandidateStatus } from "@/lib/recruitment/candidate-status";
import { candidateRedFlagLabels } from "@/lib/recruitment/red-flag";
import { EmptyNote, PaneHead, Pill, relativeDays } from "@/components/recruitment/workstation/workstation-ui";
import { roleFitVerdictLabels } from "@/lib/recruitment/role-fit";
import { screeningBandLabels } from "@/lib/recruitment/screening-order";
import type { WorkspaceCandidateRow } from "@/lib/recruitment/screening-workspace-types";
import { cn } from "@/lib/utils";

/** How many blocks are painted before the reader has scrolled. Two screens' worth on a laptop. */
const FIRST_PAGE = 40;
/** How many more each time the reader reaches the end. */
const PAGE_STEP = 40;
/** How close to the bottom counts as "reached the end", in pixels. */
const EXTEND_MARGIN = 400;

export function WorkstationCandidateList({
  decidedById,
  emptyLabel,
  onCollapse,
  onSelect,
  rows,
  search,
  onSearchChange,
  markedIds,
  onToggleMark,
  selectedId,
  title,
  totalLabel,
}: {
  /**
   * What THIS session decided, keyed by candidate id.
   *
   * It outranks the stored status on the row, and it is the reason a decided candidate can keep its
   * place in the list instead of vanishing the moment it is actioned: the row stays where it is and
   * simply wears the new verdict. The server's own counts are a snapshot and stay as loaded.
   */
  decidedById: Readonly<Record<string, CandidateStatus>>;
  emptyLabel: string;
  /**
   * The candidates ticked for a bulk decision.
   *
   * Separate from `selectedId` on purpose, and the two are genuinely different things: `selectedId`
   * is the ONE CV being read, `markedIds` is the SET being acted on. Folding them together would
   * mean either that reading a CV enrolled it in the next bulk verdict, or that ticking a box threw
   * away the document the reader had open.
   */
  markedIds: ReadonlySet<string>;
  /** Desktop only. Given, the head grows a fold control; omitted, the pane cannot be folded. */
  onCollapse?: () => void;
  /**
   * Null when this reader cannot decide anything — the row then renders with no checkbox at all,
   * exactly as it did before bulk existed. A disabled tick-box on every row would be forty pieces
   * of furniture advertising a thing that cannot be done.
   */
  onToggleMark: ((id: string) => void) | null;
  onSelect: (id: string) => void;
  onSearchChange: (value: string) => void;
  rows: readonly WorkspaceCandidateRow[];
  search: string;
  selectedId: string | null;
  title: string;
  totalLabel: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // The narrowing changed, so the window is about a list that no longer exists. Keyed on the
  // identity of the first few rows plus the length rather than on a filter object, because this
  // component is deliberately told WHAT to show and not HOW it was narrowed.
  const listKey = `${rows.length}:${rows[0]?.id ?? ""}:${rows[1]?.id ?? ""}`;

  // THE WINDOW IS DERIVED, NOT RESET IN AN EFFECT. Resetting it from a `useEffect` on the list key
  // paints the OLD window for one frame first — 400 rows on a narrowing that returned four — and
  // then re-renders; storing the key beside the count means a stale window is simply never read.
  // It is also a lint error in this repo, on purpose, for exactly that reason.
  const [windowed, setWindowed] = useState<{ key: string; limit: number }>({ key: listKey, limit: FIRST_PAGE });
  const limit = windowed.key === listKey ? windowed.limit : FIRST_PAGE;

  const widen = useCallback(
    (by: number) => {
      setWindowed((current) => {
        const from = current.key === listKey ? current.limit : FIRST_PAGE;
        return { key: listKey, limit: from + by };
      });
    },
    [listKey],
  );

  // The scroll POSITION is a DOM fact rather than state, so it stays an effect: there is no render
  // for it to be derived during, and it sets nothing React re-renders on.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [listKey]);

  const extend = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > EXTEND_MARGIN) return;
    if (limit >= rows.length) return;
    widen(PAGE_STEP);
  }, [limit, rows.length, widen]);

  const visible = useMemo(() => rows.slice(0, limit), [limit, rows]);

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-phx-line bg-white">
      <PaneHead collapseTo="left" foldLabel="candidates" onCollapse={onCollapse} right={totalLabel} title={title} />

      <div className="flex shrink-0 items-center gap-1.5 border-b border-phx-line bg-phx-surface-2 px-2 py-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 border border-phx-line bg-white px-2">
          <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-phx-ink-faint" />
          <input
            aria-label="Search candidates"
            className="min-w-0 flex-1 border-0 bg-transparent py-1.5 text-[13px] text-phx-ink outline-none placeholder:text-phx-ink-faint"
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Name, job, area, phone, email…"
            value={search}
          />
          {search ? (
            <button
              aria-label="Clear the search"
              className="shrink-0 text-phx-ink-faint transition hover:text-phx-ink"
              onClick={() => onSearchChange("")}
              type="button"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" onScroll={extend} ref={scrollRef}>
        {rows.length === 0 ? (
          <EmptyNote>{emptyLabel}</EmptyNote>
        ) : (
          <>
            {visible.map((row, index) => (
              // A FLEX LINE, with the tick-box a SIBLING of the row rather than inside it. A control
              // nested in another control is invalid HTML and behaves accordingly — the tick would be
              // swallowed by the row's own click and open the CV instead of selecting it.
              <div className="flex items-stretch" key={row.id}>
                {onToggleMark ? (
                  <label className="flex shrink-0 cursor-pointer items-start border-b border-phx-line bg-white pl-2 pr-1 pt-3">
                    <input
                      aria-label={`Select ${row.fullName} for a bulk decision`}
                      checked={markedIds.has(row.id)}
                      className="h-3.5 w-3.5 accent-phx-accent"
                      onChange={() => onToggleMark(row.id)}
                      type="checkbox"
                    />
                  </label>
                ) : null}
              <CandidateBlock
                active={row.id === selectedId}
                decided={decidedById[row.id] ?? null}
                onSelect={() => onSelect(row.id)}
                row={row}
                // A band printed on every row is not information, it is wallpaper: the list is
                // ordered BY band, so forty consecutive rows read "FIELD FORCE" and the eye has to
                // step over the same three words forty times to get to the next name. Printed only
                // where it CHANGES it does the job it was written for — it marks where one group of
                // the queue ends and the next begins — and costs nothing on the rows in between.
                showBand={index === 0 || visible[index - 1].band !== row.band}
              />
              </div>
            ))}
            {limit < rows.length ? (
              // A real button as well as the scroll handler. Scroll-to-load alone is invisible to a
              // keyboard user and silently broken if the pane never overflows.
              <button
                className="w-full border-b border-phx-line bg-phx-paper px-3 py-2 text-[12px] font-semibold text-phx-ink-2 transition hover:bg-phx-accent-soft"
                onClick={() => widen(PAGE_STEP)}
                type="button"
              >
                Show {Math.min(PAGE_STEP, rows.length - limit)} more of {rows.length}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function CandidateBlock({
  active,
  decided,
  onSelect,
  row,
  showBand,
}: {
  active: boolean;
  decided: CandidateStatus | null;
  onSelect: () => void;
  row: WorkspaceCandidateRow;
  /** True on the first row of each band — see the call site for why it is not true on all of them. */
  showBand: boolean;
}) {
  const redFlag = row.redFlags[0] ?? null;
  const status = decided ?? row.status;

  // `min-w-0 flex-1` rather than `w-full`: the row now sits in a flex line beside an optional
  // tick-box (see the call site). Alone in that line it is exactly the width it always was, so a
  // reader who cannot decide sees the list unchanged.
  return (
    <button
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1 border-b border-phx-line px-3 py-2 text-left transition",
        active
          ? "border-l-2 border-l-phx-accent bg-phx-accent-soft"
          : "border-l-2 border-l-transparent hover:bg-phx-paper",
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          {/* The name, then the SEAT in bold underneath it. Wraps rather than truncating — the
              ellipsis ban is absolute, and an Egyptian four-part name in a 320px column is exactly
              the case it was written for. */}
          <span className="block break-words text-[14px] font-bold leading-tight text-phx-ink">{row.fullName}</span>
          <span className="mt-0.5 block break-words text-[13px] font-semibold leading-tight text-phx-accent-press">
            {row.appliedForText ?? "No job named on the application"}
          </span>
          {row.currentRole ? (
            <span
              className={cn(
                "mt-0.5 block break-words text-[12px] leading-tight",
                // A hedged read is drawn in italic grey — the same convention "Applying for" has
                // used since August, extended rather than reinvented.
                row.currentRole.confirmed ? "text-phx-ink-soft" : "italic text-phx-ink-faint",
              )}
              title={row.currentRole.confirmed ? undefined : "Read off the CV, but the reader was not confident."}
            >
              Currently {row.currentRole.value}
              {row.currentEmployer ? ` · ${row.currentEmployer.value}` : ""}
            </span>
          ) : null}
        </span>

        {/* The fit read. A number that could not honestly be computed prints as a dash rather than
            as a zero — "not enough on file" and "poor fit" are opposite findings. */}
        <span
          className={cn(
            "flex w-11 shrink-0 flex-col items-center border py-0.5",
            row.fitScore === null
              ? "border-phx-line bg-phx-paper text-phx-ink-faint"
              : row.fitVerdict === "strong"
                ? "border-phx-ok-line bg-phx-ok-bg text-phx-ok"
                : row.fitVerdict === "possible"
                  ? "border-phx-warn-line bg-phx-warn-bg text-phx-warn"
                  : "border-phx-line bg-phx-paper text-phx-ink-soft",
          )}
          title={`${roleFitVerdictLabels[row.fitVerdict]} — read against ${row.fitRoleLabel}. Not an AI score: it is how many of the checks for this job the record answers.`}
        >
          <span className="text-[14px] font-black leading-none tabular-nums">
            {row.fitScore === null ? "—" : row.fitScore}
          </span>
          <span className="text-[9px] font-bold uppercase leading-tight">{row.fitScore === null ? "no read" : "fit"}</span>
        </span>
      </span>

      <span className="flex flex-wrap items-center gap-1">
        {/* A decision made in this session shows immediately and is marked as this session's, so a
            reader can tell "I just did that" from "somebody did that last week". */}
        <Pill tone={status === "rejected" ? "danger" : status === "new" ? "accent" : decided ? "ok" : "neutral"}>
          {decided ? `${candidateStatusLabel(decided)} · just now` : candidateStatusLabel(row.statusRaw)}
        </Pill>
        {row.seen ? (
          <Pill tone="neutral" title="You have opened this CV before.">
            <Eye className="h-2.5 w-2.5" />
            Read
          </Pill>
        ) : null}
        {/* SOMEBODY ELSE has read it. A separate badge from "Read" above, never folded into it,
            because the two answer different questions: "Read" decides whether the queue offers this
            CV to YOU again, this one only says the work may already be done. Two people sharing one
            queue with no sight of each other's reading do the same CVs twice and cannot tell which.
            Named, never an id — the owner's standing rule. */}
        {row.alsoReadBy.length > 0 ? (
          <Pill tone="info" title={`Also opened by ${row.alsoReadBy.join(", ")}.`}>
            <Eye className="h-2.5 w-2.5" />
            {row.alsoReadBy.length === 1 ? row.alsoReadBy[0] : `${row.alsoReadBy.length} others`}
          </Pill>
        ) : null}
        {row.locationLabel ? (
          <span className="text-[11px] text-phx-ink-soft" title={row.locationDeclared ? "The applicant asked for this." : "Worked out from the address on the CV."}>
            {row.locationLabel}
            {row.locationDeclared ? "" : " (from CV)"}
          </span>
        ) : null}
        {row.experienceLabel ? (
          <span className={cn("text-[11px]", row.experienceConfirmed ? "text-phx-ink-soft" : "italic text-phx-ink-faint")}>
            {row.experienceLabel}
          </span>
        ) : null}
        {row.source ? <span className="text-[11px] text-phx-ink-soft">{row.source}</span> : null}
        <span className="text-[11px] text-phx-ink-faint">{relativeDays(row.createdAt)}</span>
        {row.band === "no_cv" ? (
          <Pill tone="warn" title="The reader judged the attached file not to be a CV.">
            Not a CV
          </Pill>
        ) : null}
      </span>

      {row.duplicateCount > 1 ? (
        /* Names the OTHER person, which is the whole difference between "they uploaded twice" and
           "two people share a handset" — and only a person can tell those apart, which is why this
           reports and never merges. */
        <span className="flex items-start gap-1 border border-phx-warn-line bg-phx-warn-bg px-1.5 py-0.5 text-[11px] font-semibold leading-tight text-phx-warn">
          <Copy aria-hidden className="mt-px h-2.5 w-2.5 shrink-0" />
          <span className="min-w-0 break-words">
            Same phone as {row.duplicateNames.join(", ") || `${row.duplicateCount - 1} other record`}
          </span>
        </span>
      ) : null}

      {row.sentToManagerAt ? (
        <span className="block break-words text-[11px] leading-tight text-phx-ink-soft">
          Sent to {row.sentToManagerName ?? "a manager"} {relativeDays(row.sentToManagerAt)}
          {row.answeredAt ? " · answered" : " · no reply yet"}
        </span>
      ) : null}

      {redFlag ? (
        <span className="block text-[11px] font-bold uppercase tracking-[0.04em] text-phx-danger">
          {candidateRedFlagLabels[redFlag]}
        </span>
      ) : null}

      {/* The band is the queue's own ordering reason. Shown quietly, and only where it changes:
          it explains WHY this row sits where it does, which is a question a recruiter only asks at
          the boundary between two groups. */}
      {showBand ? (
        <span className="block text-[10px] uppercase tracking-[0.06em] text-phx-ink-faint">
          {screeningBandLabels[row.band]}
        </span>
      ) : null}
    </button>
  );
}
