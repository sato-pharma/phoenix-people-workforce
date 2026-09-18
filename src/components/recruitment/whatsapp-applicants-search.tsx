"use client";

// Recruitment / ATS — WhatsApp Applicants: the search. A job title is chosen first, and that title's
// own WhatsApp questions then appear as filters. Every row is already on the page, so a filter only
// narrows the list and nothing waits on the server. What a row and a filter mean is decided in
// src/lib/recruitment/whatsapp-applicants.ts. This file only draws it.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

import { cairoDate } from "@/lib/format/cairo-datetime";
import { candidatePageHref } from "@/lib/recruitment/candidate-page-link";
import { screeningHref } from "@/lib/recruitment/screening-link";
import {
  applicantMatches,
  whatsAppApplicantSearchParam,
  whatsAppApplicantsPoolHref,
  type WhatsAppApplicantFilter,
  type WhatsAppApplicantRow,
  type WhatsAppApplicantsView,
} from "@/lib/recruitment/whatsapp-applicant-filters";

/** Rows drawn at once. A longer list shows a button for the next lot. */
const ROWS_PER_STEP = 100;

const labelClass = "block text-xs font-semibold uppercase tracking-wide text-slate-500";
const selectClass =
  "mt-1 h-8 w-full min-w-0 border border-slate-300 bg-white px-2 text-xs text-slate-900 focus:border-orange-500 focus:outline-none";

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

function ApplicantCell({ pool, row }: { pool: string; row: WhatsAppApplicantRow }) {
  return (
    <div className="min-w-0">
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

export function WhatsAppApplicantsSearch({ view }: { view: WhatsAppApplicantsView }) {
  // /recruitment, or /hr/recruitment in the HR sidebar. See whatsAppApplicantsPoolHref.
  const pool = whatsAppApplicantsPoolHref(usePathname());
  const [title, setTitle] = useState("");
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(ROWS_PER_STEP);

  const chosenTitle = view.titles.find((entry) => entry.value === title) ?? null;
  const filters = chosenTitle ? (view.filtersByTitle[chosenTitle.value] ?? []) : [];
  const matches = useMemo(
    () => view.rows.filter((row) => applicantMatches(row, title, selections)),
    [view.rows, title, selections],
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
      <p className="border border-slate-200 bg-white p-6 text-sm text-slate-600">
        Nobody has answered the WhatsApp questions yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <section className="border border-slate-200 bg-white px-4 py-4">
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
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <div className="flex items-baseline gap-1.5">
              <span className="font-bold uppercase tracking-wide text-slate-400">People</span>
              <span className="text-sm font-bold tabular-nums text-slate-800">
                {filtered ? `${matches.length} of ${chosenTitle.count}` : chosenTitle.count}
              </span>
            </div>
            {/* THE SAME PEOPLE ON THE SCREENING PAGE. The owner, 2026-09-18: "based on my filters, I
                can go to screening page and only show those I filtered." The link carries the search,
                and the screening page runs it again. A new tab, like a CV, so this list stays put. */}
            {matches.length > 0 ? (
              <Link
                className="border border-orange-600 bg-orange-600 px-2 py-1 text-xs font-semibold text-white hover:bg-orange-700"
                href={screeningHref(pool, { whatsapp: whatsAppApplicantSearchParam(title, selections) })}
                rel="noopener"
                target="_blank"
                title="Open exactly these people on the screening page, in a new tab"
              >
                Screen {matches.length === 1 ? "this CV" : `these ${matches.length} CVs`}
              </Link>
            ) : null}
            {filtered ? (
              <button
                className="border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
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

          {matches.length === 0 ? (
            <p className="border border-slate-200 bg-white p-6 text-sm text-slate-600">
              Nobody who applied for this title matches these filters.
            </p>
          ) : (
            <>
              <div className="hidden border border-slate-200 bg-white md:block">
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
                          <ApplicantCell pool={pool} row={row} />
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

              <ul className="divide-y divide-slate-100 border border-slate-200 bg-white md:hidden">
                {shown.map((row) => (
                  <li className="space-y-2.5 px-4 py-3 text-sm" key={row.key}>
                    <ApplicantCell pool={pool} row={row} />
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
                  className="w-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
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
