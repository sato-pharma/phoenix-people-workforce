"use client";

// Recruitment / ATS — WhatsApp Applicants: the search. A job title is chosen first, and that title's
// own WhatsApp questions then appear as filters. Every row is already on the page, so a filter only
// narrows the list and nothing waits on the server. What a row and a filter mean is decided in
// src/lib/recruitment/whatsapp-applicants.ts. This file only draws it.
//
// THE LOOK (owner, 2026-10-19, the full-module premium sweep): the counts are the module's KPI strip,
// the job title and its question filters sit in the recessed filter tray, and the people found are one
// panel under the house dark band — a fixed-layout table on a desktop, one card per person on a phone.
// Every count on the strip is worked out from the one read the page already loaded, and follows a
// decision made on this page the moment it is saved.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import {
  BadgeCheck,
  Briefcase,
  CheckCircle2,
  Hourglass,
  Inbox,
  ListChecks,
  MapPin,
  MessageSquareText,
  SlidersHorizontal,
  UsersRound,
} from "lucide-react";

import { CandidateDecisionTabStrip } from "@/components/recruitment/candidate-decision-tab-strip";
import { ScheduleInterviewButton } from "@/components/recruitment/interview-calendar/schedule-interview-button";
import { WhatsAppApplicationActions } from "@/components/recruitment/whatsapp-application-actions";
import { cairoDate } from "@/lib/format/cairo-datetime";
import {
  candidateDecisionTabLabels,
  candidateMatchesDecisionTab,
  countCandidatesByDecisionTab,
  DEFAULT_CANDIDATE_DECISION_TAB,
  statusFilterForDecisionTab,
  type CandidateDecisionTab,
} from "@/lib/recruitment/candidate-decision-tabs";
import { candidatePageHref } from "@/lib/recruitment/candidate-page-link";
import { candidateStatusLabels } from "@/lib/recruitment/candidate-status";
import { screeningHref } from "@/lib/recruitment/screening-link";
import {
  applicantMatches,
  whatsAppApplicantSearchParam,
  whatsAppApplicantsPoolHref,
  type WhatsAppApplicantFilter,
  type WhatsAppApplicantRow,
  type WhatsAppApplicantsView,
} from "@/lib/recruitment/whatsapp-applicant-filters";
import {
  phxButtonApproveDenseClassName,
  phxButtonDangerDenseClassName,
  phxButtonGhostClassName,
  phxLabelClassName,
  phxLabelTextClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { adminControlDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  RecruitmentEmptyState,
  RecruitmentKpiStrip,
  RecruitmentPanel,
  RecruitmentPill,
  recruitmentToolbarClassName,
} from "@/components/recruitment/recruitment-premium";
import { cn } from "@/lib/utils";

/** Rows drawn at once. A longer list shows a button for the next lot. */
const ROWS_PER_STEP = 100;

const selectClass =
  `${phxSelectClassName} min-w-0`;

function FilterSelect({
  filter,
  id,
  onChange,
  value,
}: {
  filter: WhatsAppApplicantFilter;
  id: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="min-w-0 grow basis-56">
      <label className="mb-1 block break-words text-xs font-bold text-slate-700" dir="auto" htmlFor={id}>
        {filter.label}
      </label>
      {filter.note ? <p className="mb-1 break-words text-xs text-slate-400">{filter.note}</p> : null}
      <select className={selectClass} id={id} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">Any</option>
        {filter.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The three verdicts this page itself can set, straight from the list (owner, request of this
 * page: "make any sign … shortlist or reject or pending on any CV"). The candidate can carry any of
 * the six statuses (see candidate-status.ts) — the other three (Back-up, Sent to manager, Hired)
 * are decisions with their own side effects and stay on the screening page — but only these three
 * are a plain, reversible triage a person makes reading down a list, so only these three get a
 * button and a highlighted box here.
 */
const QUICK_DECISIONS = [
  { label: "Shortlist", status: "shortlisted" as const },
  { label: "Reject", status: "rejected" as const },
  { label: "Pending", status: "new" as const },
];
type QuickDecisionStatus = (typeof QUICK_DECISIONS)[number]["status"];

function isQuickDecisionStatus(value: string): value is QuickDecisionStatus {
  return QUICK_DECISIONS.some((option) => option.status === value);
}

/** The box around the name: green for Shortlisted, red for Rejected, light blue for Pending. */
const QUICK_DECISION_BOX_CLASS: Record<QuickDecisionStatus, string> = {
  new: "border-sky-300 border-l-sky-500 bg-sky-50/70",
  rejected: "border-rose-300 border-l-rose-500 bg-rose-50/70",
  shortlisted: "border-emerald-300 border-l-emerald-500 bg-emerald-50/70",
};

/**
 * The matching button, filled in, once that is the candidate's current status. Shortlist and Reject
 * wear the form kit's decision pair (colour only, so the dense size below is kept); Pending keeps its
 * light blue, the colour of the box it puts the name in.
 */
const QUICK_DECISION_ACTIVE_BUTTON_CLASS: Record<QuickDecisionStatus, string> = {
  new: "border-sky-600 bg-sky-600 text-white",
  rejected: phxButtonDangerDenseClassName,
  shortlisted: phxButtonApproveDenseClassName,
};

/**
 * Shortlist / Reject / Pending, right on this row. Writes through the same route the screening
 * page's own decision buttons use — `PATCH /api/recruitment/candidates/[id]/status` — so the same
 * server-side authority and event trail apply whichever screen made the call.
 */
function WhatsAppApplicantDecisionButtons({
  candidateId,
  name,
  onDecided,
  status,
}: {
  candidateId: string;
  name: string;
  onDecided: (candidateId: string, status: QuickDecisionStatus) => void;
  status: string;
}) {
  const [pending, setPending] = useState<QuickDecisionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setDecision = async (next: QuickDecisionStatus) => {
    if (pending) return;
    setPending(next);
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${candidateId}/status`, {
        body: JSON.stringify({ status: next }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? "Could not save that decision.");
      }
      onDecided(candidateId, next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save that decision.");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="mt-2.5 min-w-0">
      <div aria-label={`Mark ${name}`} className="flex flex-wrap gap-1" role="group">
        {QUICK_DECISIONS.map((option) => {
          const active = isQuickDecisionStatus(status) && status === option.status;
          return (
            <button
              className={cn(
                "border px-2.5 py-1 text-xs font-bold transition disabled:opacity-60",
                active
                  ? QUICK_DECISION_ACTIVE_BUTTON_CLASS[option.status]
                  : `border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-900 ${adminControlDepthClassName} disabled:shadow-none`,
              )}
              disabled={pending !== null}
              key={option.status}
              onClick={() => void setDecision(option.status)}
              type="button"
            >
              {pending === option.status ? "Saving…" : option.label}
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="mt-1.5 break-words border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ApplicantCell({
  canDecide,
  onDecided,
  pool,
  row,
  titleLabel,
}: {
  canDecide: boolean;
  onDecided: (candidateId: string, status: QuickDecisionStatus) => void;
  pool: string;
  row: WhatsAppApplicantRow;
  titleLabel: string | null;
}) {
  const boxClass = isQuickDecisionStatus(row.status)
    ? QUICK_DECISION_BOX_CLASS[row.status]
    : "border-slate-200 border-l-slate-300 bg-white";
  return (
    <div className={`min-w-0 border border-l-[3px] p-2.5 ${boxClass}`}>
      {/* The name opens everything on file for this person — their own page, which links on to
          screening for a decision. A new tab, so the filtered list is still here when it is closed. */}
      <Link
        className="block break-words text-sm font-black text-slate-950 hover:text-orange-600 hover:underline"
        dir="auto"
        href={candidatePageHref(pool, row.candidateId)}
        prefetch={false}
        rel="noopener"
        target="_blank"
      >
        {row.name}
      </Link>
      <span className="mt-0.5 block break-words text-xs text-slate-500">
        <span className="font-bold text-slate-700">{row.statusLabel}</span> · Applied {cairoDate(row.appliedAt)}
      </span>
      {row.typedTitle ? (
        <span className="mt-0.5 block break-words text-xs text-slate-500" dir="auto">
          Typed job title: {row.typedTitle}
        </span>
      ) : null}
      {/* Mark them straight from this list (owner: "make any sign … shortlist or reject or pending on
          any CV"). Absent for a reader who can see candidates but cannot decide them. */}
      {canDecide ? (
        <WhatsAppApplicantDecisionButtons
          candidateId={row.candidateId}
          name={row.name}
          onDecided={onDecided}
          status={row.status}
        />
      ) : null}
      {/* Book them straight from the list (owner, 2026-09-18: "from WhatsApp application screening
          tab … any CV"). Absent for anyone the interview calendar is not shared with as an editor. */}
      <ScheduleInterviewButton
        candidate={{ id: row.candidateId, jobTitle: row.typedTitle ?? titleLabel, name: row.name }}
        className="mt-2"
      />
      {/* The CV as she sent it plus one page of every WhatsApp question and answer (owner, 2026-09-19).
          Added under what the cell already held; the CV's own download is not touched. */}
      <WhatsAppApplicationActions applicantName={row.name} className="mt-2" sessionId={row.sessionId} />
    </div>
  );
}

function RegionCell({ row }: { row: WhatsAppApplicantRow }) {
  if (!row.region) {
    return (
      <div className="min-w-0">
        <span className="block text-sm font-semibold text-slate-500">Not known</span>
        <span className="mt-0.5 block break-words text-xs text-slate-400">
          Neither their WhatsApp answer nor their CV places them in a region
        </span>
      </div>
    );
  }
  const sourceTone =
    row.region.source === "whatsapp"
      ? "text-emerald-700"
      : row.region.source === "cv"
        ? "text-slate-500"
        : "text-amber-700";
  return (
    <div className="min-w-0">
      <span className="flex items-start gap-1.5 break-words text-sm font-bold text-slate-900" dir="auto">
        <MapPin aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 flex-none text-orange-500" />
        <span className="min-w-0 break-words">{row.region.label}</span>
      </span>
      <span className={`mt-0.5 block break-words text-xs ${sourceTone}`} dir="auto">
        {row.region.sourceLine}
      </span>
    </div>
  );
}

function AnswerList({ row }: { row: WhatsAppApplicantRow }) {
  if (row.answers.length === 0) {
    return <span className="text-xs text-slate-400">No answers after the job title</span>;
  }
  return (
    <dl className="min-w-0 divide-y divide-slate-100">
      {row.answers.map((answer) => (
        <div className="min-w-0 py-1.5 first:pt-0 last:pb-0" key={answer.key}>
          <dt className="break-words text-xs text-slate-500" dir="auto">
            {answer.question}
          </dt>
          <dd className="break-words text-sm font-bold text-slate-900" dir="auto">
            {answer.answer}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ProgressCell({ row }: { row: WhatsAppApplicantRow }) {
  if (row.finished) {
    return (
      <RecruitmentPill tone="emerald">
        <CheckCircle2 aria-hidden="true" className="h-3 w-3" />
        Answered all
      </RecruitmentPill>
    );
  }
  return (
    <div className="min-w-0">
      <RecruitmentPill tone="amber">
        <Hourglass aria-hidden="true" className="h-3 w-3" />
        Did not answer all
      </RecruitmentPill>
      {row.waitingOn ? (
        <span className="mt-1.5 block break-words text-xs text-slate-600" dir="auto">
          {row.stillOpen ? "Waiting for their answer to:" : "Stopped at:"} {row.waitingOn}
        </span>
      ) : null}
      {row.stillOpen ? (
        <span className="mt-0.5 block break-words text-xs text-slate-500">Their chat is still open, so they can still answer.</span>
      ) : null}
    </div>
  );
}

/** What an empty list says: which pile, and whether the filters are why. */
function emptyMessage(filtered: boolean, tab: CandidateDecisionTab): string {
  if (tab === "all") {
    return filtered ? "Nobody who applied for this title matches these filters." : "Nobody who applied for this title is listed.";
  }
  const pile = `the “${candidateDecisionTabLabels[tab]}” tab`;
  return filtered ? `Nobody on ${pile} matches these filters.` : `Nobody who applied for this title is on ${pile}.`;
}

export function WhatsAppApplicantsSearch({ canDecide, view }: { canDecide: boolean; view: WhatsAppApplicantsView }) {
  // /recruitment, or /hr/recruitment in the HR sidebar. See whatsAppApplicantsPoolHref.
  const pool = whatsAppApplicantsPoolHref(usePathname());
  const [title, setTitle] = useState("");
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(ROWS_PER_STEP);
  // THE DECISION TAB — the owner, 2026-09-18: "in any screening page you must show did not decide
  // yet ... shortlisted ... rejected", so a new CV is easy to see. Opens on "Not decided yet", like
  // every screen that lists CVs, and stays put when the job title changes: it is a choice of pile,
  // not of search.
  const [decisionTab, setDecisionTab] = useState<CandidateDecisionTab>(DEFAULT_CANDIDATE_DECISION_TAB);
  // A DECISION MADE ON THIS PAGE, keyed by candidate id, laid over `view.rows` — the same shape as
  // the screening page's own `decided` map. `view` is the one server read this page loads; without
  // this, pressing Shortlist would write through but the tab strip and this list would keep
  // reading the status it had a moment ago until the page is reloaded.
  const [decisions, setDecisions] = useState<Record<string, QuickDecisionStatus>>({});
  const onDecided = (candidateId: string, status: QuickDecisionStatus) =>
    setDecisions((current) => ({ ...current, [candidateId]: status }));
  const rows = useMemo(
    () =>
      Object.keys(decisions).length === 0
        ? view.rows
        : view.rows.map((row) =>
            row.candidateId in decisions
              ? { ...row, status: decisions[row.candidateId], statusLabel: candidateStatusLabels[decisions[row.candidateId]] }
              : row,
          ),
    [decisions, view.rows],
  );

  const chosenTitle = view.titles.find((entry) => entry.value === title) ?? null;
  const filters = chosenTitle ? (view.filtersByTitle[chosenTitle.value] ?? []) : [];
  // Everyone the title and the filters find, across every pile. The tab strip counts these, so each
  // number on it is the list that tab opens.
  const acrossTabs = useMemo(
    () => rows.filter((row) => applicantMatches(row, title, selections)),
    [rows, title, selections],
  );
  const decisionCounts = useMemo(() => countCandidatesByDecisionTab(acrossTabs), [acrossTabs]);
  const matches = useMemo(
    () => acrossTabs.filter((row) => candidateMatchesDecisionTab(row.status, decisionTab)),
    [acrossTabs, decisionTab],
  );
  // The tab's own pile under this title before any filter, for "12 of 40".
  const tabTotal = useMemo(
    () => rows.filter((row) => row.titleValue === title && candidateMatchesDecisionTab(row.status, decisionTab)).length,
    [rows, title, decisionTab],
  );
  // The strip's counts: the whole list this page loaded, with any decision made here laid over it.
  const allCounts = useMemo(() => countCandidatesByDecisionTab(rows), [rows]);
  const answeredAll = useMemo(() => rows.filter((row) => row.finished).length, [rows]);
  const shown = matches.slice(0, limit);
  const filtered = Object.values(selections).some(Boolean);

  const chooseTitle = (value: string) => {
    setTitle(value);
    setSelections({});
    setLimit(ROWS_PER_STEP);
  };
  const chooseFilter = (key: string, value: string) => {
    setSelections((current) => ({ ...current, [key]: value }));
    setLimit(ROWS_PER_STEP);
  };

  if (view.titles.length === 0) {
    return (
      <RecruitmentPanel icon={<MessageSquareText aria-hidden="true" className="h-4 w-4" />} title="WhatsApp applicants">
        <RecruitmentEmptyState
          icon={<Inbox aria-hidden="true" className="h-5 w-5" />}
          message="Nobody has answered the WhatsApp questions yet."
          title="No applicants yet"
        />
      </RecruitmentPanel>
    );
  }

  return (
    <div className="space-y-5">
      <RecruitmentKpiStrip
        items={[
          {
            description: "who started the WhatsApp questions",
            icon: <UsersRound aria-hidden="true" className="h-4 w-4" />,
            label: "Applications",
            tone: "orange",
            value: <span className="tabular-nums">{rows.length}</span>,
          },
          {
            description: "waiting for a first decision",
            icon: <Hourglass aria-hidden="true" className="h-4 w-4" />,
            label: "Not decided yet",
            tone: "blue",
            value: <span className="tabular-nums">{allCounts.new}</span>,
          },
          {
            description: "on the shortlist",
            icon: <BadgeCheck aria-hidden="true" className="h-4 w-4" />,
            label: "Shortlisted",
            tone: "emerald",
            value: <span className="tabular-nums">{allCounts.shortlisted}</span>,
          },
          {
            description: "answered every question",
            icon: <ListChecks aria-hidden="true" className="h-4 w-4" />,
            label: "Answered all",
            tone: "violet",
            value: <span className="tabular-nums">{answeredAll}</span>,
          },
        ]}
      />

      <section aria-label="Search" className={recruitmentToolbarClassName}>
        <div className="w-full min-w-0 md:max-w-md">
          <label className={phxLabelClassName} htmlFor="whatsapp-applicants-title">
            Job title
          </label>
          <select
            className={selectClass}
            id="whatsapp-applicants-title"
            onChange={(event) => chooseTitle(event.target.value)}
            value={title}
          >
            <option value="">Choose a job title</option>
            {view.titles.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label} ({entry.count})
              </option>
            ))}
          </select>
        </div>

        {filters.length > 0 ? (
          <div className="w-full min-w-0 border-t border-slate-200 pt-3">
            <p className={cn("mb-2 flex items-center gap-1.5", phxLabelTextClassName)}>
              <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5 text-orange-500" />
              Their answers
            </p>
            <div className="flex flex-wrap items-end gap-3">
              {filters.map((filter, index) => (
                <FilterSelect
                  filter={filter}
                  id={`whatsapp-applicants-filter-${index}`}
                  key={filter.key}
                  onChange={(value) => chooseFilter(filter.key, value)}
                  value={selections[filter.key] ?? ""}
                />
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {chosenTitle ? (
        <RecruitmentPanel
          actions={
            <>
              {/* THE SAME PEOPLE ON THE SCREENING PAGE. The owner, 2026-09-18: "based on my filters, I
                  can go to screening page and only show those I filtered." The link carries the search,
                  and the screening page runs it again. A new tab, like a CV, so this list stays put. */}
              {matches.length > 0 ? (
                <Link
                  className="inline-flex items-center gap-1.5 border border-orange-500 bg-orange-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-orange-700"
                  // The tab travels too, so the screening page opens on the same pile this list shows.
                  href={screeningHref(pool, {
                    status: statusFilterForDecisionTab(decisionTab),
                    whatsapp: whatsAppApplicantSearchParam(title, selections),
                  })}
                  rel="noopener"
                  target="_blank"
                  title="Open exactly these people on the screening page, in a new tab"
                >
                  Screen {matches.length === 1 ? "this CV" : `these ${matches.length} CVs`}
                </Link>
              ) : null}
              {filtered ? (
                <button
                  className="border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-white/20"
                  onClick={() => {
                    setSelections({});
                    setLimit(ROWS_PER_STEP);
                  }}
                  type="button"
                >
                  Clear filters
                </button>
              ) : null}
            </>
          }
          count={filtered ? `${matches.length} of ${tabTotal}` : matches.length}
          icon={<Briefcase aria-hidden="true" className="h-4 w-4" />}
          title={<span dir="auto">{chosenTitle.label}</span>}
        >
          <div className="space-y-3 px-4 pt-4 sm:px-5">
            <CandidateDecisionTabStrip
              active={decisionTab}
              counts={decisionCounts}
              onSelect={(tab) => {
                setDecisionTab(tab);
                setLimit(ROWS_PER_STEP);
              }}
            />

            {chosenTitle.unlinked > 0 ? (
              <p className="break-words text-xs text-slate-500">
                {chosenTitle.unlinked === 1 ? "1 more person" : `${chosenTitle.unlinked} more people`} answered for this
                title, but their chat could not be matched to a CV in the system, so they are not listed.
              </p>
            ) : null}

            {chosenTitle.inFolders > 0 ? (
              <p className="break-words text-xs text-slate-500">
                {chosenTitle.inFolders === 1 ? "1 more person" : `${chosenTitle.inFolders} more people`} applied for this
                title, but their CV has been moved into a folder on the Folders tab, so they are shown only inside that folder.
              </p>
            ) : null}
          </div>

          {matches.length === 0 ? (
            <RecruitmentEmptyState
              icon={<UsersRound aria-hidden="true" className="h-5 w-5" />}
              message={emptyMessage(filtered, decisionTab)}
              title="Nobody to show"
            />
          ) : (
            <>
              <div className="mt-4 hidden border-t border-slate-200 md:block">
                <table className="w-full table-fixed text-left text-sm">
                  <colgroup>
                    <col className="w-[26%]" />
                    <col className="w-[18%]" />
                    <col className="w-[38%]" />
                    <col className="w-[18%]" />
                  </colgroup>
                  <thead className="bg-slate-50">
                    <tr className={cn("border-b border-slate-200", phxLabelTextClassName)}>
                      <th className="px-4 py-2.5" scope="col">Applicant</th>
                      <th className="px-3 py-2.5" scope="col">Region</th>
                      <th className="px-3 py-2.5" scope="col">Their answers</th>
                      <th className="px-4 py-2.5" scope="col">Answered all?</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shown.map((row) => (
                      <tr className="align-top transition-colors hover:bg-slate-50/60" key={row.key}>
                        <td className="px-4 py-3">
                          <ApplicantCell
                            canDecide={canDecide}
                            onDecided={onDecided}
                            pool={pool}
                            row={row}
                            titleLabel={chosenTitle?.label ?? null}
                          />
                        </td>
                        <td className="px-3 py-3">
                          <RegionCell row={row} />
                        </td>
                        <td className="px-3 py-3">
                          <AnswerList row={row} />
                        </td>
                        <td className="px-4 py-3">
                          <ProgressCell row={row} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-200 md:hidden">
                {shown.map((row) => (
                  <li className="space-y-3 px-4 py-4 text-sm" key={row.key}>
                    <ApplicantCell
                      canDecide={canDecide}
                      onDecided={onDecided}
                      pool={pool}
                      row={row}
                      titleLabel={chosenTitle?.label ?? null}
                    />
                    <div>
                      <span className={phxLabelClassName}>Region</span>
                      <RegionCell row={row} />
                    </div>
                    <div>
                      <span className={phxLabelClassName}>Their answers</span>
                      <AnswerList row={row} />
                    </div>
                    <ProgressCell row={row} />
                  </li>
                ))}
              </ul>

              {matches.length > shown.length ? (
                <div className="border-t border-slate-200 p-4 sm:px-5">
                  <button
                    className={cn(phxButtonGhostClassName, "w-full justify-center text-xs")}
                    onClick={() => setLimit((current) => current + ROWS_PER_STEP)}
                    type="button"
                  >
                    Show {Math.min(ROWS_PER_STEP, matches.length - shown.length)} more ({matches.length - shown.length} not
                    shown yet)
                  </button>
                </div>
              ) : null}
            </>
          )}
        </RecruitmentPanel>
      ) : (
        <RecruitmentPanel icon={<Briefcase aria-hidden="true" className="h-4 w-4" />} title="Applicants">
          <RecruitmentEmptyState
            icon={<Briefcase aria-hidden="true" className="h-5 w-5" />}
            message="Choose a job title to see who applied for it."
            title="Choose a job title"
          />
        </RecruitmentPanel>
      )}
    </div>
  );
}
