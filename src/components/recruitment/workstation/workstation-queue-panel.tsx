"use client";

// Recruitment / ATS — AREA 1: what needs attention, and which seat it is for.
//
// TWO RAILS, ONE COLUMN, and they answer two different questions. The work queues answer "what kind
// of work is waiting" — unread CVs, strong fits, sends nobody answered, duplicate pairs, interviews
// today. The vacancies answer "which seat am I filling this hour". A recruiter uses both, usually
// together ("the unreviewed CVs for the Monufia rep seat"), so they narrow independently and the
// panel says when the two together have emptied the list.
//
// NEITHER RAIL NAVIGATES. Picking a queue or a seat changes the list beside it and nothing else —
// no route change, no reload, no losing the CV that is open. That is the whole point of the
// workstation: the old screen made every narrowing a fresh page load through the pool.
//
// EVERY NUMBER IS REAL. The queue counts are pile sizes computed server-side over the live pool
// (screening-queues.ts) and the vacancy rows are the open seats from the organogram with their
// actual applicant counts (vacancy-applicants.ts). Nothing here is a placeholder, and a seat with
// nobody waiting still appears — "nobody has applied for this yet" is the most actionable thing
// this rail can say, and a seat that vanishes when its pile empties cannot be told from one that
// was filled.

import { AlertTriangle } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { Action, Tally } from "@/components/recruitment/workstation/workstation-look";
import { CollapsibleSection, PaneHead, Pill } from "@/components/recruitment/workstation/workstation-ui";
import {
  screeningWorkQueueDescriptions,
  screeningWorkQueueLabels,
  screeningWorkQueues,
  type ScreeningWorkQueue,
  type WorkQueueCounts,
} from "@/lib/recruitment/screening-queues";
import { vacancyPlaceLabel, type VacancyApplicantStats } from "@/lib/recruitment/vacancy-applicants";
import type { WorkspaceVacancy } from "@/lib/recruitment/screening-workspace-types";
import { cn } from "@/lib/utils";

/** "Everyone" sits under its own divider — it is the escape from a narrowing, not a narrowing. */
const NEEDS_ATTENTION: readonly ScreeningWorkQueue[] = screeningWorkQueues.filter((queue) => queue !== "all");

/**
 * Piles that are NOT somebody waiting on the reader, and so are not in the folded header's total.
 *
 * `red_flagged` is the opposite of work: it is the pile of CVs that need no further attention
 * because nobody can hire them. Counting it under "waiting" would inflate that number by 97 of 597
 * (measured 2026-09-05) and make the one figure the folded rail shows meaningless.
 */
const NOT_WAITING_ON_ANYBODY: readonly ScreeningWorkQueue[] = ["red_flagged"];

export function WorkstationQueuePanel({
  counts,
  onCollapse,
  onSelectQueue,
  onSelectVacancy,
  overdueManagerFeedback,
  queue,
  vacancies,
  vacancyId,
  vacancyStats,
}: {
  counts: WorkQueueCounts;
  /** Given, the head grows a fold control. Desktop only — see PaneHead. */
  onCollapse?: () => void;
  onSelectQueue: (queue: ScreeningWorkQueue) => void;
  onSelectVacancy: (vacancyId: number | null) => void;
  overdueManagerFeedback: number;
  queue: ScreeningWorkQueue;
  vacancies: readonly WorkspaceVacancy[];
  vacancyId: number | null;
  vacancyStats: readonly VacancyApplicantStats[];
}) {
  const statsById = new Map(vacancyStats.map((stats) => [stats.vacancyId, stats] as const));
  // What the folded header reports. `all` is excluded on purpose — "everyone in the pool" is not
  // something waiting on anybody, and adding it would make the collapsed rail read 581.
  const attentionCount = NEEDS_ATTENTION.filter((key) => !NOT_WAITING_ON_ANYBODY.includes(key)).reduce(
    (total, key) => total + counts[key],
    0,
  );

  // A PILE THAT CAN NEVER FILL IS WORSE THAN NO PILE — it teaches the eye to skip the rail.
  //
  // "Interviews today" has read 0 since the day it shipped, and structurally: one interview row has
  // ever existed in production and none carries a scheduled_at, because interviews are not booked in
  // Phoenix. Hidden while empty rather than deleted, so it returns by itself the day somebody
  // schedules one — the classifier still computes it and nothing else changes.
  const visibleQueues = NEEDS_ATTENTION.filter((key) => key !== "interviews" || counts.interviews > 0);

  return (
    // A CARD ON THE COCKPIT'S TRAY (2026-10-19): the soft depth, a full hairline, the dark pane band.
    <div className={`flex h-full min-h-0 w-full flex-col overflow-hidden border border-phx-line bg-white ${adminSoftDepthClassName}`}>
      <PaneHead collapseTo="left" onCollapse={onCollapse} right={`${counts.all} live`} title="Work queue" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* BOTH GROUPS FOLD, and each keeps its headline number while folded. On a rail this narrow
            the vacancy list is the long half — 20-odd open seats — and a recruiter working one pile
            all morning wants it out of the way without losing "how many are waiting on me". */}
        <CollapsibleSection right={`${attentionCount} waiting`} storageKey="queue:attention" title="Needs attention">
          {visibleQueues.map((key) => (
            <QueueButton
              active={queue === key}
              count={counts[key]}
              description={screeningWorkQueueDescriptions[key]}
              key={key}
              label={screeningWorkQueueLabels[key]}
              onSelect={() => onSelectQueue(key)}
              /* The overdue figure rides BESIDE the pending count, never instead of it: "12 pending,
                 4 of them overdue" is two facts a recruiter acts on differently, and one number loses
                 the eight that are merely in flight. */
              warning={key === "manager_feedback" && overdueManagerFeedback > 0 ? overdueManagerFeedback : 0}
            />
          ))}
          <QueueButton
            active={queue === "all"}
            count={counts.all}
            description={screeningWorkQueueDescriptions.all}
            label={screeningWorkQueueLabels.all}
            onSelect={() => onSelectQueue("all")}
            warning={0}
          />
        </CollapsibleSection>

        <CollapsibleSection
          right={
            vacancyId !== null ? (
              // Rides in the header's right-hand slot rather than beside the title, so a rail narrowed
              // to one seat still SAYS so — and can still be widened again — with the list folded away.
              <Action
                className="px-1.5 py-1 text-[11px] uppercase tracking-[0.06em] text-phx-accent-press"
                onClick={() => onSelectVacancy(null)}
                title="Stop narrowing the list to one seat"
                tone="ghost"
              >
                Clear filter
              </Action>
            ) : (
              `${vacancies.length} open`
            )
          }
          storageKey="queue:vacancies"
          title="Active vacancies"
        >
          {vacancies.length === 0 ? (
            /* Not an error, and it is worth saying which of the two it is. The open-seat list is
               loaded only for a viewer who can actually send a CV; for everyone else there is nothing
               to file against, so the rail is honestly absent rather than mysteriously empty. */
            <p className="px-3 py-4 text-[12px] leading-relaxed text-phx-ink-soft">
              No open vacancies are visible to you, so the list is not narrowed by seat.
            </p>
          ) : (
            vacancies.map((vacancy) => {
              const stats = statsById.get(vacancy.id);
              return (
                <VacancyButton
                  active={vacancyId === vacancy.id}
                  key={vacancy.id}
                  onSelect={() => onSelectVacancy(vacancyId === vacancy.id ? null : vacancy.id)}
                  stats={stats}
                  vacancy={vacancy}
                />
              );
            })
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
}

function QueueButton({
  active,
  count,
  description,
  label,
  onSelect,
  warning,
}: {
  active: boolean;
  count: number;
  description: string;
  label: string;
  onSelect: () => void;
  warning: number;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex w-full items-center gap-2 border-b border-phx-line px-3 py-2 text-left transition-colors",
        // The active row is a LEFT BAR plus a tint, not a fill: a solid orange row beside four
        // white ones dominates a 220px column and reads as an alert rather than as a selection.
        active
          ? "border-l-2 border-l-phx-accent bg-phx-accent-soft"
          : "border-l-2 border-l-transparent hover:bg-phx-paper",
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[13px] font-bold leading-tight", active ? "text-phx-accent-press" : "text-phx-ink")}>
          {label}
        </span>
        <span className="block text-[11px] leading-snug text-phx-ink-soft">{description}</span>
      </span>
      {warning > 0 ? (
        <Pill tone="danger" title={`${warning} of these have been waiting past the chase threshold.`}>
          <AlertTriangle className="h-2.5 w-2.5" />
          {warning}
        </Pill>
      ) : null}
      <Tally active={active}>{count}</Tally>
    </button>
  );
}

function VacancyButton({
  active,
  onSelect,
  stats,
  vacancy,
}: {
  active: boolean;
  onSelect: () => void;
  stats: VacancyApplicantStats | undefined;
  vacancy: WorkspaceVacancy;
}) {
  const place = vacancyPlaceLabel(vacancy);
  const applicants = stats?.applicants ?? 0;

  // Said in words rather than as three bare numbers, and only the parts that are non-zero: "8
  // recommended · 4 with a manager" is read at a glance, "0 · 8 · 4" has to be decoded against a
  // legend that is not on screen.
  const parts: string[] = [];
  if ((stats?.unreviewed ?? 0) > 0) parts.push(`${stats?.unreviewed} unreviewed`);
  if ((stats?.recommended ?? 0) > 0) parts.push(`${stats?.recommended} recommended`);
  if ((stats?.managerReview ?? 0) > 0) parts.push(`${stats?.managerReview} with a manager`);

  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex w-full flex-col gap-0.5 border-b border-phx-line px-3 py-2 text-left transition-colors",
        active
          ? "border-l-2 border-l-phx-accent bg-phx-accent-soft"
          : "border-l-2 border-l-transparent hover:bg-phx-paper",
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="flex items-start gap-2">
        <span
          className={cn(
            "min-w-0 flex-1 break-words text-[13px] font-bold leading-tight",
            active ? "text-phx-accent-press" : "text-phx-ink",
          )}
        >
          {vacancy.jobTitle}
        </span>
        <Tally active={active}>{applicants}</Tally>
      </span>
      {place ? <span className="block text-[11px] leading-snug text-phx-ink-soft">{place}</span> : null}
      <span className="block text-[11px] leading-snug text-phx-ink-soft">
        {parts.length > 0 ? parts.join(" · ") : "No applicants yet"}
      </span>
    </button>
  );
}
