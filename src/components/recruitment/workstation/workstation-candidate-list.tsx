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
import { Copy, Eye, FolderClosed, Inbox, Search, X } from "lucide-react";

import { adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { candidateStatusLabel, type CandidateStatus } from "@/lib/recruitment/candidate-status";
import { candidateRedFlagLabels } from "@/lib/recruitment/red-flag";
import { StarMark } from "@/components/recruitment/workstation/candidate-stars";
import { Medallion } from "@/components/recruitment/workstation/workstation-look";
import type { CandidateRating } from "@/lib/recruitment/candidate-rating";
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
  candidateHref,
  decidedById,
  ratedById,
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
  /** Builds one CV's address, so each row is an anchor a browser can open in its own tab. */
  candidateHref: (candidateId: string) => string;
  /**
   * What THIS session decided, keyed by candidate id.
   *
   * It outranks the stored status on the row, and it is the reason a decided candidate can keep its
   * place in the list instead of vanishing the moment it is actioned: the row stays where it is and
   * simply wears the new verdict. The server's own counts are a snapshot and stay as loaded.
   */
  decidedById: Readonly<Record<string, CandidateStatus>>;
  /**
   * The stars put on CVs in THIS sitting, keyed by candidate id.
   *
   * Same contract as `decidedById` and for the same reason: the row was loaded before the star was
   * pressed, so the row's own `rating` is the last page load's answer. A key PRESENT and holding
   * `null` means the star was taken off here, which is why the read below tests `in` rather than
   * falling through with `??`.
   */
  ratedById: Readonly<Record<string, CandidateRating | null>>;
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
    // A CARD ON THE COCKPIT'S TRAY (2026-10-19): the soft depth, a full hairline, the dark pane band.
    <div className={`flex h-full min-h-0 w-full flex-col overflow-hidden border border-phx-line bg-white ${adminSoftDepthClassName}`}>
      <PaneHead collapseTo="left" foldLabel="candidates" onCollapse={onCollapse} right={totalLabel} title={title} />

      {/* The search sits in a recessed strip under the band; the field itself wears the one form
          design's ground and its orange focus edge, never a shadow of its own. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1.5 border-b border-phx-line bg-phx-surface-2 px-2 py-1.5",
          adminRecessedDepthClassName,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 border border-phx-line bg-white px-2 transition-colors focus-within:border-orange-500">
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
          <EmptyNote icon={<Inbox aria-hidden className="h-5 w-5" />} title="Nothing in this pile">
            {emptyLabel}
          </EmptyNote>
        ) : (
          <>
            {visible.map((row, index) => {
              // A band printed on every row is not information, it is wallpaper: the list is ordered
              // BY band, so forty consecutive rows read "FIELD FORCE" and the eye has to step over
              // the same three words forty times to get to the next name. Printed only where it
              // CHANGES it does the job it was written for — it marks where one group of the queue
              // ends and the next begins — and costs nothing on the rows in between.
              const showBand = index === 0 || visible[index - 1].band !== row.band;
              return (
                <div key={row.id}>
                  {/* THE BAND IS A GROUP HEADING, SO IT IS DRAWN AS ONE — the full width of the list,
                      above the first row of the group, spanning the tick-box column too. It used to
                      print at the BOTTOM of the first card, which reads as a caption on that one
                      candidate rather than as the name of the group they open; and drawn inside the
                      card it would start after the tick-box and sit beside it, which is the same
                      mistake with better alignment. */}
                  {showBand ? (
                    <span className="block border-b border-phx-line bg-phx-surface-2 px-3 py-1 text-[10px] font-bold uppercase leading-[1.6] tracking-[0.12em] text-phx-ink-faint">
                      {screeningBandLabels[row.band]}
                    </span>
                  ) : null}
                  {/* A FLEX LINE, with the tick-box a SIBLING of the row rather than inside it. A
                      control nested in another control is invalid HTML and behaves accordingly — the
                      tick would be swallowed by the row's own click and open the CV instead. */}
                  <div className="flex items-stretch">
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
                      href={candidateHref(row.id)}
                      onSelect={() => onSelect(row.id)}
                      rating={row.id in ratedById ? (ratedById[row.id] ?? null) : row.rating}
                      row={row}
                    />
                  </div>
                </div>
              );
            })}
            {limit < rows.length ? (
              // A real button as well as the scroll handler. Scroll-to-load alone is invisible to a
              // keyboard user and silently broken if the pane never overflows.
              <button
                className="w-full border-b border-phx-line bg-phx-surface-2 px-3 py-2.5 text-[12px] font-bold text-phx-accent-press transition hover:bg-phx-accent-soft"
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

/**
 * ONE CANDIDATE, AS ONE CARD.
 *
 * Read top to bottom it answers, in this order: who · what seat they are for · why they are in this
 * pile · what they do now — with the fit read as a medallion on the trailing edge, so the eye can
 * run down the column of numbers alone when it is triaging rather than reading.
 *
 * THE VACANCY IS BIGGER THAN THE JOB TITLE, and that inversion is the owner's own instruction. A
 * recruiter is filling a SEAT, so "applying for Office Coordinator" is the fact that decides whether
 * to open the CV and "currently a Social Media Executive" is context for that decision. Every
 * earlier version of this screen led with the current title, which reads as a directory of people
 * rather than a queue of applications.
 *
 * NOTHING HERE TRUNCATES. The ellipsis ban is absolute and an Egyptian four-part name in a 288px
 * column is exactly the case it was written for, so every line wraps instead.
 */
function CandidateBlock({
  active,
  decided,
  href,
  onSelect,
  rating,
  row,
}: {
  active: boolean;
  decided: CandidateStatus | null;
  /** This CV's own address, so the row can be opened in a second tab. See the element below. */
  href: string;
  onSelect: () => void;
  /** The star as the reader sees it now — this sitting's if there is one, else the stored one. */
  rating: CandidateRating | null;
  row: WorkspaceCandidateRow;
}) {
  const redFlag = row.redFlags[0] ?? null;
  const status = decided ?? row.status;

  // Does the second line have anything to say? Written out rather than inferred from children,
  // because a JSX child that renders null is still a child — React cannot tell the caller "that row
  // came to nothing", so the row has to know before it draws.
  const hasMeta =
    rating !== null ||
    Boolean(decided) ||
    status !== "new" ||
    row.seen ||
    row.alsoReadBy.length > 0 ||
    Boolean(row.beingReadBy) ||
    row.unsavedFindings > 0 ||
    Boolean(row.locationLabel && !row.seatReason) ||
    Boolean(row.experienceLabel) ||
    Boolean(row.folderLabel && !row.seatReason) ||
    row.band === "no_cv";

  // `min-w-0 flex-1` rather than `w-full`: the row sits in a flex line beside an optional tick-box
  // (see the call site). Alone in that line it is exactly the width it always was, so a reader who
  // cannot decide sees the list unchanged.
  // ── PRESSING A CV OPENS IT ON ITS OWN PAGE, IN A NEW TAB ──────────────────────────────────────
  //
  // The owner, 2026-09-18: "when i view cv and pushed to the end of the screen and i really hustle
  // to go back where i where why not when i press on the cv i am redirected into a new tab and page
  // with full details". Reading a CV in the pane beside the list cost him his place in the list on
  // every single CV.
  //
  // The first fix made this row an anchor but still SWALLOWED a plain click (`preventDefault`, then
  // select in place), so only a ctrl-click opened a tab — and the tab it opened was the whole list
  // again. He pressed a CV the ordinary way, nothing opened, and he said so the next day: "What we do
  // yesterday is not implemented." A plain press is the one he makes, so a plain press is the one
  // that opens the tab now, and that tab is the CV's own page (see workstation-page-client.tsx).
  //
  // `onSelect` still runs — it does not stop the browser, it only marks this row as the current one,
  // so the reader comes back to this tab with the CV he opened highlighted and the list exactly where
  // he left it. `noopener` because the new tab has no business reaching back into this one.
  //
  // `no-underline` because an anchor is underlined by default and this row's type scale is drawn,
  // not inherited.
  return (
    <a
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1.5 border-b border-phx-line px-3 py-2.5 text-left no-underline transition-colors",
        // THE SELECTED ROW IS MARKED ON ITS EDGE, not painted. A 2px rule in the accent plus the
        // faintest tint reads as "this one" from across the room without turning the open candidate
        // into the loudest object on a screen whose actual subject is the CV two panes to the right.
        active
          ? "border-l-2 border-l-phx-accent bg-phx-accent-soft"
          : "border-l-2 border-l-transparent hover:bg-phx-paper",
      )}
      href={href}
      onClick={onSelect}
      rel="noopener"
      target="_blank"
    >
      <span className="flex items-start gap-2.5">
        <span className="min-w-0 flex-1">
          <span className="block break-words text-[14px] font-bold leading-tight tracking-[-0.005em] text-phx-ink">
            {row.fullName}
          </span>
          {/* The SEAT, in the accent, directly under the name — the owner's inversion, drawn. */}
          <span className="mt-1 block break-words text-[13px] font-semibold leading-tight text-phx-accent-press">
            {row.appliedForText ?? "No job named on the application"}
          </span>
          {/* WHY THIS CV IS IN THIS SEAT'S PILE. Only in seat mode, and never a guess dressed up as
              a fact: "Filed to the Menoufia 1 folder" and "Email subject names Menoufia 1" are two
              very different reasons to be looking at somebody, and a queue that silently gained
              eleven rows without saying which is a queue nobody would trust. */}
          {row.seatReason ? (
            <span className="mt-1 block break-words text-[11px] leading-snug text-phx-ink-soft">
              {row.seatReason}
            </span>
          ) : null}
          {row.currentRole ? (
            <span
              className={cn(
                "mt-1 block break-words text-[12px] leading-snug",
                // A hedged read is drawn in italic grey — the same convention "Applying for" has
                // used since August, extended rather than reinvented.
                row.currentRole.confirmed ? "text-phx-ink-2" : "italic text-phx-ink-faint",
              )}
              title={row.currentRole.confirmed ? undefined : "Read off the CV, but the reader was not confident."}
            >
              Currently {row.currentRole.value}
              {row.currentEmployer ? ` · ${row.currentEmployer.value}` : ""}
            </span>
          ) : null}
        </span>

        <Medallion
          caption={row.fitScore === null ? "no read" : "fit"}
          title={`${roleFitVerdictLabels[row.fitVerdict]} — read against ${row.fitRoleLabel}. Not an AI score: it is how many of the checks for this job the record answers.`}
          tone={
            row.fitScore === null
              ? "none"
              : row.fitVerdict === "strong"
                ? "ok"
                : row.fitVerdict === "possible"
                  ? "warn"
                  : "neutral"
          }
          value={row.fitScore}
        />
      </span>

      {/* WHAT A SCANNING EYE ACTUALLY NEEDS — and nothing else.
          This line carried nine things on every one of forty cards until 2026-09-12, and the owner's
          word for the result was "crowded and noisy". Four of the nine went, and none of them are
          lost: the status pill said "New" on a queue of new CVs, and the arrival, the source and (in
          seat mode) the place all print in the review header the moment the card is opened, one
          click away. What stays is what changes a decision before the CV is even opened — a verdict
          that is not the default, who else is on this CV, findings nobody has saved, and how long
          they have worked.

          The whole line is dropped rather than rendered empty: an empty flex row still costs its own
          gap, and forty of those is a list that breathes wrong for no reason at all. */}
      {hasMeta ? (
        <span className="flex flex-wrap items-center gap-1">
          {/* THE STAR LEADS THE LINE. It is the only mark here that a person put on this CV on
              purpose, and the whole reason the owner asked for stars was that his favourites were
              invisible from the list — so it goes ahead of the status, which is a verdict the queue
              already sorts by, and well ahead of the reading badges. An unstarred CV draws nothing;
              see StarMark for why three empty outlines on six hundred rows is not a feature. */}
          <StarMark rating={rating} />
          {/* A decision made in this session shows immediately and is marked as this session's, so a
              reader can tell "I just did that" from "somebody did that last week". A stored status
              only prints when it is NOT the default: "New" on a new-CV queue is forty identical
              pills teaching the eye to skip the one place a real verdict would appear. */}
          {decided || status !== "new" ? (
            <Pill tone={status === "rejected" ? "danger" : status === "new" ? "accent" : decided ? "ok" : "neutral"}>
              {decided ? `${candidateStatusLabel(decided)} · just now` : candidateStatusLabel(row.statusRaw)}
            </Pill>
          ) : null}
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
          {/* SOMEBODY HAS IT OPEN RIGHT NOW. The badge above is permanent history — "this work may
              already be done" — and cannot answer the collision that costs the most: two screeners
              opening the same CV in the same minute, both reading it, one reading wasted.

              `warn`, not `info`, because this one asks the reader to do something: pick another CV.
              It is advisory — nothing stops them — and it disappears by itself after five minutes,
              so a closed laptop cannot hold a CV away from the other screener. */}
          {row.beingReadBy ? (
            <Pill tone="warn" title={`${row.beingReadBy} has this open right now. Pick another CV unless you mean to look together.`}>
              <Eye className="h-2.5 w-2.5" />
              {row.beingReadBy} is reading
            </Pill>
          ) : null}
          {/* THE CV READER FOUND SOMETHING NOBODY SAVED. 271 of 582 candidates carried one of these on
              2026-09-05 and there was no way to tell from the list which. Not an extraction failure:
              cv-auto-apply writes unattended only at high confidence and `low` waits for a human, so
              for an automatically-created candidate it waited for a review that never came. The title
              names the three fields checked rather than claiming to be a total — see cv-findings.ts. */}
          {row.unsavedFindings > 0 ? (
            <Pill
              tone="warn"
              title="The CV reader found an experience figure, a national ID or a job title that is not on the record yet. Open the CV Data tab to save it."
            >
              {row.unsavedFindings} to save
            </Pill>
          ) : null}
          {/* THE PLACE, except where the line above already said it. In seat mode the reason this CV
              is in this pile names the area in a full sentence — "Chose Menoufia 1 on WhatsApp" — and
              printing "Menoufia" again two lines below is the same fact twice. Outside seat mode there
              is no such sentence and the place is a scanning fact, so it stays. */}
          {row.locationLabel && !row.seatReason ? (
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
          {/* WHERE IT IS FILED, for a CV that is filed AND still undecided. Those rejoined this queue
              on 2026-09-18 — 371 of them, every one previously invisible here (isShelvedFromReview in
              candidate-folder.ts) — and a row that silently rejoined the pile would be unreadable
              against one that was never filed at all. Same argument the place badge above makes, so
              it is dropped in seat mode for the same reason: there the seat sentence already says it.

              `info`, not `warn`: being filed is not a problem with the CV, it is where to find it. */}
          {row.folderLabel && !row.seatReason ? (
            <Pill tone="info" title={`Filed under ${row.folderLabel}. Nobody has decided on it yet, so it is still in this queue.`}>
              <FolderClosed className="h-2.5 w-2.5" />
              {row.folderLabel}
            </Pill>
          ) : null}
          {row.band === "no_cv" ? (
            <Pill tone="warn" title="The reader judged the attached file not to be a CV.">
              Not a CV
            </Pill>
          ) : null}
        </span>
      ) : null}

      {row.duplicateCount > 1 ? (
        /* Names the OTHER person, which is the whole difference between "they uploaded twice" and
           "two people share a handset" — and only a person can tell those apart, which is why this
           reports and never merges. */
        <span className="flex items-start gap-1.5 border-l-2 border-l-phx-warn bg-phx-warn-bg px-2 py-1 text-[11px] font-semibold leading-snug text-phx-warn">
          <Copy aria-hidden className="mt-px h-2.5 w-2.5 shrink-0" />
          <span className="min-w-0 break-words">
            Same phone as {row.duplicateNames.join(", ") || `${row.duplicateCount - 1} other record`}
          </span>
        </span>
      ) : null}

      {row.sentToManagerAt ? (
        <span className="block break-words text-[11px] leading-snug text-phx-ink-soft">
          Sent to {row.sentToManagerName ?? "a manager"} {relativeDays(row.sentToManagerAt)}
          {row.answeredAt ? " · answered" : " · no reply yet"}
        </span>
      ) : null}

      {redFlag ? (
        <span className="block text-[11px] font-bold uppercase tracking-[0.06em] text-phx-danger">
          {candidateRedFlagLabels[redFlag]}
        </span>
      ) : null}
    </a>
  );
}
