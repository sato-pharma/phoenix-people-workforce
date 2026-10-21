"use client";

import { CalendarPlus, Download, FileSearch, Loader2, Search, SearchX, ShieldCheck } from "lucide-react";
import * as React from "react";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { adminChipDepthClassName, adminControlDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { ScheduleInterviewButton } from "@/components/recruitment/interview-calendar/schedule-interview-button";
import {
  RecruitmentEmptyState,
  RecruitmentPageHeader,
  RecruitmentPanel,
  RecruitmentPill,
} from "@/components/recruitment/recruitment-premium";
import { Button } from "@/components/ui/button";
import { phxButtonAccentClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { cairoDate } from "@/lib/format/cairo-datetime";
import type { CvLookupHit } from "@/lib/recruitment/cv-lookup";
import { fetchCvLookupApplication, saveBytesAsPdf } from "@/lib/recruitment/whatsapp-application-client";

/**
 * CV LOOKUP — a search box over the CV database, and nothing else on the screen until it is used.
 *
 * ── THE EMPTY SCREEN IS THE FEATURE ─────────────────────────────────────────────────────────────
 *
 * The owner, 2026-09-30: "she can search the cvs in admin account and finds only what it search
 * for i dont want her to have access to all cvs." So this component is written around what it must
 * NOT do. There is no initial list, no "recent candidates", no counter of how many CVs exist, no
 * filter panel that could be set to "everything", no select-all, no export and no page-through.
 * The page's server component loads no candidates at all, so even the HTML that arrives holds none
 * — hiding a list client-side would have left it sitting in the payload for anyone who looked.
 *
 * The search is an explicit ACTION rather than a keystroke filter: nothing is fetched until she
 * presses Search or Enter. That is the same decision the recruiter's CV search made for cost
 * reasons, and here it does a second job — there is no state of this screen in which a partially
 * typed word has quietly pulled back a slice of the database.
 *
 * ── WHAT A HIT OFFERS ───────────────────────────────────────────────────────────────────────────
 *
 * One button: the person's CV with their application, as a single PDF — "full cv and application",
 * in his words. It is the same file the screening page's own button produces, through a route
 * gated on `cv_lookup:read` rather than on the pool's grant.
 *
 * ── NO CAP, AND THE FLOOR THAT REPLACES IT ──────────────────────────────────────────────────────
 *
 * He chose "no cap" when asked how tightly to limit a search, so every match is listed. The floor
 * is the guard instead: fewer than three characters searches nothing, and the button says so
 * rather than silently doing nothing. A truncation note appears only when the shared CV function
 * hits its own 1,000-row ceiling — a cut list that reads as a complete answer is the one failure
 * worse than no answer at all.
 *
 * Design is the module's one kit (`recruitment-premium.tsx`, the owner's 2026-10-19 full sweep): the
 * `RecruitmentPageHeader`, a search console in a `RecruitmentPanel` whose field is the one form
 * design, the results in a second panel, desktop table with a `table-fixed` colgroup, mobile cards,
 * square edges, Phoenix orange, Cairo dates, names never ids, nothing truncated.
 */

/** What the one box reads, said once under it so nobody has to guess what a search can find. */
const SEARCHABLE_FIELDS = ["Name", "Phone", "E-mail", "University", "Employer", "Anything on the CV"] as const;

const MIN_QUERY_LENGTH = 3;

type SearchState = {
  hits: CvLookupHit[];
  /** The query these hits answer — shown in the result header, never the box's live value. */
  query: string;
  truncated: boolean;
};

function dash(value: string): string {
  return value.trim() === "" ? "—" : value;
}

/**
 * Two lines in one cell: the fact, and its companion fact beneath. The module's own idiom.
 *
 * NO `break-words` HERE, AND THAT IS A MEASURED DECISION RATHER THAN AN OMISSION. The risk is real —
 * this table is `table-fixed` with a percentage colgroup, so a value with no break opportunity is
 * CLIPPED instead of widening the table, and production's widest such value is 43 characters (an
 * e-mail run together with a LinkedIn URL, measured 2026-09-30). `break-words` was added for it and
 * then taken back out, because `scripts/measure-cv-lookup-fit.mjs` proved it changed nothing: every
 * cell inside a `PortalDesktopTable` already gets `overflow-wrap: anywhere` from
 * `[data-portal-desktop-table]:not([data-wide-report]) :where(td, th)` in `app/globals.css`, which is
 * stronger than the utility and is pinned by tests/crm-master-wide-report-nowrap.test.ts.
 *
 * Removing the utility and re-running the harness read clean at all five widths — so the class was
 * decoration claiming to be a guard, which is the shape of comment this repository is careful about.
 * The mobile cards are outside that selector and do not need it either: PortalRecordFields breaks
 * words itself.
 */
function StackedCell({ primary, secondary }: { primary: string; secondary?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-sm font-bold text-slate-800">{dash(primary)}</p>
      {secondary && secondary.trim() !== "" ? (
        <p className="mt-0.5 text-xs font-semibold text-slate-500">{secondary}</p>
      ) : null}
    </div>
  );
}

export function CvLookupSearch() {
  const [query, setQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState("");
  const [result, setResult] = React.useState<SearchState | null>(null);
  const [openingId, setOpeningId] = React.useState("");
  const requestRef = React.useRef(0);

  const trimmed = query.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_QUERY_LENGTH;

  const runSearch = React.useCallback(async () => {
    const needle = query.trim().replace(/\s+/g, " ");
    if (needle.length < MIN_QUERY_LENGTH) {
      setError(`Type at least ${MIN_QUERY_LENGTH} characters, then press Search.`);
      return;
    }
    // A later search always wins: an earlier one that finishes second must not overwrite it.
    const ticket = requestRef.current + 1;
    requestRef.current = ticket;
    setSearching(true);
    setError("");
    try {
      const response = await fetch(`/api/recruitment/cv-lookup?q=${encodeURIComponent(needle)}`, {
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => null)) as
        | { hits?: CvLookupHit[]; message?: string; truncated?: boolean }
        | null;
      if (requestRef.current !== ticket) return;
      if (!response.ok) {
        setError(body?.message?.trim() || `The search could not be run right now (error ${response.status}).`);
        return;
      }
      setResult({
        hits: Array.isArray(body?.hits) ? body.hits : [],
        query: needle,
        truncated: Boolean(body?.truncated),
      });
    } catch {
      if (requestRef.current !== ticket) return;
      setError("The search could not be run right now. Try again in a minute.");
    } finally {
      if (requestRef.current === ticket) setSearching(false);
    }
  }, [query]);

  const openApplication = React.useCallback(async (hit: CvLookupHit) => {
    setOpeningId(hit.candidateId);
    setError("");
    try {
      const file = await fetchCvLookupApplication(hit.candidateId);
      saveBytesAsPdf(file.bytes, file.fileName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That file could not be opened right now.");
    } finally {
      setOpeningId("");
    }
  }, []);

  /**
   * The two things a hit offers: read the person, then book them.
   *
   * SCHEDULE INTERVIEW IS THE SHARED BUTTON, not a second implementation — the owner's 2026-09-18
   * rule is that it reaches "any screen, any CV", and `ScheduleInterviewButton` carries the gate
   * and the dialog with it. It draws NOTHING for somebody who cannot book, so this screen never has
   * to ask the question: the seats that hold `cv_lookup` are the Super Admin, HR Operations and Talent
   * Acquisition, and `isInterviewCalendarOwner` admits exactly those three (the last since 2026-10-21),
   * so in practice it always draws here —
   * but the gate stays where it belongs rather than being restated as a condition this file owns.
   *
   * `renderTrigger` draws the press in THIS screen's kit. The shared button's own default is the
   * workstation `Action`, and a workstation control sitting beside the outline Button above would
   * read as a different kind of thing — the same reason the screening strip passes its own trigger.
   *
   * Stacked, not side by side: the CV column is 16% of a `table-fixed` table, and two buttons in a
   * row there is how a cell starts clipping. The fit harness measures both.
   */
  const rowActions = (hit: CvLookupHit) => (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        className="gap-2"
        disabled={openingId === hit.candidateId}
        onClick={() => void openApplication(hit)}
        size="sm"
        type="button"
        variant="outline"
      >
        {openingId === hit.candidateId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        CV + application
      </Button>
      <ScheduleInterviewButton
        candidate={{ id: hit.candidateId, jobTitle: hit.appliedFor || null, name: hit.name }}
        renderTrigger={({ open, title }) => (
          <Button className="gap-2" onClick={open} size="sm" title={title} type="button" variant="outline">
            <CalendarPlus className="h-4 w-4" />
            Schedule interview
          </Button>
        )}
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <RecruitmentPageHeader
        badges={<AdminInsightChip tone="slate">Only matches are shown</AdminInsightChip>}
        description="Search for a candidate by name, phone, e-mail, or anything their CV or application says. Only the people the search matches are shown."
        icon={<FileSearch aria-hidden="true" className="h-3.5 w-3.5" />}
        title="CV Lookup"
      />

      <RecruitmentPanel
        description="Type at least three characters and press Search. Nothing is listed until you do."
        icon={<Search aria-hidden="true" className="h-4 w-4" />}
        title="Find a candidate"
      >
        <div className="px-4 py-5 sm:px-6">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <label className="sr-only" htmlFor="cv-lookup-query">
              Search the CV database
            </label>
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              />
              <input
                autoComplete="off"
                className={cn(portalInputClassName, "pl-9")}
                id="cv-lookup-query"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, phone, e-mail, university, employer, speciality…"
                type="search"
                value={query}
              />
            </div>
            <button
              className={cn(phxButtonAccentClassName, "h-10 justify-center", adminControlDepthClassName, "disabled:shadow-none")}
              disabled={searching}
              type="submit"
            >
              {searching ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Search aria-hidden="true" className="h-4 w-4" />}
              Search
            </button>
          </form>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Searches</span>
            {SEARCHABLE_FIELDS.map((field) => (
              <span
                className={`border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-2xs font-bold text-slate-600 ${adminChipDepthClassName}`}
                key={field}
              >
                {field}
              </span>
            ))}
          </div>

          {tooShort ? (
            <p className="mt-3 text-xs font-semibold text-slate-500">
              Keep typing — a search needs at least {MIN_QUERY_LENGTH} characters.
            </p>
          ) : null}
          {error ? (
            <p className="mt-3 border-l-[3px] border-l-rose-500 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
              {error}
            </p>
          ) : null}

          <p className="mt-4 flex items-start gap-2 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500">
            <ShieldCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 flex-none text-emerald-600" />
            <span className="min-w-0">
              This screen never lists the CV database. Each search returns only the people it matches, and
              nothing is fetched until you press Search.
            </span>
          </p>
        </div>
      </RecruitmentPanel>

      {result ? (
        <CvLookupResultsView
          hits={result.hits}
          query={result.query}
          renderAction={rowActions}
          truncated={result.truncated}
        />
      ) : null}
    </div>
  );
}

/**
 * The results, on their own, as a pure function of the hits.
 *
 * SPLIT OUT OF THE COMPONENT ABOVE SO IT CAN BE RENDERED WITHOUT A BROWSER OR A DEV SERVER. The
 * table it draws is the one surface here with a fits-the-screen risk, and the owner's golden rule is
 * measured, never argued: `scripts/measure-cv-lookup-fit.mjs` server-renders THIS component with the
 * widest real values on production and sweeps every cell rect at five widths. It could not do that
 * while the table lived only behind `useState` — a search result is client state, so a harness
 * rendering `CvLookupSearch` itself would measure nothing but the empty screen and report it clean,
 * which is the false-clean reading the fit rule's own account warns about.
 *
 * `renderAction` is a prop rather than a button for the same reason: the live screen passes the one
 * that downloads the file, and the harness passes a plain one, so nothing in the measured markup
 * depends on a fetch.
 */
export function CvLookupResultsView({
  hits,
  query,
  renderAction,
  truncated,
}: {
  hits: CvLookupHit[];
  query: string;
  renderAction: (hit: CvLookupHit) => React.ReactNode;
  truncated: boolean;
}) {
  return (
    <RecruitmentPanel
      count={hits.length}
      description={
        truncated
          ? `Showing the first ${hits.length} matches for “${query}” — there are more. Add another word to narrow it.`
          : `${hits.length} ${hits.length === 1 ? "candidate matches" : "candidates match"} “${query}”.`
      }
      icon={<FileSearch aria-hidden="true" className="h-4 w-4" />}
      title="Search results"
    >
      <PortalResponsiveDataList
        empty={
          <RecruitmentEmptyState
            icon={<SearchX aria-hidden="true" className="h-5 w-5" />}
            message={`Nothing in the CV database matches “${query}”. Try a different spelling, or search for their phone number.`}
            title="No candidate matches that"
          />
        }
        getKey={(hit) => hit.candidateId}
        items={hits}
        renderCard={(hit) => (
          <PortalRecordCard accent="orange" actions={renderAction(hit)} meta={hit.statusLabel} title={hit.name}>
            <div className="space-y-2">
              <PortalRecordFields
                fields={[
                  { label: "Applied for", value: dash(hit.appliedFor) },
                  { label: "Phone", value: dash(hit.phone) },
                  { label: "E-mail", value: dash(hit.email) },
                  { label: "Governorate", value: dash(hit.governorate) },
                  { label: "University", value: dash(hit.university) },
                  { label: "Now at", value: dash(hit.currentEmployer) },
                ]}
              />
              {hit.matchedOn ? (
                <p className="border-l-[3px] border-l-orange-400 bg-orange-50/60 px-2.5 py-2 text-xs font-medium leading-5 text-slate-700">
                  <span className="mb-0.5 block text-phx-2xs font-black uppercase tracking-[0.12em] text-orange-700">
                    Why it matched
                  </span>
                  {hit.matchedOn}
                </p>
              ) : null}
            </div>
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[20%]" />
                <col className="w-[18%]" />
                <col className="w-[20%]" />
                <col className="w-[16%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left">
                <th className="px-4 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                  Candidate
                </th>
                <th className="px-4 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                  Applied for
                </th>
                <th className="px-4 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                  Contact
                </th>
                <th className="px-4 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                  Why it matched
                </th>
                <th className="px-4 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                  CV
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {hits.map((hit) => (
                <tr className="align-top transition-colors hover:bg-orange-50/30" key={hit.candidateId}>
                  <td className="px-4 py-3">
                    <StackedCell
                      primary={hit.name}
                      secondary={[hit.governorate, hit.university].filter((part) => part.trim() !== "").join(" · ")}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <StackedCell primary={hit.appliedFor} />
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {hit.statusLabel.trim() !== "" ? <RecruitmentPill tone="slate">{hit.statusLabel}</RecruitmentPill> : null}
                      {hit.addedAt ? (
                        <span className="text-xs font-semibold text-slate-500">{`Added ${cairoDate(hit.addedAt)}`}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StackedCell primary={hit.phone} secondary={hit.email} />
                  </td>
                  <td className="px-4 py-3">
                    <p className="border-l-2 border-l-orange-300 pl-2.5 text-xs font-medium leading-5 text-slate-600">
                      {hit.matchedOn ||
                        [hit.currentJobTitle, hit.currentEmployer].filter((part) => part.trim() !== "").join(" · ") ||
                        "Matched on the application."}
                    </p>
                  </td>
                  <td className="px-4 py-3">{renderAction(hit)}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </RecruitmentPanel>
  );
}