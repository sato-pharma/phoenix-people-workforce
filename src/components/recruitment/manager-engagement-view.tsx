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
//
// THE PREMIUM LOOK (owner, 2026-10-19, the full Recruitment sweep) comes from the module's one kit,
// `recruitment-premium.tsx`: the five totals are a `RecruitmentKpiStrip`, the filter and the export
// sit in the recessed toolbar tray, the managers are one `RecruitmentPanel`, and every state is a
// `RecruitmentPill`. The desktop table is `table-fixed` with a `<colgroup>`, so a long area name
// wraps inside its column instead of pushing the page sideways.

import {
  AlertTriangle,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  Inbox,
  Loader2,
  MessageSquareCheck,
  Search,
  UsersRound,
} from "lucide-react";
import { useMemo, useState } from "react";

import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import { ScheduleInterviewButton } from "@/components/recruitment/interview-calendar/schedule-interview-button";
import {
  RecruitmentEmptyState,
  RecruitmentKpiStrip,
  RecruitmentPanel,
  RecruitmentPill,
  recruitmentToolbarClassName,
} from "@/components/recruitment/recruitment-premium";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import type {
  ManagerCvEngagementCandidate,
  ManagerCvEngagementReport,
  ManagerCvEngagementRow,
} from "@/lib/recruitment/manager-cv-engagement";
// The manager filter, the area grouping, the inactive wording and the Cairo date all come from ONE
// module, shared with the XLSX export — the owner's rule is that an export matches the screen, and a
// second copy of any of them is how the file starts answering a different question than this page.
import {
  cairoEngagementDate,
  filterManagerEngagementRows,
  groupEngagementCandidatesByArea,
  managerInactiveText,
} from "@/lib/recruitment/manager-engagement-presentation";
import { managerLabel } from "@/lib/recruitment/person-labels";
import { phxFieldClassName, phxLabelClassName } from "@/components/ui/form-tokens";
import { adminChipDepthClassName, adminControlDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { cn } from "@/lib/utils";

/** One row of the report's own file-list response — the CV file is the one whose kind is "cv". */
type CandidateFileSummary = { id: string; fileName: string; kind: string; mimeType: string | null };

/**
 * A manager who has left. Shown beside the name so the reader knows a wall of unopened CVs sitting
 * here is stranded on somebody who is gone — those CVs need reassigning, not a nudge to the manager.
 * The label is whatever the directory recorded (Resigned / Terminated / …), with the last working day
 * when there is one. A rose `RecruitmentPill`, the module's one spelling of a status; on a phone it
 * may wrap rather than push the card sideways — the fits-the-screen rule wins over a one-line label.
 */
function InactiveBadge({ label, lastWorkingDate }: { label: string | null; lastWorkingDate: string | null }) {
  return <RecruitmentPill tone="rose">{managerInactiveText(label, lastWorkingDate)}</RecruitmentPill>;
}

/**
 * The candidate's name, as the button that pops the CV up in place.
 *
 * The owner asked for exactly this on 2026-09-01: press the name and the CV appears without the page
 * moving. CvPreviewModal is a fixed full-screen overlay (createPortal to <body>), so nothing on the
 * report shifts or scrolls under it. The files are fetched only on the FIRST click — a report can list
 * hundreds of CVs, and fetching each one's file list on render is the fifteen-second stall
 * CandidateCvActions documents next door.
 *
 * It fetches from the report's OWN file routes, which record no open — see the note in
 * manager-cv-engagement.ts on why oversight must never count as the manager opening his own CV.
 */
function EngagementCvName({ candidate }: { candidate: ManagerCvEngagementCandidate }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<CandidateFileSummary | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "none" | "error">("idle");

  const label = candidate.candidateName || "Unnamed candidate";

  async function handleClick() {
    if (state === "loading") return;
    if (file) {
      setOpen(true);
      return;
    }
    setState("loading");
    try {
      const res = await fetch(`/api/recruitment/manager-engagement/candidates/${candidate.candidateId}/files`);
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error("files unavailable");
      const files = Array.isArray(data.files) ? (data.files as CandidateFileSummary[]) : [];
      const cv = files.find((entry) => entry.kind === "cv") ?? null;
      if (!cv) {
        setState("none");
        return;
      }
      setFile(cv);
      setState("idle");
      setOpen(true);
    } catch {
      setState("error");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <button
        className="break-words text-left text-sm font-bold text-slate-900 underline-offset-2 hover:text-orange-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-60"
        disabled={state === "loading"}
        onClick={handleClick}
        type="button"
      >
        {label}
      </button>
      {state === "loading" ? (
        <span className="inline-flex items-center gap-1 text-xs text-slate-400">
          <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
          Opening…
        </span>
      ) : null}
      {state === "none" ? <span className="text-xs text-slate-400">No CV file on record</span> : null}
      {state === "error" ? <span className="text-xs text-rose-500">Couldn&rsquo;t open the CV</span> : null}
      {open && file ? (
        <CvPreviewModal
          downloadUrl={`/api/recruitment/manager-engagement/candidates/${candidate.candidateId}/files/${file.id}`}
          fileName={file.fileName}
          headerActions={
            candidate.candidateName ? (
              <ScheduleInterviewButton candidate={{ id: candidate.candidateId, name: candidate.candidateName }} />
            ) : null
          }
          mimeType={file.mimeType}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * The CVs behind one manager's numbers, GROUPED BY AREA. ONE component, rendered in both the desktop
 * expanded row and the phone card — the same reasoning targets-workspace keeps its drill-down in a
 * single <SourceBreakdown />: two copies could drift and show a manager two different lists.
 *
 * The owner asked (2026-09-01) that the expanded list be grouped by the CV's area. The candidates
 * already arrive newest-first, so bucketing them in order keeps that order inside each area. Named
 * areas sort first (A→Z), then the district catch-all, then anything hand-pushed with no folder.
 */
function ManagerCandidateList({ candidates }: { candidates: readonly ManagerCvEngagementCandidate[] }) {
  const groups = useMemo(() => groupEngagementCandidatesByArea(candidates), [candidates]);

  if (candidates.length === 0) {
    return <p className="text-sm text-slate-500">No CVs recorded for this manager.</p>;
  }

  return (
    <div className="space-y-3">
      {groups.map(({ area, list }) => (
        <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`} key={area}>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-3 py-2">
            <span className="break-words text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-600">{area}</span>
            <span
              className={`border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-phx-2xs font-black tabular-nums text-orange-800 ${adminChipDepthClassName}`}
            >
              {list.length}
            </span>
          </div>
          <ul className="divide-y divide-slate-100">
            {list.map((candidate) => (
              <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 py-2.5" key={candidate.candidateId}>
                <div className="min-w-0">
                  <EngagementCvName candidate={candidate} />
                  <div className="mt-0.5 text-xs text-slate-500">
                    {candidate.arrivedAt ? `Arrived ${cairoEngagementDate(candidate.arrivedAt)}` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {candidate.opened ? (
                    <RecruitmentPill tone="emerald">Opened</RecruitmentPill>
                  ) : (
                    <RecruitmentPill tone="slate">Not opened</RecruitmentPill>
                  )}
                  {candidate.answered ? (
                    <RecruitmentPill tone="emerald">{candidateStatusLabel(candidate.status)}</RecruitmentPill>
                  ) : (
                    <RecruitmentPill tone="amber">Awaiting</RecruitmentPill>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The counts for one manager, as a four-up row of figures — used inside the phone card. */
function ManagerCountStrip({ row }: { row: ManagerCvEngagementRow }) {
  const cells: Array<[string, number, string]> = [
    ["Received", row.received, "text-slate-900"],
    ["Opened", row.opened, "text-emerald-700"],
    ["Not opened", row.notOpened, row.notOpened > 0 ? "text-amber-700" : "text-slate-900"],
    ["Answered", row.answered, "text-slate-900"],
  ];
  return (
    <dl className="mt-3 grid grid-cols-4 divide-x divide-slate-100 border border-slate-100 bg-slate-50/70">
      {cells.map(([label, value, tone]) => (
        <div className="flex min-w-0 flex-col-reverse px-1 py-2 text-center" key={label}>
          <dt className="mt-0.5 break-words text-phx-4xs font-black uppercase tracking-[0.08em] text-slate-400">{label}</dt>
          <dd className={`text-base font-black tabular-nums ${tone}`}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Take the report away as a workbook.
 *
 * The route re-loads the report under the viewer's own scope, so the filter has to travel with the
 * request — without it the file answers a different question than the table underneath. Fetched
 * rather than linked so a 403/429/500 lands as a message here instead of a browser tab full of JSON.
 */
function ExportXlsxButton({ query, disabled }: { query: string; disabled: boolean }) {
  const [state, setState] = useState<"error" | "idle" | "working">("idle");

  async function handleClick() {
    setState("working");
    try {
      // THE PATH STAYS LITERAL and the interpolation begins only after the `?`. An interpolation
      // glued to the last path segment — `…/export${params}` — reads to a scanner (and to a human)
      // as a dynamic route segment, and `recruitment-api-routes-exist` correctly refuses it: there
      // is no `[param]` folder there. `q` is always sent; the route treats an empty one as no filter.
      const params = new URLSearchParams({ q: query.trim() });
      const res = await fetch(`/api/recruitment/manager-engagement/export?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      // The Cairo day, matching the filename the route puts in Content-Disposition.
      anchor.download = `manager-cv-engagement-${new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" })}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {/* Wraps rather than pushing the button off a 375px screen when the message is showing. */}
      {state === "error" ? <span className="text-xs font-semibold text-rose-600">Export failed — try again</span> : null}
      <button
        className={`inline-flex h-10 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-phx-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
        disabled={disabled || state === "working"}
        onClick={() => void handleClick()}
        title="Every manager on screen, their four counts, and one line per CV behind them."
        type="button"
      >
        {state === "working" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {state === "working" ? "Exporting…" : "Export XLSX"}
      </button>
    </div>
  );
}

/** The expand marker — one chevron, turned when the row is open. Decorative; the row is the control. */
function ExpandChevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      aria-hidden="true"
      className={cn("h-4 w-4 text-slate-400 transition-transform", open ? "rotate-180 text-orange-600" : "")}
    />
  );
}

export function ManagerEngagementView({ report }: { report: ManagerCvEngagementReport }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const rows = useMemo(() => filterManagerEngagementRows(report.rows, query), [query, report.rows]);

  const { totals } = report;

  return (
    <div className="space-y-6">
      <RecruitmentKpiStrip
        items={[
          {
            description: report.scoped ? "on your line" : "all lines",
            icon: <UsersRound aria-hidden="true" className="h-4 w-4" />,
            label: "Managers",
            tone: "blue",
            value: <span className="tabular-nums">{totals.managers}</span>,
          },
          {
            description: "in their My Candidates",
            icon: <Inbox aria-hidden="true" className="h-4 w-4" />,
            label: "CVs received",
            tone: "violet",
            value: <span className="tabular-nums">{totals.received}</span>,
          },
          {
            description: "manager opened the CV",
            icon: <Eye aria-hidden="true" className="h-4 w-4" />,
            label: "Opened",
            tone: "emerald",
            value: <span className="tabular-nums">{totals.opened}</span>,
          },
          {
            description: "still unopened",
            icon: <EyeOff aria-hidden="true" className="h-4 w-4" />,
            label: "Not opened",
            tone: totals.notOpened > 0 ? "rose" : "orange",
            value: (
              <span className={cn("tabular-nums", totals.notOpened > 0 ? "text-amber-600" : "")}>{totals.notOpened}</span>
            ),
          },
          {
            description: "a decision recorded",
            icon: <MessageSquareCheck aria-hidden="true" className="h-4 w-4" />,
            label: "Answered",
            tone: "orange",
            value: <span className="tabular-nums">{totals.answered}</span>,
          },
        ]}
      />

      {/* The one thing that would be misread without it: "not opened" on old CVs. Opens are only
          counted from the day this feature shipped, so a CV a manager read on paper months ago reads
          as not-opened until he opens it in the app. Say so, once, at the top — without assuming the
          number is large, because on a given line it may not be. */}
      <div className={`flex gap-3 border border-amber-200 border-l-4 border-l-amber-400 bg-amber-50 p-3 text-xs leading-5 text-amber-900 ${adminChipDepthClassName}`}>
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-amber-600" />
        <p className="min-w-0">
          <span className="font-black">Reading these numbers:</span> &ldquo;Received&rdquo; is every CV in the
          manager&rsquo;s <em>My Candidates</em> folder — the ones in their areas plus anything sent straight to them —
          not only what was hand-pushed. A CV counts as &ldquo;Opened&rdquo; once they open it in the app. Nothing
          recorded an open before tracking began, so a CV that arrived before then shows as not opened even if it was
          read. &ldquo;Answered&rdquo; has full history — it reads the candidate&rsquo;s recorded decision — so an older CV
          can show <em>not opened</em> yet <em>answered</em>. The totals at the top count each CV once: a CV sent to
          two managers is one CV there, and appears in both managers&rsquo; rows.
        </p>
      </div>

      {/* Filter and export on one wrapping row, in the recessed toolbar tray. No `shrink-0` on either
          half: at 375px the button drops onto its own line instead of pinning the row to max-content
          and pushing the input off the screen — the fits-the-screen rule. */}
      <div className={cn(recruitmentToolbarClassName, "justify-between")}>
        <div className="w-full sm:max-w-xs">
          <label className={phxLabelClassName} htmlFor="manager-engagement-search">
            Filter managers
          </label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className={cn(phxFieldClassName, "pl-9")}
              id="manager-engagement-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by manager, area or line…"
              type="text"
              value={query}
            />
          </div>
        </div>
        <ExportXlsxButton disabled={rows.length === 0} query={query} />
      </div>

      <RecruitmentPanel
        count={report.rows.length === 0 ? undefined : query.trim() ? `${rows.length} of ${report.rows.length}` : rows.length}
        description="Press a manager to see the CVs behind their numbers, grouped by area. Press a candidate's name to read the CV."
        icon={<UsersRound aria-hidden="true" className="h-4 w-4" />}
        title="Managers"
      >
        {report.rows.length === 0 ? (
          <RecruitmentEmptyState
            icon={<Inbox aria-hidden="true" className="h-5 w-5" />}
            message={
              <>
                No CVs have been sent to any manager{report.scoped ? " on your line" : ""} yet. As the recruitment team pushes
                CVs to managers, each manager and what they do with them will appear here.
              </>
            }
            title="No manager has CVs yet"
          />
        ) : rows.length === 0 ? (
          <RecruitmentEmptyState
            icon={<Search aria-hidden="true" className="h-5 w-5" />}
            message={<>No manager matches &ldquo;{query}&rdquo;.</>}
            title="No match"
          />
        ) : (
          <>
            {/* ── Desktop: the full table (owner's rule) ── */}
            <div className="hidden md:block">
              <table className="hidden w-full table-fixed text-sm md:table" data-portal-desktop-table>
                <colgroup>
                  <col className="w-[30%]" />
                  <col className="w-[24%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[11%]" />
                  <col className="w-[10%]" />
                  <col className="w-[5%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-phx-2xs uppercase tracking-[0.12em]">
                    <th className="px-4 py-3 font-black">Manager</th>
                    <th className="px-4 py-3 font-black">Area / Line</th>
                    <th className="px-4 py-3 text-right font-black">Received</th>
                    <th className="px-4 py-3 text-right font-black">Opened</th>
                    <th className="px-4 py-3 text-right font-black">Not opened</th>
                    <th className="px-4 py-3 text-right font-black">Answered</th>
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
            <div className="space-y-3 p-3 md:hidden">
              {rows.map((row) => {
                const key = row.managerHrId;
                const isOpen = Boolean(expanded[key]);
                return (
                  <div
                    className={cn(
                      `border border-slate-200 bg-white p-4 ${adminSoftDepthClassName}`,
                      isOpen ? "border-l-4 border-l-orange-500" : "",
                    )}
                    key={key}
                  >
                    <button
                      aria-expanded={isOpen}
                      className="flex w-full items-start justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
                      onClick={() => toggle(key)}
                      type="button"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {/* The name, or words — never the HR id, which is what this fell back to. */}
                          <span className="break-words text-sm font-black text-slate-900">{managerLabel(row.managerName)}</span>
                          {row.inactive ? (
                            <InactiveBadge label={row.employmentStatusLabel} lastWorkingDate={row.lastWorkingDate} />
                          ) : null}
                        </div>
                        <div className="mt-0.5 break-words text-xs text-slate-500">
                          {[row.managerJobTitle, row.managerArea, row.managerLine].filter(Boolean).join(" · ") || "—"}
                        </div>
                        <ManagerCountStrip row={row} />
                      </div>
                      <ExpandChevron open={isOpen} />
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
      </RecruitmentPanel>
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
        className={cn(
          "cursor-pointer border-b border-slate-100 align-top transition-colors last:border-0 hover:bg-orange-50/40",
          isOpen ? "bg-orange-50/50 shadow-[inset_3px_0_0_#f97316]" : "",
        )}
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-words font-bold text-slate-900">{managerLabel(row.managerName)}</span>
            {row.inactive ? <InactiveBadge label={row.employmentStatusLabel} lastWorkingDate={row.lastWorkingDate} /> : null}
          </div>
          {row.managerJobTitle ? <div className="break-words text-xs text-slate-500">{row.managerJobTitle}</div> : null}
        </td>
        <td className="break-words px-4 py-3 text-slate-600">
          {[row.managerArea, row.managerLine].filter(Boolean).join(" / ") || "—"}
        </td>
        <td className="px-4 py-3 text-right font-bold tabular-nums text-slate-900">{row.received}</td>
        <td className="px-4 py-3 text-right font-bold tabular-nums text-emerald-700">{row.opened}</td>
        <td className={`px-4 py-3 text-right tabular-nums ${row.notOpened > 0 ? "font-black text-amber-700" : "text-slate-500"}`}>
          {row.notOpened}
        </td>
        <td className="px-4 py-3 text-right font-bold tabular-nums text-slate-900">{row.answered}</td>
        <td className="px-4 py-3 text-right">
          <span className="inline-flex justify-end">
            <ExpandChevron open={isOpen} />
          </span>
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-slate-100 bg-slate-50/60 last:border-0">
          <td className="px-4 py-4" colSpan={7}>
            <ManagerCandidateList candidates={row.candidates} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
