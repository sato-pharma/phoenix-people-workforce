"use client";

// Recruitment / ATS — the silent manager-engagement report, rendered.
//
// One table of managers: how many CVs each was sent, how many he OPENED, how many he still has not
// opened, and how many he ANSWERED. Expand a manager to see the CVs behind his numbers. The manager
// being measured never sees this — see the header of manager-cv-engagement.ts for why that matters
// and how it is kept true.
//
// Rendered in TWO shells from one component: the admin twin (Super Admin / CEO) and the portal twin
// (a National Sales Manager, scoped to his own line). The table is `hidden md:table` with a
// `md:hidden` card list beside it — the owner's rule is cards on a phone, never a table — and both
// spellings are shell-independent Tailwind, so the one component behaves the same in either shell.

import { useMemo, useState } from "react";

import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import type {
  ManagerCvEngagementCandidate,
  ManagerCvEngagementReport,
  ManagerCvEngagementRow,
} from "@/lib/recruitment/manager-cv-engagement";

// Every time this report shows a person is Cairo local time, never a raw UTC string — the owner's
// standing rule. Written here rather than imported across a domain boundary, matching the copy in
// intake-health-view.tsx one file over.
function cairoDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  return value.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

function StatTile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "plain" | "warn" }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className={`text-2xl font-semibold ${tone === "warn" ? "text-amber-600" : "text-slate-900"}`}>{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      {hint ? <div className="mt-1 text-xs text-slate-400">{hint}</div> : null}
    </div>
  );
}

/** A small coloured pill. Opened / answered states read at a glance without a legend. */
function Pill({ tone, children }: { tone: "green" | "slate" | "amber"; children: React.ReactNode }) {
  const palette =
    tone === "green"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700 ring-amber-200"
        : "bg-slate-100 text-slate-600 ring-slate-200";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${palette}`}>
      {children}
    </span>
  );
}

/**
 * A manager who has left. Shown beside the name so the reader knows a wall of unopened CVs sitting
 * here is stranded on somebody who is gone — those CVs need reassigning, not a nudge to the manager.
 * The label is whatever the directory recorded (Resigned / Terminated / …), with the last working day
 * when there is one. Kept on one line — the owner's rule is never to wrap a label.
 */
function InactiveBadge({ label, lastWorkingDate }: { label: string | null; lastWorkingDate: string | null }) {
  const suffix = lastWorkingDate ? ` · left ${cairoDate(lastWorkingDate)}` : "";
  return (
    <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-200">
      {(label || "Inactive") + suffix}
    </span>
  );
}

/**
 * The CVs behind one manager's numbers. ONE component, rendered in both the desktop expanded row and
 * the phone card — the same reasoning targets-workspace keeps its drill-down in a single
 * <SourceBreakdown />: two copies could drift and show a manager two different lists.
 */
function ManagerCandidateList({ candidates }: { candidates: readonly ManagerCvEngagementCandidate[] }) {
  if (candidates.length === 0) {
    return <p className="text-sm text-slate-500">No CVs recorded for this manager.</p>;
  }
  return (
    <ul className="divide-y divide-slate-100">
      {candidates.map((candidate) => (
        <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5" key={candidate.candidateId}>
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-800">{candidate.candidateName || "Unnamed candidate"}</div>
            <div className="mt-0.5 text-xs text-slate-500">
              {candidate.arrivedAt ? `Arrived ${cairoDate(candidate.arrivedAt)}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {candidate.opened ? <Pill tone="green">Opened</Pill> : <Pill tone="slate">Not opened</Pill>}
            {candidate.answered ? (
              <Pill tone="green">{candidateStatusLabel(candidate.status)}</Pill>
            ) : (
              <Pill tone="amber">Awaiting</Pill>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The counts for one manager, as a compact inline definition list — used inside the phone card. */
function ManagerCountStrip({ row }: { row: ManagerCvEngagementRow }) {
  const cells: Array<[string, number, string]> = [
    ["Received", row.received, "text-slate-700"],
    ["Opened", row.opened, "text-emerald-700"],
    ["Not opened", row.notOpened, row.notOpened > 0 ? "text-amber-700" : "text-slate-700"],
    ["Answered", row.answered, "text-slate-700"],
  ];
  return (
    <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {cells.map(([label, value, tone]) => (
        <div className="flex items-baseline gap-1.5" key={label}>
          <dt className="font-bold uppercase tracking-wide text-slate-400">{label}</dt>
          <dd className={`font-bold tabular-nums ${tone}`}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ManagerEngagementView({ report }: { report: ManagerCvEngagementReport }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return report.rows;
    return report.rows.filter((row) =>
      [row.managerName, row.managerJobTitle, row.managerArea, row.managerLine]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle)),
    );
  }, [query, report.rows]);

  const { totals } = report;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Managers" value={String(totals.managers)} hint={report.scoped ? "on your line" : "all lines"} />
        <StatTile label="CVs received" value={String(totals.received)} hint="in his My Candidates" />
        <StatTile label="Opened" value={String(totals.opened)} hint="manager opened the CV" />
        <StatTile label="Not opened" value={String(totals.notOpened)} hint="still unopened" tone={totals.notOpened > 0 ? "warn" : "plain"} />
        <StatTile label="Answered" value={String(totals.answered)} hint="a decision recorded" />
      </div>

      {/* The one thing that would be misread without it: a wall of "not opened" on old CVs. Opens are
          only counted from the day this feature shipped, so a CV a manager read on paper months ago
          reads as not-opened until he opens it in the app. Say so, once, at the top. */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <span className="font-semibold">Reading these numbers:</span> &ldquo;Received&rdquo; is every CV in the
        manager&rsquo;s <em>My Candidates</em> folder — the ones in his areas plus anything sent straight to him —
        not only what was hand-pushed. A CV counts as &ldquo;Opened&rdquo; once he opens it in the app from this
        feature&rsquo;s launch onward, so the large &ldquo;Not opened&rdquo; on older CVs is real: nothing recorded a
        manager opening a CV before tracking began. &ldquo;Answered&rdquo; has full history — it reads the
        candidate&rsquo;s recorded decision — so an older CV can show <em>not opened</em> yet <em>answered</em>.
      </div>

      <div>
        <label className="sr-only" htmlFor="manager-engagement-search">
          Filter managers
        </label>
        <input
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none sm:max-w-xs"
          id="manager-engagement-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by manager, area or line…"
          type="text"
          value={query}
        />
      </div>

      {report.rows.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
          No CVs have been sent to any manager{report.scoped ? " on your line" : ""} yet. As the recruitment team pushes
          CVs to managers, each manager and what he does with them will appear here.
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
          No manager matches &ldquo;{query}&rdquo;.
        </div>
      ) : (
        <>
          {/* ── Desktop: the full table (owner's rule) ── */}
          <div className="hidden rounded-lg border border-slate-200 bg-white md:block">
            <table className="hidden w-full text-sm md:table" data-portal-desktop-table>
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Manager</th>
                  <th className="px-4 py-3 font-medium">Area / Line</th>
                  <th className="px-4 py-3 text-right font-medium">Received</th>
                  <th className="px-4 py-3 text-right font-medium">Opened</th>
                  <th className="px-4 py-3 text-right font-medium">Not opened</th>
                  <th className="px-4 py-3 text-right font-medium">Answered</th>
                  <th className="px-4 py-3" aria-label="Expand" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = row.managerHrId;
                  const isOpen = Boolean(expanded[key]);
                  return (
                    <FragmentRow
                      key={key}
                      row={row}
                      isOpen={isOpen}
                      onToggle={() => toggle(key)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Mobile: cards, one per manager ── */}
          <div className="space-y-3 md:hidden">
            {rows.map((row) => {
              const key = row.managerHrId;
              const isOpen = Boolean(expanded[key]);
              return (
                <div className="rounded-lg border border-slate-200 bg-white p-4" key={key}>
                  <button
                    className="flex w-full items-start justify-between gap-3 text-left"
                    onClick={() => toggle(key)}
                    type="button"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">{row.managerName || row.managerHrId}</span>
                        {row.inactive ? (
                          <InactiveBadge label={row.employmentStatusLabel} lastWorkingDate={row.lastWorkingDate} />
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {[row.managerJobTitle, row.managerArea, row.managerLine].filter(Boolean).join(" · ") || "—"}
                      </div>
                      <ManagerCountStrip row={row} />
                    </div>
                    <span className="shrink-0 text-slate-400" aria-hidden>
                      {isOpen ? "▲" : "▼"}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="mt-3 border-t border-slate-100 pt-3">
                      <ManagerCandidateList candidates={row.candidates} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One manager's table row, plus its expanded detail row when open. A component rather than an inline
 * fragment so the two <tr>s share the open state cleanly and the detail's colSpan stays in one place.
 */
function FragmentRow({ row, isOpen, onToggle }: { row: ManagerCvEngagementRow; isOpen: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-800">{row.managerName || row.managerHrId}</span>
            {row.inactive ? <InactiveBadge label={row.employmentStatusLabel} lastWorkingDate={row.lastWorkingDate} /> : null}
          </div>
          {row.managerJobTitle ? <div className="text-xs text-slate-500">{row.managerJobTitle}</div> : null}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-slate-600">
          {[row.managerArea, row.managerLine].filter(Boolean).join(" / ") || "—"}
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-slate-800">{row.received}</td>
        <td className="px-4 py-3 text-right tabular-nums text-emerald-700">{row.opened}</td>
        <td className={`px-4 py-3 text-right tabular-nums ${row.notOpened > 0 ? "font-semibold text-amber-700" : "text-slate-500"}`}>
          {row.notOpened}
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-slate-800">{row.answered}</td>
        <td className="px-4 py-3 text-right text-slate-400">{isOpen ? "▲" : "▼"}</td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-slate-100 bg-slate-50/60 last:border-0">
          <td className="px-4 py-3" colSpan={7}>
            <ManagerCandidateList candidates={row.candidates} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
