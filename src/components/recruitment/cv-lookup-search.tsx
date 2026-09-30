"use client";

import { Download, FileSearch, Loader2, Search } from "lucide-react";
import * as React from "react";

import { AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
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
 * Design follows the sibling recruitment screens: AdminPageHero, AdminTableShell, desktop table
 * with a `table-fixed` colgroup, mobile cards, square edges, Phoenix orange, Cairo dates, names
 * never ids, nothing truncated.
 */

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

  const openButton = (hit: CvLookupHit) => (
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
  );

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Search for a candidate by name, phone, e-mail, or anything their CV or application says. Only the people the search matches are shown."
        eyebrow="Recruitment"
        icon={<FileSearch className="h-5 w-5" />}
        title="CV Lookup"
      />

      <AdminTableShell
        description="Type at least three characters and press Search. Nothing is listed until you do."
        title="Find a candidate"
      >
        <div className="border-t border-slate-100 px-4 py-4 sm:px-6">
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
            <input
              autoComplete="off"
              className={portalInputClassName}
              id="cv-lookup-query"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, phone, e-mail, university, employer, speciality…"
              type="search"
              value={query}
            />
            <Button className="gap-2 sm:w-auto" disabled={searching} type="submit">
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Search
            </Button>
          </form>

          {tooShort ? (
            <p className="mt-2 text-xs font-semibold text-slate-500">
              Keep typing — a search needs at least {MIN_QUERY_LENGTH} characters.
            </p>
          ) : null}
          {error ? (
            <p className="mt-2 border-l-[3px] border-l-rose-500 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
              {error}
            </p>
          ) : null}
        </div>
      </AdminTableShell>

      {result ? (
        <CvLookupResultsView
          hits={result.hits}
          query={result.query}
          renderAction={openButton}
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
    <AdminTableShell
      description={
        truncated
          ? `Showing the first ${hits.length} matches for “${query}” — there are more. Add another word to narrow it.`
          : `${hits.length} ${hits.length === 1 ? "candidate matches" : "candidates match"} “${query}”.`
      }
      title="Search results"
    >
      <PortalResponsiveDataList
        empty={
          <PortalEmptyState
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
                <p className="border-l-[3px] border-l-slate-300 bg-slate-50 px-2.5 py-2 text-xs font-medium leading-5 text-slate-600">
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
                <tr className="align-top" key={hit.candidateId}>
                  <td className="px-4 py-3">
                    <StackedCell
                      primary={hit.name}
                      secondary={[hit.governorate, hit.university].filter((part) => part.trim() !== "").join(" · ")}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <StackedCell
                      primary={hit.appliedFor}
                      secondary={[hit.statusLabel, hit.addedAt ? `Added ${cairoDate(hit.addedAt)}` : ""]
                        .filter((part) => part.trim() !== "")
                        .join(" · ")}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <StackedCell primary={hit.phone} secondary={hit.email} />
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-xs font-medium leading-5 text-slate-600">
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
    </AdminTableShell>
  );
}