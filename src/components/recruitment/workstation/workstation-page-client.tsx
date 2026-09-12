"use client";

// Recruitment / ATS — the screening route's client half.
//
// THE FILTER BAR IS THE EXISTING ONE, IMPORTED RATHER THAN REBUILT. Eight URL-driven narrowings
// (status, seen, sent-to-manager, arrival window, role family, region, area, source), the "42 of
// 434" count, the orange treatment on whichever switch is actually holding something, and the Clear
// button — all of it still works, still lives in one file, and still produces a link a recruiter
// can bookmark. A second copy here would be a second thing to keep true, and the first divergence
// would be silent.
//
// SO THE TWO KINDS OF NARROWING ARE SPLIT ON PURPOSE, and the split is not arbitrary:
//
//   • THE URL narrows what is LOADED — the eight filters above. They are shareable, they survive a
//     reload, and changing one is a fresh server read because it changes the pool itself.
//   • THE WORKSTATION narrows what is SHOWN — work queue and search. They are instant, they never
//     navigate, and they never lose the CV that is open. That is the whole point: an hour of
//     screening is spent moving between piles, and a page load per move is the cost this replaces.
//
// THE VACANT SEAT MOVED FROM THE SECOND GROUP TO THE FIRST, and it had to. Picking a seat no longer
// only narrows what is already loaded: for that one seat the server reads the FILED CVs back in and
// matches the email applicants who never answered the WhatsApp questions, so the pool itself is
// different. Making it a link is also what the owner asked for — "screen Menoufia 1" survives a
// reload and can be pasted to the other screener, exactly like every other filter on this page.
//
// ── WHAT THE TOP OF THIS PAGE LOOKS LIKE, AND WHY IT WAS REBUILT ────────────────────────────────
//
// The owner, 2026-09-12: it "looks crowded and noisy". Measured on his own window that day, 276px of
// this page's own chrome — 30% of a 910px viewport — sat between the top of the page and the first
// candidate's name, and the app shell's own 104px was above that again. Three stacked strips: a
// bordered band of six throughput figures, a row of five identically-weighted bordered buttons, and
// eight filter dropdowns that opened themselves on every single load. Nowhere in any of it did the
// page say what it was or which pile was open — the name of the pile lived inside the list pane, two
// panes to the right of where the eye starts.
//
// It is ONE header now. The page says its name in display type, says what is in the pile underneath
// it, puts its figures where figures belong, and keeps its controls in a quiet row below. The look
// itself lives in workstation-look.tsx so that every bar on this screen speaks with one voice; read
// that file's header before changing anything visual here.
//
// FILTERS START CLOSED and the choice is remembered — see the state below.
//
// ONE CONTROL FOR "GET OUT OF MY WAY", not two. There were two buttons for nearly the same wish:
// Full width (drop the admin sidebar) and CV full screen (drop everything). The second already does
// the first on its way past, so the reader was being asked to choose between a thing and that same
// thing plus more. CV FULL SCREEN is the one that survived; `F` still toggles plain full width for
// anyone who wants only the sidebar gone, and Escape still steps back out one level at a time.
//
// EVERY BAR ON THIS PAGE FOLDS. The owner's words: "I need the full screen to see the CV in." So the
// header folds, the filter bar folds, and that one control folds every bar and every pane at once,
// leaving a single line above the document. The state lives HERE rather than inside the workstation
// because the two bars this page owns have to fold with it; the panes keep their own flags
// underneath and get them back untouched when the reader comes out.

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, Minimize2, ScanLine } from "lucide-react";

import type { CandidateStatus } from "@/lib/recruitment/candidate-status";
import {
  throughputDirection,
  type ThroughputSummary,
} from "@/lib/recruitment/candidate-throughput";
import { ScreeningFilterBar, ScreeningPageFrame } from "@/components/recruitment/screening-page-client";
import { ScreeningWorkstation } from "@/components/recruitment/workstation/screening-workstation";
import {
  Action,
  ActionLink,
  Eyebrow,
  Figure,
  WorkHeader,
} from "@/components/recruitment/workstation/workstation-look";
import {
  screeningHref,
  screeningShellPoolHref,
  type ScreeningHrefOptions,
  type ScreeningNotifiedFilter,
  type ScreeningReceivedFilter,
  type ScreeningRegionFilter,
  type ScreeningRoleFilter,
  type ScreeningSeenFilter,
} from "@/lib/recruitment/screening-link";
import type { WorkQueueCounts } from "@/lib/recruitment/screening-queues";
import type {
  WorkspaceCandidateRow,
  WorkspaceManager,
  WorkspaceVacancy,
} from "@/lib/recruitment/screening-workspace-types";
import type { VacancyApplicantStats } from "@/lib/recruitment/vacancy-applicants";

export function WorkstationPageClient({
  area,
  areaOptions,
  canDecide,
  canSendToManagers,
  canWriteNotes,
  counts,
  filteredOut,
  hiringManagers,
  notified,
  overdueManagerFeedback,
  poolHref,
  poolSize,
  positionSuggestions,
  received,
  region,
  role,
  rows,
  seen,
  source,
  sourceOptions,
  status,
  throughput,
  seatLabel,
  vacancies,
  vacancy,
  vacancyStats,
}: {
  area: string | null;
  areaOptions: string[];
  /**
   * May this reader decide candidates — the gate on both the single verdict and the bulk one.
   *
   * Its own prop rather than a second use of `canWriteNotes`, even though the two are the same
   * value today. They answer different questions, and the day notes are gated separately from
   * decisions, a shared prop would move who can reject fifty CVs without anybody editing this file.
   */
  canDecide: boolean;
  canSendToManagers: boolean;
  canWriteNotes: boolean;
  counts: WorkQueueCounts;
  filteredOut: number;
  hiringManagers: WorkspaceManager[];
  notified: ScreeningNotifiedFilter;
  overdueManagerFeedback: number;
  /**
   * Where "back to the pool" goes. Passed in rather than hard-coded because this page exists in both
   * shells, and sending a portal user to the admin route bounces them straight back out through the
   * (admin) group's own redirect.
   */
  poolHref: string;
  poolSize: number;
  /** Job titles and areas already used, offered as a datalist behind the free-typed position. */
  positionSuggestions: { jobTitles: string[]; areas: string[] };
  received: ScreeningReceivedFilter | null;
  region: ScreeningRegionFilter | null;
  role: ScreeningRoleFilter | null;
  rows: WorkspaceCandidateRow[];
  seen: ScreeningSeenFilter;
  source: string | null;
  sourceOptions: string[];
  status: CandidateStatus | null;
  /** Backlog in against backlog out, over four weeks — see the figures in the header. */
  throughput: ThroughputSummary;
  /** The seat being screened, in words, or null for the ordinary queue. Printed, never an id. */
  seatLabel: string | null;
  vacancies: WorkspaceVacancy[];
  /** The open seat the link names, or null. The one narrowing that carries an id — see the header. */
  vacancy: number | null;
  vacancyStats: VacancyApplicantStats[];
}) {
  const router = useRouter();
  const [fullBleed, setFullBleed] = useState(false);
  const [focus, setFocus] = useState(false);
  // FILTERS START CLOSED, AND THE CHOICE IS REMEMBERED.
  //
  // Open was the default until 2026-09-12, which put eight dropdowns between the reader and the
  // first name on every load — of a page he opens to READ, not to filter. The bar is one press away
  // and the button still says how many narrowings are holding something, so nothing is hidden.
  //
  // Remembered in the BROWSER rather than in the URL on purpose: the URL is the shareable half — it
  // carries WHICH filters are on — and a pasted link should not prise the other screener's bar open.
  // READ AS AN EXTERNAL STORE, not as state seeded by an effect. `localStorage` is exactly what
  // `useSyncExternalStore` is for, and it is the only way to read one during a server render that
  // does not lie: the server and the first client paint both take `filtersClosedOnServer`, so the
  // markup matches, and React re-reads the real browser value the instant hydration finishes. The
  // effect version of this (`useEffect(() => setFiltersOpen(true))`) costs a second render of the
  // whole page for a view preference, and the compiler lint rejects it by name. Closed-then-open is
  // the harmless direction for the one flicker either way leaves; open-then-closed, which a lazy
  // initial state would give, is the one that moves the list under the cursor.
  const filtersOpen = useSyncExternalStore(
    subscribeFiltersOpen,
    readRememberedFiltersOpen,
    filtersClosedOnServer,
  );
  // What full-bleed was before focus took it, so leaving focus puts the shell back exactly as it
  // was rather than deciding for the reader that he also wanted his sidebar returned.
  const [bleedBeforeFocus, setBleedBeforeFocus] = useState(false);

  // Writing the preference IS the state change: the store notifies, React re-reads it, the bar
  // moves. One source of truth rather than a flag and a copy of it that can drift apart.
  const toggleFilters = useCallback(() => {
    rememberFiltersOpen(!filtersOpen);
  }, [filtersOpen]);

  // FOCUS TAKES THE SIDEBAR TOO. "I need the full screen to see the CV in" is one screen, not one
  // column of it: with the admin shell still on the left the document gets about 1,100px of a
  // 1,440px laptop, and the 300px the shell holds is the difference between a Word page that reads
  // and one that is squeezed. So entering focus turns full-bleed on as well, and leaving it hands
  // back whichever state the reader had chosen for himself.
  const enterFocus = useCallback(() => {
    setBleedBeforeFocus(fullBleed);
    setFullBleed(true);
    setFocus(true);
  }, [fullBleed]);
  const leaveFocus = useCallback(() => {
    setFocus(false);
    setFullBleed(bleedBeforeFocus);
  }, [bleedBeforeFocus]);
  const toggleFocus = useCallback(() => {
    if (focus) leaveFocus();
    else enterFocus();
  }, [enterFocus, focus, leaveFocus]);

  // How many of the eight URL narrowings are actually holding something. It is what the folded
  // filter bar says about itself: a bar that hides how many filters are on is a bar that makes
  // "why am I only seeing four people" unanswerable without opening it again.
  const activeFilters = [
    area,
    source,
    status,
    role,
    region,
    received,
    notified === "any" ? null : notified,
    seen === "any" ? null : seen,
    vacancy,
  ].filter((value) => value !== null && value !== undefined && value !== "").length;
  // WHICH SHELL AM I ACTUALLY IN? Not always the one that rendered me — see screeningShellPoolHref.
  const shellPoolHref = screeningShellPoolHref(usePathname(), poolHref);

  const goTo = useCallback(
    (next: ScreeningHrefOptions) => {
      router.push(
        screeningHref(shellPoolHref, {
          area: next.area !== undefined ? next.area : area,
          notified: next.notified !== undefined ? next.notified : notified,
          received: next.received !== undefined ? next.received : received,
          region: next.region !== undefined ? next.region : region,
          role: next.role !== undefined ? next.role : role,
          seen: next.seen !== undefined ? next.seen : seen,
          source: next.source !== undefined ? next.source : source,
          status: next.status !== undefined ? next.status : status,
          vacancy: next.vacancy !== undefined ? next.vacancy : vacancy,
        }),
      );
    },
    [area, notified, received, region, role, router, seen, shellPoolHref, source, status, vacancy],
  );

  // `F` for full width, Escape to leave it. Ignored while typing, so an "f" in a search term does
  // not throw the page into full bleed mid-word.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable === true;
      if (event.key === "Escape" && !typing && (focus || fullBleed)) {
        event.preventDefault();
        // Focus first: it is the deeper of the two, and it puts back whatever full-bleed state the
        // reader had before it, so a second Escape can then leave that too.
        if (focus) leaveFocus();
        else setFullBleed(false);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFullBleed((on) => !on);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, fullBleed, leaveFocus]);

  const workstation = (
    <ScreeningWorkstation
      canDecide={canDecide}
      canSendToManagers={canSendToManagers}
      canWriteNotes={canWriteNotes}
      counts={counts}
      filteredOut={filteredOut}
      focus={focus}
      hiringManagers={hiringManagers}
      onToggleFocus={toggleFocus}
      overdueManagerFeedback={overdueManagerFeedback}
      onSelectVacancy={(next) => goTo({ vacancy: next })}
      poolSize={poolSize}
      positionSuggestions={positionSuggestions}
      rows={rows}
      seatLabel={seatLabel}
      vacancies={vacancies}
      vacancyId={vacancy}
      vacancyStats={vacancyStats}
    />
  );

  return (
    <ScreeningPageFrame>
      {/* THE PAGE'S OWN CHROME, IN ONE HEADER. It answers focus, and it is gone in full bleed —
          which draws its own single line inside the frame below. */}
      {focus || fullBleed ? null : (
        <WorkHeader
          controls={
            <>
              <ActionLink href={shellPoolHref} title="Back to the candidate pool" tone="ghost">
                <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
                Back to the pool
              </ActionLink>
              <Action
                aria-expanded={filtersOpen}
                onClick={toggleFilters}
                title={filtersOpen ? "Hide the filter bar" : "Show the filter bar"}
                tone={activeFilters > 0 ? "quiet" : "ghost"}
              >
                {filtersOpen ? (
                  <ChevronUp aria-hidden className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown aria-hidden className="h-3.5 w-3.5" />
                )}
                Filters
                {activeFilters > 0 ? (
                  <span className="border border-phx-accent-line bg-phx-accent-soft px-1 text-[11px] font-black leading-tight tabular-nums text-phx-accent-press">
                    {activeFilters}
                  </span>
                ) : null}
              </Action>
              {/* THE ONE LOUD CONTROL ON THE PAGE, and it is loud because it is the one the owner
                  asked for by name: "I need the full screen to see the CV in." */}
              <Action
                onClick={enterFocus}
                title="Give the whole screen to the CV — Escape comes back"
                tone="primary"
              >
                <ScanLine aria-hidden className="h-3.5 w-3.5" />
                CV full screen
              </Action>
            </>
          }
          figures={<BacklogFigures poolSize={poolSize} throughput={throughput} />}
          subtitle={
            seatLabel
              ? "Every undecided CV for this seat — filed to its folder, chosen on WhatsApp, or named in an email. Why each one is here is printed under their name."
              : "The whole pool. Narrow it to one pile, or to one vacant seat, from the work queue on the left."
          }
          title={seatLabel ?? "CV screening"}
        />
      )}

      {focus || fullBleed || !filtersOpen ? null : (
        <ScreeningFilterBar
          area={area}
          areaOptions={areaOptions}
          notified={notified}
          onChange={goTo}
          onClear={() =>
            goTo({
              area: null,
              notified: "any",
              received: null,
              region: null,
              role: null,
              seen: "any",
              source: null,
              status: null,
              vacancy: null,
            })
          }
          queueCount={rows.length}
          received={received}
          region={region}
          role={role}
          seen={seen}
          source={source}
          sourceOptions={sourceOptions}
          status={status}
          totalCount={poolSize}
        />
      )}

      {/* ONE TREE, TWO GEOMETRIES — and the single tree is the load-bearing part.
          Full bleed used to be an early `return` into a different element tree, which meant React
          UNMOUNTED the workstation on the way in and on the way out: the selection went back to the
          first row, every loaded profile was thrown away, and the CV the reader was in the middle of
          re-fetched. Entering focus turns full bleed on, so that reset would have landed on the one
          press this whole change exists to make good. Same position in the tree, different class.

          The normal geometry is the one the screening page has used since August: as tall as the
          viewport minus the shell header, with a floor so it does not collapse on a short window. */}
      <div
        className={
          fullBleed
            ? "fixed inset-0 z-[190] flex flex-col bg-white"
            : "flex h-[calc(100vh-4rem)] min-h-[32rem] flex-col border border-phx-line bg-white"
        }
      >
        {fullBleed && !focus ? (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-phx-line bg-white px-3 py-1.5">
            <Eyebrow>{seatLabel ?? "CV screening"}</Eyebrow>
            <span className="flex items-center gap-1.5">
              <Action
                onClick={enterFocus}
                title="Give the whole screen to the CV — Escape comes back"
                tone="primary"
              >
                <ScanLine aria-hidden className="h-3.5 w-3.5" />
                CV full screen
              </Action>
              <Action onClick={() => setFullBleed(false)} tone="quiet">
                <Minimize2 aria-hidden className="h-3.5 w-3.5" />
                Back to the page
              </Action>
            </span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{workstation}</div>
      </div>
    </ScreeningPageFrame>
  );
}

/**
 * IS THE BACKLOG GROWING OR SHRINKING? The one question the rail could not answer.
 *
 * Every number on this page described a PILE. None of them said whether the reader was keeping up,
 * and the answer on 2026-09-05 was no: 597 in the pool, 438 never opened by anybody, 153 arrived in
 * seven days, and an average of 12.8 days to a first decision. The queue was correct and losing, and
 * nothing on screen said so.
 *
 * THREE FACTS NOW, NOT SIX, AND NO BAND OF THEIR OWN. It shipped as a bordered strip above the
 * toolbar carrying the pool, the unread, two in-against-out spans and a direction, and the spans
 * rendered as "this week 220 in 300 decided -80" — a sentence nobody reads at a glance, in a band
 * that pushed the first candidate's name further down the page than the figures were worth. What
 * survives is what a screener acts on: the size of the pool, how much of it he has never opened, and
 * whether this week is gaining on it. The arithmetic is unchanged and still lives in
 * candidate-throughput.ts.
 *
 * The unread figure is THIS VIEWER's, the same "seen" the rest of the page means — see
 * candidate-views.ts on why that is per person and not per candidate.
 */
function BacklogFigures({ poolSize, throughput }: { poolSize: number; throughput: ThroughputSummary }) {
  const { improving, netThisWeek } = throughputDirection(throughput);

  return (
    <>
      <Figure label="in the pool" value={poolSize} />
      <Figure label="you have not opened" value={throughput.unread} />
      {/* The DIRECTION, which is the whole point of a trend: one week's net on its own says nothing
          about whether the reader is gaining. Signed and worded rather than coloured — "+38 this
          week" is a fact, and a red pill would be this component having an opinion about a
          recruiter's week. Silent when the week is unreportable, rather than drawing a confident
          line through a span whose decisions were never recorded. */}
      {netThisWeek === null ? null : (
        <span className="flex items-baseline gap-1.5">
          <span className="text-[15px] font-black leading-none tabular-nums text-phx-ink">
            {netThisWeek > 0 ? `+${netThisWeek}` : netThisWeek}
          </span>
          <span className="text-[11px] font-semibold leading-none text-phx-ink-soft">
            this week
            {improving === null ? "" : improving ? ", better than last week" : ", worse than last week"}
          </span>
        </span>
      )}
      {throughput.historyCoversEveryBucket ? null : (
        // NOT an error, and not hidden either. Decisions were only recorded from this date, so a
        // span before it has no number — saying "0 decided" there would blame the reader for a gap
        // in the table.
        <span className="w-full text-[11px] leading-snug text-phx-ink-soft">
          {throughput.historyStartsAt
            ? `Decisions have been recorded since ${cairoDay(throughput.historyStartsAt)}. Anything before that is not counted here.`
            : "No decision history has been recorded yet, so nothing decided can be counted here."}
        </span>
      )}
    </>
  );
}

/**
 * A date the owner can read, in Cairo.
 *
 * Cairo and not UTC because this is an instant WE stamped — `created_at` on a status event — which
 * is the one of the three cases that belongs in local time. A date-only column or a vendor
 * wall-clock would each be wrong here for opposite reasons.
 */
function cairoDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

/**
 * Whether this browser's reader left the filter bar open.
 *
 * Every read and every write is wrapped, because `localStorage` does not politely return null when
 * a browser is set to block site data — it THROWS, and an unguarded read here would white-screen the
 * whole screening page over a remembered preference. Any failure reads as closed, which is the
 * default this page ships with anyway, so the worst case is a bar that forgets.
 *
 * Per browser and not per account on purpose: it is a view preference of the kind that should not
 * follow a person onto a shared machine, and it is worth no round trip to the server.
 */
const FILTERS_OPEN_KEY = "phoenix.screening.filters-open";
const FILTERS_OPEN_EVENT = "phoenix.screening.filters-open.change";

function readRememberedFiltersOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(FILTERS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * What the server renders, and what the client renders while it hydrates — closed, always. A real
 * read here would produce markup the server could never have produced, which is a hydration error
 * rather than a flicker.
 */
function filtersClosedOnServer(): boolean {
  return false;
}

function rememberFiltersOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FILTERS_OPEN_KEY, open ? "1" : "0");
    window.dispatchEvent(new CustomEvent(FILTERS_OPEN_EVENT));
  } catch {
    // A browser that blocks site data still screens CVs. It just forgets the bar.
  }
}

/**
 * `storage` fires in the OTHER tabs, never the one that wrote — so the custom event is what makes
 * the bar move in THIS one. Both are listened for: a screener with the queue open twice gets the
 * same bar in both, which is the least surprising thing for a preference to do.
 */
function subscribeFiltersOpen(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(FILTERS_OPEN_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(FILTERS_OPEN_EVENT, onChange);
  };
}
