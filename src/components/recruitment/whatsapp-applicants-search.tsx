"use client";

// Recruitment / ATS — WhatsApp Applicants: the search. A job title is chosen first, and that title's
// own WhatsApp questions then appear as filters. Every row is already on the page, so a filter only
// narrows the list and nothing waits on the server. What a row and a filter mean is decided in
// src/lib/recruitment/whatsapp-applicants.ts. This file only draws it.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

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
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { adminControlDepthClassName, adminPanelDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/** Rows drawn at once. A longer list shows a button for the next lot. */
const ROWS_PER_STEP = 100;

const labelClass = "block text-xs font-semibold uppercase tracking-wide text-slate-500";
const selectClass =
  `${phxSelectClassName} mt-1 min-w-0`;

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
    <div className="min-w-0">
      <label className="block break-words text-xs font-semibold text-slate-700" dir="auto" htmlFor={id}>
        {filter.label}
      </label>
      {filter.note ? <p className="break-words text-xs text-slate-400">{filter.note}</p> : null}
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
  new: "border-sky-300 bg-sky-50",
  rejected: "border-rose-300 bg-rose-50",
  shortlisted: "border-emerald-300 bg-emerald-50",
};

/** The matching button, filled in, once that is the candidate's current status. */
const QUICK_DECISION_ACTIVE_BUTTON_CLASS: Record<QuickDecisionStatus, string> = {
  new: "border-sky-600 bg-sky-600 text-white",
  rejected: "border-rose-600 bg-rose-600 text-white",
  shortlisted: "border-emerald-600 bg-emerald-600 text-white",
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
    <div className="mt-2 min-w-0">
      <div aria-label={`Mark ${name}`} className="flex flex-wrap gap-1.5" role="group">
        {QUICK_DECISIONS.map((option) => {
          const active = isQuickDecisionStatus(status) && status === option.status;
          return (
            <button
              className={`border px-2 py-0.5 text-xs font-semibold disabled:opacity-60 ${
                active
                  ? QUICK_DECISION_ACTIVE_BUTTON_CLASS[option.status]
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
              }`}
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
      {error ? <p className="mt-1 break-words text-xs text-rose-600">{error}</p> : null}
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
  const boxClass = isQuickDecisionStatus(row.status) ? QUICK_DECISION_BOX_CLASS[row.status] : "border-transparent";
  return (
    <div className={`min-w-0 border p-2 ${boxClass}`}>
      {/* The name opens everything on file for this person — their own page, which links on to
          screening for a decision. A new tab, so the filtered list is still here when it is closed. */}
      <Link
        className="block break-words font-semibold text-slate-900 hover:text-orange-600 hover:underline"
        dir="auto"
        href={candidatePageHref(pool, row.candidateId)}
        prefetch={false}
        rel="noopener"
        target="_blank"
      >
        {row.name}
      </Link>
      <span className="mt-0.5 block break-words text-xs text-slate-500">
        {row.statusLabel} · Applied {cairoDate(row.appliedAt)}
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
        <span className="block text-slate-500">Not known</span>
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
      <span className="block break-words text-slate-900" dir="auto">
        {row.region.label}
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
    <dl className="min-w-0 space-y-1.5">
      {row.answers.map((answer) => (
        <div className="min-w-0" key={answer.key}>
          <dt className="break-words text-xs text-slate-500" dir="auto">
            {answer.question}
          </dt>
          <dd className="break-words text-sm font-medium text-slate-900" dir="auto">
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
      <span className="inline-block border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-800">
        Answered all
      </span>
    );
  }
  return (
    <div className="min-w-0">
      <span className="inline-block border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
        Did not answer all
      </span>
      {row.waitingOn ? (
        <span className="mt-1 block break-words text-xs text-slate-600" dir="auto">
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
      <p className={`border border-slate-200 bg-white p-6 text-sm text-slate-600 ${adminSoftDepthClassName}`}>
        Nobody has answered the WhatsApp questions yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <section className={`border border-slate-200 bg-white px-4 py-4 ${adminSoftDepthClassName}`}>
        <label className={labelClass} htmlFor="whatsapp-applicants-title">
          Job title
        </label>
        <select
          className={`${selectClass} md:max-w-md`}
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

        {filters.length > 0 ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
        ) : null}
      </section>

      {chosenTitle ? (
        <section className="space-y-3">
          <CandidateDecisionTabStrip
            active={decisionTab}
            counts={decisionCounts}
            onSelect={(tab) => {
              setDecisionTab(tab);
              setLimit(ROWS_PER_STEP);
            }}
          />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <div className="flex items-baseline gap-1.5">
              <span className="font-bold uppercase tracking-wide text-slate-400">People</span>
              <span className="text-sm font-bold tabular-nums text-slate-800">
                {filtered ? `${matches.length} of ${tabTotal}` : matches.length}
              </span>
            </div>
            {/* THE SAME PEOPLE ON THE SCREENING PAGE. The owner, 2026-09-18: "based on my filters, I
                can go to screening page and only show those I filtered." The link carries the search,
                and the screening page runs it again. A new tab, like a CV, so this list stays put. */}
            {matches.length > 0 ? (
              <Link
                className="border border-orange-600 bg-orange-600 px-2 py-1 text-xs font-semibold text-white hover:bg-orange-700"
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
                className={`border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 ${adminControlDepthClassName}`}
                onClick={() => {
                  setSelections({});
                  setLimit(ROWS_PER_STEP);
                }}
                type="button"
              >
                Clear filters
              </button>
            ) : null}
          </div>

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

          {matches.length === 0 ? (
            <p className={`border border-slate-200 bg-white p-6 text-sm text-slate-600 ${adminSoftDepthClassName}`}>
              {emptyMessage(filtered, decisionTab)}
            </p>
          ) : (
            <>
              <div className={`hidden border border-slate-200 bg-white md:block ${adminPanelDepthClassName}`}>
                <table className="w-full table-fixed text-left text-sm">
                  <colgroup>
                    <col className="w-[24%]" />
                    <col className="w-[18%]" />
                    <col className="w-[40%]" />
                    <col className="w-[18%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2">Applicant</th>
                      <th className="px-3 py-2">Region</th>
                      <th className="px-3 py-2">Their answers</th>
                      <th className="px-3 py-2">Answered all?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row) => (
                      <tr className="border-b border-slate-100 align-top last:border-b-0" key={row.key}>
                        <td className="px-3 py-3">
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
                        <td className="px-3 py-3">
                          <ProgressCell row={row} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className={`divide-y divide-slate-100 border border-slate-200 bg-white md:hidden ${adminPanelDepthClassName}`}>
                {shown.map((row) => (
                  <li className="space-y-2.5 px-4 py-3 text-sm" key={row.key}>
                    <ApplicantCell
                      canDecide={canDecide}
                      onDecided={onDecided}
                      pool={pool}
                      row={row}
                      titleLabel={chosenTitle?.label ?? null}
                    />
                    <div>
                      <span className={labelClass}>Region</span>
                      <div className="mt-0.5">
                        <RegionCell row={row} />
                      </div>
                    </div>
                    <AnswerList row={row} />
                    <ProgressCell row={row} />
                  </li>
                ))}
              </ul>

              {matches.length > shown.length ? (
                <button
                  className={`w-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 ${adminControlDepthClassName}`}
                  onClick={() => setLimit((current) => current + ROWS_PER_STEP)}
                  type="button"
                >
                  Show {Math.min(ROWS_PER_STEP, matches.length - shown.length)} more ({matches.length - shown.length} not
                  shown yet)
                </button>
              ) : null}
            </>
          )}
        </section>
      ) : (
        <p className="text-sm text-slate-500">Choose a job title to see who applied for it.</p>
      )}
    </div>
  );
}
