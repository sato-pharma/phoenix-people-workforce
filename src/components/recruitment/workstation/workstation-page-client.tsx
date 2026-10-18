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
//
// A CV'S OWN PAGE. When the link names a CV — which is what a press in the list opens, in a new tab
// — this page is that CV's page: one slim line, then the CV, its details and its decisions. No
// header of pile figures, no filter bar, no queue: none of them describe one CV, and the list they
// belong to is still open in the tab the reader came from. The owner, 2026-09-18: "why not when i
// press on the cv i am redirected into a new tab and page with full details".

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useOptimistic, useState, useSyncExternalStore, useTransition } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, Minimize2, ScanLine } from "lucide-react";

import { adminChipDepthClassName, adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import type { CandidateStatus } from "@/lib/recruitment/candidate-status";
import {
  decisionTabForStatusFilter,
  statusFilterForDecisionTab,
  type CandidateDecisionTab,
} from "@/lib/recruitment/candidate-decision-tabs";
import { CandidateDecisionTabStrip } from "@/components/recruitment/candidate-decision-tab-strip";
import {
  throughputDirection,
  type ThroughputSummary,
} from "@/lib/recruitment/candidate-throughput";
import { ScreeningFilterBar, ScreeningPageFrame } from "@/components/recruitment/screening-page-client";
import type { ScreeningFilterCounts } from "@/lib/recruitment/screening-filter-counts";
import type { ScreeningRatingFilter } from "@/lib/recruitment/candidate-rating";
import { ScreeningWorkstation } from "@/components/recruitment/workstation/screening-workstation";
import {
  Action,
  ActionLink,
  Eyebrow,
  Figure,
  WorkHeader,
} from "@/components/recruitment/workstation/workstation-look";
import {
  mergeNarrowing,
  parseOpenCandidateId,
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
import type { WhatsAppApplicantSearchLabel } from "@/lib/recruitment/whatsapp-applicant-filters";

export function WorkstationPageClient({
  area,
  areaOptions,
  canDecide,
  canReply,
  canSendToManagers,
  canWriteNotes,
  counts,
  decisionCounts,
  filterCounts,
  filteredOut,
  hiringManagers,
  notified,
  openRow,
  overdueManagerFeedback,
  poolHref,
  poolSize,
  positionSuggestions,
  rating,
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
  whatsapp,
  whatsAppSearchLabel,
}: {
  area: string | null;
  areaOptions: string[];
  /**
   * May this reader decide candidates — the gate on both the single verdict and the bulk one.
   * `candidates: update`, the grant every verdict route asserts.
   *
   * Its own prop rather than a second use of `canWriteNotes`, even though the two are the same
   * value today. They answer different questions, and the day notes are gated separately from
   * decisions, a shared prop would move who can reject fifty CVs without anybody editing this file.
   */
  canDecide: boolean;
  /**
   * May this reader answer an applicant on WhatsApp in their own words — `recruitment: update`, the
   * grant the reply route asserts. Its own prop, not `canDecide`: until 2026-09-18 the reply box rode
   * on `canDecide`, so it followed the verdict grant rather than its own route's.
   */
  canReply: boolean;
  canSendToManagers: boolean;
  canWriteNotes: boolean;
  counts: WorkQueueCounts;
  /**
   * How many CVs each decision tab holds, over the pile narrowed by every other filter on the page —
   * the numbers on the tab strip, each the list that tab opens.
   */
  decisionCounts: Record<CandidateDecisionTab, number>;
  /** How many CVs each filter option would return — the numbers the bar prints in its options. */
  filterCounts: ScreeningFilterCounts;
  filteredOut: number;
  hiringManagers: WorkspaceManager[];
  notified: ScreeningNotifiedFilter;
  /**
   * The CV the link names, built by the server whether or not the filters would have kept it.
   * Null when the link names none, or names a record that no longer exists. See `ownPage`.
   */
  openRow: WorkspaceCandidateRow | null;
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
  /** The star this link narrowed to, as "that many OR MORE" — or `unrated`. Null means any. */
  rating: ScreeningRatingFilter | null;
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
  /**
   * A search handed over by the WhatsApp Applicants page, still encoded, or null. Carried on every
   * link this page builds, like every other narrowing, so changing a filter here keeps it.
   */
  whatsapp: string | null;
  /** That search in words: the job title and each filter picked. Printed, never a code. */
  whatsAppSearchLabel: WhatsAppApplicantSearchLabel | null;
}) {
  const router = useRouter();
  const [fullBleed, setFullBleed] = useState(false);
  const [focus, setFocus] = useState(false);
  // A CV'S OWN PAGE is the one whose link names a CV — see the header. Read from the browser's own
  // address bar rather than threaded down from the two server shells: the rewrite this component
  // already handles (see screeningShellPoolHref) means the browser's URL is the only honest source.
  const openCandidateId = parseOpenCandidateId(useSearchParams().get("candidate"));
  const ownPage = openCandidateId !== null;
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
  const filtersRemembered = useSyncExternalStore(
    subscribeFiltersOpen,
    readRememberedFiltersOpen,
    filtersClosedOnServer,
  );
  // A CV's own page never opens the bar: its filters narrow a list that page does not draw. The
  // remembered choice is left alone, so the list tab keeps it.
  const filtersOpen = filtersRemembered && !ownPage;
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

  // ── WHAT THE BAR DRAWS WHILE THE SERVER IS STILL THINKING ────────────────────────────────
  //
  // Every filter on this page is a URL rather than component state, which is deliberate and worth
  // keeping: it is what makes a narrowed queue something you can bookmark and paste to somebody.
  // The cost is that each `<select>` is CONTROLLED BY THE SERVER'S ANSWER, and the answer takes a
  // real round trip — 5 to 12 seconds against the live pool of 607 CVs, measured 2026-09-12.
  //
  // So picking "Shortlisted" used to do this: React re-rendered immediately with the value the
  // server last sent, the dropdown SNAPPED BACK to "Any status", the list did not move, and nothing
  // anywhere said the page had heard the click. Seconds later everything changed at once. The owner
  // reported the filters as "not working" — in both the seat view and the pool, with every symptom
  // at once — and he was reading it exactly right: a control that undoes your choice IS broken,
  // whatever it later does.
  //
  // `useOptimistic` holds the value that was just picked for as long as the transition it was
  // dispatched inside is still running, then falls back to the server's own answer. Not `useState`:
  // a state copy has to be cleared when the real value lands, and the only place to do that is an
  // effect — which is the same set-state-in-effect the store rewrite above just removed.
  const serverNarrowing = {
    area,
    notified,
    rating,
    received,
    region,
    role,
    seen,
    source,
    status,
    vacancy,
    whatsapp,
  };
  const [shown, showImmediately] = useOptimistic(
    serverNarrowing,
    (current, picked: ScreeningHrefOptions) => mergeNarrowing(current, picked),
  );
  // The list is fetched by the ROUTER, so `pending` is the only honest signal that it is on its way.
  const [pending, startTransition] = useTransition();

  // How many of the URL narrowings are actually holding something — the decision tab excepted, which
  // is always on one tab and says so on its own strip. It is what the folded
  // filter bar says about itself: a bar that hides how many filters are on is a bar that makes
  // "why am I only seeing four people" unanswerable without opening it again. Reads the OPTIMISTIC
  // values, so a filter changed while the bar is folded is counted the moment it is picked.
  const activeFilters = [
    shown.area,
    shown.source,
    shown.rating,
    shown.role,
    shown.region,
    shown.received,
    shown.notified === "any" ? null : shown.notified,
    shown.seen === "any" ? null : shown.seen,
    shown.vacancy,
    shown.whatsapp,
  ].filter((value) => value !== null && value !== undefined && value !== "").length;
  // WHICH SHELL AM I ACTUALLY IN? Not always the one that rendered me — see screeningShellPoolHref.
  const shellPoolHref = screeningShellPoolHref(usePathname(), poolHref);

  // ── EVERY ROW IS A REAL LINK, AND A PRESS OPENS IT IN A NEW TAB ─────────────────────────────
  //
  // The link names the CV, which makes the tab it opens that CV's own page (see the header). It
  // carries the CURRENT filters too, so the page's "Screening list" line — and nothing else there —
  // goes back to the same pile the reader was in, not a stripped queue. A plain press, ctrl-click,
  // middle-click and the context menu's "Open in new tab" all open it: a `<button>` could be
  // opened in a tab by none of them. The owner, 2026-09-18: "when i press on the cv i am redirected
  // into a new tab and page with full details".
  const candidateHref = useCallback(
    (candidateId: string) =>
      screeningHref(shellPoolHref, {
        area,
        candidate: candidateId,
        notified,
        rating,
        received,
        region,
        role,
        seen,
        source,
        status,
        vacancy,
        whatsapp,
      }),
    [area, notified, rating, received, region, role, seen, shellPoolHref, source, status, vacancy, whatsapp],
  );
  // The same pile with no CV named: the list itself. It is where a CV's own page goes back to.
  const listHref = screeningHref(shellPoolHref, {
    area,
    notified,
    rating,
    received,
    region,
    role,
    seen,
    source,
    status,
    vacancy,
    whatsapp,
  });

  const goTo = useCallback(
    (next: ScreeningHrefOptions) => {
      const href = screeningHref(shellPoolHref, {
        area: next.area !== undefined ? next.area : area,
        notified: next.notified !== undefined ? next.notified : notified,
        rating: next.rating !== undefined ? next.rating : rating,
        received: next.received !== undefined ? next.received : received,
        region: next.region !== undefined ? next.region : region,
        role: next.role !== undefined ? next.role : role,
        seen: next.seen !== undefined ? next.seen : seen,
        source: next.source !== undefined ? next.source : source,
        status: next.status !== undefined ? next.status : status,
        vacancy: next.vacancy !== undefined ? next.vacancy : vacancy,
        whatsapp: next.whatsapp !== undefined ? next.whatsapp : whatsapp,
      });
      // BOTH INSIDE THE ONE TRANSITION. The optimistic value lives exactly as long as the navigation
      // it belongs to: dispatched outside it, React drops it on the very next render and the
      // dropdown snaps back again — which is the whole bug.
      startTransition(() => {
        showImmediately(next);
        router.push(href);
      });
    },
    [
      area,
      notified,
      rating,
      received,
      region,
      role,
      router,
      seen,
      shellPoolHref,
      showImmediately,
      source,
      status,
      vacancy,
      whatsapp,
    ],
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

  // THE PILE'S NAME, in the header and on the one-line strips that stand in for it. A seat names
  // itself; a search handed over by the WhatsApp Applicants page names its job title.
  const pileTitle =
    seatLabel ?? (whatsAppSearchLabel ? `WhatsApp applicants · ${whatsAppSearchLabel.title}` : "CV screening");

  // THE DECISION TAB the reader is on — the optimistic one, so the strip lights the tab the moment it
  // is pressed, seconds before the server's list arrives. The list itself follows the SERVER's tab.
  const shownTab = decisionTabForStatusFilter(shown.status);
  const serverTab = decisionTabForStatusFilter(status);

  const workstation = (
    <ScreeningWorkstation
      // A NEW TAB IS A NEW PILE, so the workstation starts afresh on it: the work queue back on
      // "Everyone", the selection back on the first row. Keyed on the SERVER's tab, so the reset
      // lands with the new list rather than a beat before it.
      key={serverTab}
      canDecide={canDecide}
      candidateHref={candidateHref}
      canReply={canReply}
      canSendToManagers={canSendToManagers}
      canWriteNotes={canWriteNotes}
      counts={counts}
      decisionTab={serverTab}
      filteredOut={filteredOut}
      focus={focus}
      openCandidateId={openCandidateId}
      hiringManagers={hiringManagers}
      onToggleFocus={toggleFocus}
      overdueManagerFeedback={overdueManagerFeedback}
      onSelectVacancy={(next) => goTo({ vacancy: next })}
      onLeaveWhatsAppSearch={() => goTo({ whatsapp: null })}
      ownPage={ownPage}
      poolSize={poolSize}
      positionSuggestions={positionSuggestions}
      rows={ownPage ? (openRow ? [openRow] : []) : rows}
      seatLabel={seatLabel}
      vacancies={vacancies}
      vacancyId={vacancy}
      vacancyStats={vacancyStats}
      whatsAppSearch={
        whatsAppSearchLabel ? [whatsAppSearchLabel.title, ...whatsAppSearchLabel.filters].join(" · ") : null
      }
    />
  );

  return (
    <ScreeningPageFrame>
      {/* THE PAGE'S OWN CHROME, IN ONE HEADER. It answers focus, and it is gone in full bleed —
          which draws its own single line inside the frame below. A CV's own page has no use for
          it either: every figure in it describes the pile, and that page is one CV. */}
      {focus || fullBleed || ownPage ? null : (
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
                  <span
                    className={`border border-phx-accent-line bg-phx-accent-soft px-1 text-[11px] font-black leading-tight tabular-nums text-phx-accent-press ${adminChipDepthClassName}`}
                  >
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
              ? "Every CV for this seat — filed to its folder, chosen on WhatsApp, or named in an email. Why each one is here is printed under their name."
              : whatsAppSearchLabel
                ? whatsAppSearchSubtitle(whatsAppSearchLabel)
                : "The whole pool, sorted by what has been decided. Narrow it to one pile, or to one vacant seat, from the work queue on the left."
          }
          title={pileTitle}
        />
      )}

      {focus || fullBleed || !filtersOpen ? null : (
        <ScreeningFilterBar
          area={shown.area}
          areaOptions={areaOptions}
          filterCounts={filterCounts}
          notified={shown.notified}
          onChange={goTo}
          // The decision tab is NOT cleared: it is not on this bar, and "Clear" wiping the reader's
          // tab back to "All" would undo the one choice he made above it.
          onClear={() =>
            goTo({
              area: null,
              notified: "any",
              rating: null,
              received: null,
              region: null,
              role: null,
              seen: "any",
              source: null,
              vacancy: null,
              whatsapp: null,
            })
          }
          pending={pending}
          queueCount={rows.length}
          rating={shown.rating}
          received={shown.received}
          region={shown.region}
          role={shown.role}
          seen={shown.seen}
          source={shown.source}
          sourceOptions={sourceOptions}
          // The tab's own pile before this bar's filters — the counts are taken over it — so the pill
          // reads "42 of 339" on Not decided yet, never "42 of 1,142".
          totalCount={filterCounts.total}
        />
      )}

      {/* ONE TREE, TWO GEOMETRIES — and the single tree is the load-bearing part.
          Full bleed used to be an early `return` into a different element tree, which meant React
          UNMOUNTED the workstation on the way in and on the way out: the selection went back to the
          first row, every loaded profile was thrown away, and the CV the reader was in the middle of
          re-fetched. Entering focus turns full bleed on, so that reset would have landed on the one
          press this whole change exists to make good. Same position in the tree, different class.

          The normal geometry is the one the screening page has used since August: as tall as the
          viewport minus the shell header, with a floor so it does not collapse on a short window.

          BOTH NUMBERS ARE DIVIDED BY THE DISPLAY SCALE. This frame sits inside <main>, which wears
          the app's own zoom (0.8 by default from 1024px), and `zoom` does not compensate viewport
          units: 100vh resolves against the real window and is THEN scaled, so the frame painted at
          80% of the height it asked for — on a 900px window a CV pane 20% short with a band of
          empty page under it, and on a short window one pinned to the floor. globals.css divides
          `.h-screen` and `.min-h-screen` for exactly this reason and leaves arbitrary `100vh`
          values alone, so this one has to say it itself. `--phx-scale-applied` is 1 below 1024px,
          where no zoom applies, so a phone is untouched. The floor is divided too: it is a
          physical minimum, and 32rem inside the zoom paints at 410px. */}
      <div
        className={
          fullBleed
            ? "fixed inset-0 z-[190] flex flex-col bg-white"
            : // The page-level panel (2026-10-19): the house panel depth, lifting the whole cockpit
              // off the admin shell's ground the way every other recruitment panel is lifted.
              `flex h-[calc((100vh_-_4rem)_/_var(--phx-scale-applied,1))] min-h-[calc(32rem_/_var(--phx-scale-applied,1))] flex-col overflow-hidden border border-phx-line bg-white ${adminPanelDepthClassName}`
        }
      >
        {/* A CV'S OWN PAGE: one slim line, and the rest of the screen is the CV. The way back to
            the list is here for a link opened on its own — from the list, that tab is still open
            exactly where it was, which is the point of opening this one in a new tab.
            `shrink-0` beside `flex-wrap` is safe HERE: the frame is a column, so it holds the
            line's height, and its width is the frame's — the two actions still drop to a second
            line on a phone. */}
        {ownPage && !fullBleed && !focus ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-phx-line bg-white px-3 py-1.5">
            <Eyebrow>{pileTitle}</Eyebrow>
            <span className="flex flex-wrap items-center gap-1.5">
              <ActionLink href={listHref} title="The whole screening list, in this tab" tone="ghost">
                <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
                Screening list
              </ActionLink>
              <Action
                onClick={enterFocus}
                title="Give the whole screen to the CV — Escape comes back"
                tone="primary"
              >
                <ScanLine aria-hidden className="h-3.5 w-3.5" />
                CV full screen
              </Action>
            </span>
          </div>
        ) : null}
        {fullBleed && !focus ? (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-phx-line bg-white px-3 py-1.5">
            <Eyebrow>{pileTitle}</Eyebrow>
            <span className="flex items-center gap-1.5">
              <Action
                onClick={enterFocus}
                title="Give the whole screen to the CV — Escape comes back"
                tone="primary"
              >
                <ScanLine aria-hidden className="h-3.5 w-3.5" />
                CV full screen
              </Action>
              {/* F is the key that got you here and Escape is the key that leaves, and neither was
                  written anywhere on the screen. Naming both on the way out is what teaches the way
                  in: there is no button that ENTERS full width, so the tooltip is the only place a
                  reader can learn the key exists. */}
              <Action
                onClick={() => setFullBleed(false)}
                title="Back to the page — or press F again, or Escape"
                tone="quiet"
              >
                <Minimize2 aria-hidden className="h-3.5 w-3.5" />
                Back to the page
              </Action>
            </span>
          </div>
        ) : null}
        {/* THE DECISION TABS — the owner, 2026-09-18: "in any screening page you must show did not
            decide yet ... shortlisted ... rejected", so that a new CV is easy to see. Inside the
            frame, above the three panes, so they stay on screen in full width as well and cost no
            page height; never on a CV's own page (one CV is not a pile) and never in focus, which is
            the whole screen for the document. */}
        {ownPage || focus ? null : (
          <div className="shrink-0 border-b border-phx-line bg-white px-3 py-2">
            <CandidateDecisionTabStrip
              active={shownTab}
              counts={decisionCounts}
              onSelect={(tab) => goTo({ status: statusFilterForDecisionTab(tab) })}
            />
          </div>
        )}
        <div className="min-h-0 flex-1">{workstation}</div>
      </div>
    </ScreeningPageFrame>
  );
}

/**
 * The header's second line for a search handed over by the WhatsApp Applicants page: the filters
 * picked, then what the pile holds. The job title is already in the header's name above it.
 */
function whatsAppSearchSubtitle(label: WhatsAppApplicantSearchLabel): string {
  // Everyone the search found, sorted onto the decision tabs like every other pile on this page.
  const pile = "Everyone that search found on the WhatsApp Applicants page, sorted by what has been decided.";
  return label.filters.length > 0 ? `${label.filters.join(" · ")}. ${pile}` : pile;
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
      {/* A tile like its two neighbours since 2026-10-19, so the three facts read as one row of the
          same object rather than two tiles and a loose sentence. */}
      {netThisWeek === null ? null : (
        <Figure
          label={`this week${improving === null ? "" : improving ? ", better than last week" : ", worse than last week"}`}
          value={netThisWeek > 0 ? `+${netThisWeek}` : netThisWeek}
        />
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
