"use client";

/**
 * Phoenix CRM — the module's page: its tabs, the territory they show, and the Super Admin's test mode.
 *
 * Owner, 2026-09-16:
 *   - the rep validates the customer list at the clinic, plans the week on it and adds each visit on
 *     the day; the district manager approves the plans and decides grade and drop requests; the SFE
 *     Manager sees every plan and can return one; everyone reads the territories beneath them only;
 *   - the Super Admin tries Add Visit, the list, the plan and the report from day one, and everything
 *     entered that way is a test entry: nobody is notified, and reports leave it out unless asked;
 *   - lines open one at a time, and a line's people see the module from its opening day.
 *
 * The server decides the tabs, the territories and the counts (GET /api/phoenix-crm/overview) and
 * checks every read and save again; this page only lays them out.
 *
 * A tab left with nothing unsaved and nothing under way is let go when another tab opens, so it reads
 * fresh when it comes back: a customer validated on the List is on the Plan straight away. A tab
 * holding work (Add Visit or a customer entry under way, unsaved plan or settings changes) stays as it
 * is behind the others, and changing the territory or test mode asks before it lets that work go.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { crmGet, messageOf } from "@/components/phoenix-crm/api";
import { DoctorsTab } from "@/components/phoenix-crm/doctors-tab";
import { countText, plural } from "@/components/phoenix-crm/format";
import { ListTab } from "@/components/phoenix-crm/list-tab";
import { releaseCapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import { MonthlyPlanTab } from "@/components/phoenix-crm/month-screen";
import { ReportsTab } from "@/components/phoenix-crm/reports-tab";
import { SettingsTab } from "@/components/phoenix-crm/settings-tab";
import { TeamTab } from "@/components/phoenix-crm/team-tab";
import {
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmEmpty,
  CrmField,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSelect,
  type CrmChoiceOption,
} from "@/components/phoenix-crm/ui";
import { VisitsTab, type PendingValidate, type PendingVisit } from "@/components/phoenix-crm/visits-tab";
import type { PhoenixCrmOverview, PhoenixCrmTabs, TerritorySummary } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

type TabKey = keyof PhoenixCrmTabs;

const TAB_ORDER: readonly TabKey[] = ["visits", "list", "plan", "team", "doctors", "reports", "settings"];

const TAB_LABELS: Record<TabKey, string> = {
  visits: "Visits",
  list: "List",
  plan: "Plan",
  team: "Team",
  doctors: "Directory",
  reports: "Reports",
  settings: "Settings",
};

/**
 * Phones fit three tabs a row (two rows for five or six, three for seven); wider screens fit every tab
 * on one row. Seven is the Super Admin's full set — four a row from `sm` keeps the labels on one line
 * until there is room for all seven, rather than shrinking the type (the fits-the-screen rule).
 *
 * Five — a rep's own set — is three over two on a phone with NO empty cell: a six-track grid where the
 * first three tabs take two tracks each and the last two take three. The spans are scoped to phones
 * (`max-sm:`) rather than reset at `sm`, because an `:nth-child` rule outranks a plain child rule and
 * a reset would lose to it.
 */
const TAB_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-6 sm:grid-cols-5 max-sm:[&>*:nth-child(-n+3)]:col-span-2 max-sm:[&>*:nth-child(n+4)]:col-span-3",
  6: "grid-cols-3 sm:grid-cols-6",
  7: "grid-cols-3 sm:grid-cols-4 lg:grid-cols-7",
};

/** The tabs that show one territory, chosen with the picker above them. */
type SeatTab = "visits" | "list" | "plan";

const SEAT_TABS: readonly SeatTab[] = ["visits", "list", "plan"];

/** The tabs that can hold work the page keeps while another tab is open. Reports and Doctors hold none. */
type HoldingTab = Exclude<TabKey, "reports" | "doctors">;

/** Each tab's work, as the question before letting it go names it. */
const HELD_WORK: Record<HoldingTab, string> = {
  visits: "the visit being added",
  list: "the customer entry under way",
  plan: "the unsaved changes to the weekly plan",
  team: "the unsaved changes to the plan opened from Team",
  settings: "the unsaved settings",
};

type EntriesShown = "test" | "real";

const ENTRY_CHOICES: ReadonlyArray<CrmChoiceOption<EntriesShown>> = [
  { value: "test", label: "Test mode", note: "Try the module" },
  { value: "real", label: "Real entries", note: "The field force's, read only" },
];

/**
 * The employee portal pins its navigation bar to the bottom of a phone's screen: 60 px of buttons, its
 * top border and the safe area, hidden from `lg` up. A tab's save bar sits above it. The admin shell
 * has no such bar.
 */
const PORTAL_BOTTOM_BAR = "calc(61px + env(safe-area-inset-bottom))";

/** Coming back to the page after at least this long reads the counts and territories again. */
const REFRESH_AFTER_MS = 60_000;

type Move =
  /** Show another territory; `tab` opens that tab too (a territory's list, from Team or the Plan). */
  | { kind: "seat"; seatId: string; tab: TabKey | null }
  | { kind: "test"; test: boolean };

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TAB_ORDER as readonly string[]).includes(value);
}

function isSeatTab(key: TabKey): key is SeatTab {
  return key === "visits" || key === "list" || key === "plan";
}

function isHoldingTab(key: TabKey): key is HoldingTab {
  return key !== "reports" && key !== "doctors";
}

function allowedTabs(tabs: PhoenixCrmTabs): TabKey[] {
  return TAB_ORDER.filter((key) => tabs[key]);
}

/**
 * The tab the page opens on: the one the address asks for, when the viewer has it; else Team for a
 * manager with a real decision waiting, or for one who reads the territories without entering visits
 * (a regional or national manager, the CEO, the SFE team); else the viewer's first tab.
 */
function openingTab(overview: PhoenixCrmOverview, requested: string | null): TabKey {
  const allowed = allowedTabs(overview.tabs);
  if (isTabKey(requested) && allowed.includes(requested)) return requested;
  const { tabs, viewer, visitSeatIds, waitingForYou } = overview;
  const decisions = waitingForYou.isTest ? 0 : waitingForYou.plans + waitingForYou.requests;
  if (tabs.team && !viewer.isRep && decisions > 0) return "team";
  if (tabs.team && !viewer.isSuperAdmin && visitSeatIds.length === 0) return "team";
  return allowed[0] ?? "visits";
}

/** The territories a tab offers. A plan is its own rep's; the Super Admin tries any, as a test. */
function territoriesFor(overview: PhoenixCrmOverview, tab: SeatTab): TerritorySummary[] {
  if (tab !== "plan" || overview.viewer.isSuperAdmin) return overview.territories;
  return overview.territories.filter((territory) => overview.ownSeatIds.includes(territory.seatId));
}

/** A tab's territory: the one chosen, when the tab offers it; else the viewer's own, else one they add visits for, else the first. */
function seatOf(overview: PhoenixCrmOverview, tab: SeatTab, chosen: string | null): string | null {
  const options = territoriesFor(overview, tab);
  if (chosen !== null && options.some((territory) => territory.seatId === chosen)) return chosen;
  const own = options.find((territory) => overview.ownSeatIds.includes(territory.seatId));
  const visits = options.find((territory) => overview.visitSeatIds.includes(territory.seatId));
  return (own ?? visits ?? options[0])?.seatId ?? null;
}

/** A territory's place without its line, which the picker's group already names. */
function placeOf(territory: TerritorySummary): string {
  return territory.areaName ?? territory.regionName ?? territory.name;
}

type TerritoryGroup = { line: string; territories: TerritorySummary[] };

/** The picker's groups: one per line, lines and places in alphabetical order. */
function groupByLine(territories: ReadonlyArray<TerritorySummary>): TerritoryGroup[] {
  const groups = new Map<string, TerritorySummary[]>();
  for (const territory of territories) {
    const line = territory.lineName ?? "No line";
    const entries = groups.get(line);
    if (entries) entries.push(territory);
    else groups.set(line, [territory]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([line, entries]) => ({ line, territories: entries.sort((left, right) => placeOf(left).localeCompare(placeOf(right))) }));
}

/** "a", "a and b", "a, b and c". */
function joinWords(words: ReadonlyArray<string>): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The distinct sentences saying when the viewer's lines open (one per line, not per territory). */
function openingSentences(overview: PhoenixCrmOverview): string[] {
  return [...new Set(overview.waiting.map((entry) => entry.message))];
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────

export function PhoenixCrmApp({
  initialOverview,
  initialTab,
  surface,
}: {
  initialOverview: PhoenixCrmOverview;
  /** The page's `?tab=` as typed; kept only when the viewer has that tab. */
  initialTab: string | null;
  /** The employee portal draws a navigation bar along the bottom of a phone; the admin shell does not. */
  surface: "admin" | "portal";
}) {
  const idPrefix = useId();
  const [overview, setOverview] = useState(initialOverview);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>(() => openingTab(initialOverview, initialTab));
  const [chosenSeat, setChosenSeat] = useState<string | null>(null);
  // The Super Admin's own entries are always test entries (owner, 2026-09-16), so the page opens in
  // test mode; real entries are for reading.
  const [testMode, setTestMode] = useState(true);
  const [pendingVisit, setPendingVisit] = useState<PendingVisit | null>(null);
  // The mirror of pendingVisit, running the other way: Add Visit hands a still-pending customer to the
  // List's Validate screen, so the rep who is already at the door with his phone out can finish it now.
  const [pendingValidate, setPendingValidate] = useState<PendingValidate | null>(null);
  const [holding, setHolding] = useState<ReadonlySet<HoldingTab>>(() => new Set<HoldingTab>());
  const [asking, setAsking] = useState<{ move: Move; work: HoldingTab[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const refreshRun = useRef(0);
  const refreshedAt = useRef(0);

  /** Reads the overview again. Only the latest read lands, so a slow answer never puts older counts back. */
  const refreshOverview = useCallback(() => {
    const run = refreshRun.current + 1;
    refreshRun.current = run;
    refreshedAt.current = Date.now();
    setRefreshing(true);
    crmGet<PhoenixCrmOverview>("/api/phoenix-crm/overview", "overview").then(
      (next) => {
        if (refreshRun.current !== run) return;
        setOverview(next);
        setRefreshError(null);
        setRefreshing(false);
      },
      (error: unknown) => {
        if (refreshRun.current !== run) return;
        setRefreshError(messageOf(error));
        setRefreshing(false);
      },
    );
  }, []);

  // A page left open in the background (a manager between visits) reads what waits for them again
  // when it comes back into view.
  useEffect(() => {
    refreshedAt.current = Date.now();
    function onVisibilityChange() {
      if (document.visibilityState === "visible" && Date.now() - refreshedAt.current >= REFRESH_AFTER_MS) refreshOverview();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refreshOverview]);

  /** One steady callback per tab, for the tab to say it holds work or no longer does. */
  const holdReporters = useMemo(() => {
    const reporter = (key: HoldingTab) => (held: boolean) =>
      setHolding((current) => {
        if (current.has(key) === held) return current;
        const next = new Set(current);
        if (held) next.add(key);
        else next.delete(key);
        return next;
      });
    return { list: reporter("list"), plan: reporter("plan"), settings: reporter("settings"), team: reporter("team"), visits: reporter("visits") };
  }, []);

  /** The question before letting work go shows where the person is looking. */
  const revealQuestion = useCallback((node: HTMLDivElement | null) => {
    node?.scrollIntoView({ block: "nearest" });
  }, []);

  const { viewer } = overview;
  const test = viewer.isSuperAdmin && testMode;
  const tabs = allowedTabs(overview.tabs);
  const activeTab: TabKey = tabs.includes(tab) ? tab : (tabs[0] ?? "visits");
  const seats: Record<SeatTab, string | null> = {
    list: seatOf(overview, "list", chosenSeat),
    plan: seatOf(overview, "plan", chosenSeat),
    visits: seatOf(overview, "visits", chosenSeat),
  };
  // The Super Admin's counts are test entries: they show in test mode only.
  const waitingCount = overview.waitingForYou.isTest === test ? overview.waitingForYou.plans + overview.waitingForYou.requests : 0;
  const tabId = (key: TabKey) => `${idPrefix}-tab-${key}`;
  const panelId = (key: TabKey) => `${idPrefix}-panel-${key}`;
  /** A tab kept behind the others because it holds work (and is still one of the viewer's tabs). */
  const isHeld = (key: TabKey) => isHoldingTab(key) && holding.has(key) && tabs.includes(key);

  function scrollToTop() {
    const top = topRef.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  }

  function openTab(next: TabKey) {
    setTab(next);
    setAsking(null);
    setNotice(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", next);
      window.history.replaceState(null, "", url);
    } catch {
      // The address keeps the old tab; nothing on the page reads it back.
    }
  }

  /** The held work a move lets go: a territory tab whose territory changes, or every tab test mode keys. */
  function workDroppedBy(move: Move): HoldingTab[] {
    if (move.kind === "test") {
      if ((viewer.isSuperAdmin && move.test) === test) return [];
      return (["visits", "list", "plan", "team"] as const).filter(isHeld);
    }
    return SEAT_TABS.filter((key) => isHeld(key) && seatOf(overview, key, move.seatId) !== seats[key]);
  }

  function applyMove(move: Move) {
    const dropped = workDroppedBy(move);
    setAsking(null);
    setNotice(null);
    if (move.kind === "seat" && !overview.territories.some((territory) => territory.seatId === move.seatId)) {
      // Opened from a list read after the page's own (Team): the page reads its territories again.
      setNotice("That territory is not on this page yet. The page is reading the latest territories: open it again in a moment.");
      refreshOverview();
      return;
    }
    // Add Visit's hand-off belongs to one territory in one mode; it goes when that is no longer shown.
    const nextTest = move.kind === "test" ? viewer.isSuperAdmin && move.test : test;
    const nextVisitsSeat = move.kind === "seat" ? seatOf(overview, "visits", move.seatId) : seats.visits;
    if (pendingVisit && (pendingVisit.seatId !== nextVisitsSeat || pendingVisit.test !== nextTest)) {
      releaseCapturedPhoto(pendingVisit.photo);
      setPendingVisit(null);
    }
    // The Validate hand-off belongs to one territory in one mode in the same way. It carries no photo.
    const nextListSeat = move.kind === "seat" ? seatOf(overview, "list", move.seatId) : seats.list;
    if (pendingValidate && (pendingValidate.seatId !== nextListSeat || pendingValidate.test !== nextTest)) {
      setPendingValidate(null);
    }
    // A tab let go does not say so on its way out.
    if (dropped.length > 0) {
      setHolding((current) => new Set([...current].filter((key) => !dropped.includes(key))));
    }
    if (move.kind === "test") {
      setTestMode(move.test);
      return;
    }
    setChosenSeat(move.seatId);
    if (move.tab) {
      openTab(move.tab);
      scrollToTop();
    }
  }

  function requestMove(move: Move) {
    const work = workDroppedBy(move);
    if (work.length === 0) applyMove(move);
    else setAsking({ move, work });
  }

  function startVisit(visit: PendingVisit) {
    if (pendingVisit && pendingVisit.photo !== visit.photo) releaseCapturedPhoto(pendingVisit.photo);
    setPendingVisit(visit);
    openTab("visits");
    scrollToTop();
  }

  /** Add Visit used the hand-off or put it aside; the validation photo is let go either way. */
  function pendingVisitDone() {
    releaseCapturedPhoto(pendingVisit?.photo);
    setPendingVisit(null);
  }

  /** The other direction: a visit was just saved on a pending customer and he chose to validate now. */
  function startValidate(validate: PendingValidate) {
    setPendingValidate(validate);
    openTab("list");
    scrollToTop();
  }

  /** The Validate screen opened from that hand-off was saved or backed out of. No photo to release. */
  function pendingValidateDone() {
    setPendingValidate(null);
  }

  /** Visits entered on this territory, where the List offers Add Visit after a place is saved. */
  function entersVisits(seatId: string): boolean {
    return test || (!viewer.isSuperAdmin && overview.visitSeatIds.includes(seatId));
  }

  function settingsChanged(change: "numbers" | "line" | "ramadan") {
    // A line opened or closed changes who sees what. The numbers and Ramadan dates reach each tab the
    // next time it reads.
    if (change === "line") refreshOverview();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const target =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    openTab(tabs[target]);
    document.getElementById(tabId(tabs[target]))?.focus();
  }

  /** A territory's List tab, opened from Team. */
  function openTerritoryList(seatId: string) {
    requestMove({ kind: "seat", seatId, tab: "list" });
  }

  // ── What the page draws ──

  function testModePanel() {
    if (!viewer.isSuperAdmin) return null;
    return (
      <CrmPanel>
        <CrmBlock>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] xl:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-black text-slate-950">{test ? "Test mode" : "Real entries"}</h2>
                <CrmPill tone={test ? "orange" : "info"}>{test ? "Test entries" : "Read only"}</CrmPill>
              </div>
              <p className="mt-1 max-w-3xl text-sm font-medium leading-6 text-slate-500">
                {test
                  ? "What you add, on any territory, is a test entry: nobody is notified, and reports leave test entries out unless you tick “Include my test entries”."
                  : "The field force's own entries, as they are. Your own entries are always test entries, so switch back to test mode to add anything."}
              </p>
            </div>
            <CrmChoice
              columns={2}
              label="Entries shown"
              onChange={(next) => requestMove({ kind: "test", test: next === "test" })}
              options={ENTRY_CHOICES}
              value={test ? "test" : "real"}
            />
          </div>
        </CrmBlock>
      </CrmPanel>
    );
  }

  function refreshNote() {
    if (!refreshError) return null;
    return (
      <CrmNote title="The page could not read the latest territories and counts" tone="warn">
        <p>{refreshError}</p>
        <div className="mt-2">
          <CrmButton busy={refreshing} onClick={refreshOverview} size="sm">
            Try again
          </CrmButton>
        </div>
      </CrmNote>
    );
  }

  /** Territories the viewer holds in lines that have not opened yet, beside the ones that have. */
  function waitingNote() {
    const sentences = openingSentences(overview);
    if (sentences.length === 0) return null;
    return (
      <CrmNote title="Not open yet" tone="info">
        {sentences.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </CrmNote>
    );
  }

  function tabBar() {
    if (tabs.length < 2) return null;
    return (
      <div aria-label="Phoenix CRM" className={cn("grid gap-1.5", TAB_COLUMNS[tabs.length])} role="tablist">
        {tabs.map((key, index) => {
          const selected = key === activeTab;
          const count = key === "team" ? waitingCount : 0;
          const heldAside = !selected && isHeld(key);
          return (
            <button
              aria-controls={panelId(key)}
              aria-selected={selected}
              className={cn(
                "flex min-h-11 min-w-0 flex-wrap items-center justify-center gap-1.5 rounded-none border px-2 py-2 text-center text-sm font-black transition",
                selected ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
              )}
              id={tabId(key)}
              key={key}
              onClick={() => openTab(key)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              <span className="min-w-0 break-words">{TAB_LABELS[key]}</span>
              {count > 0 ? (
                <span className="inline-flex min-w-5 items-center justify-center rounded-none bg-orange-600 px-1 text-phx-2xs font-black leading-5 text-white">
                  {countText(count)}
                  <span className="sr-only"> waiting for you</span>
                </span>
              ) : null}
              {heldAside ? (
                <span className="inline-flex items-center">
                  <span aria-hidden className="h-2 w-2 rounded-none bg-orange-500" />
                  <span className="sr-only">, not finished</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  function territoryPicker(seatTab: SeatTab) {
    const options = territoriesFor(overview, seatTab);
    const seatId = seats[seatTab];
    if (options.length < 2 || seatId === null) return null;
    const pickerId = `${idPrefix}-territory`;
    const count = plural(options.length, "territory", "territories");
    const hint = !viewer.isSuperAdmin
      ? `${count} you can open.`
      : test
        ? `${count}. What you add on any of them is a test entry.`
        : `${count}, with the field force's own entries, read only.`;
    return (
      <CrmPanel>
        <CrmBlock>
          <CrmField className="lg:max-w-xl" hint={hint} htmlFor={pickerId} label="Territory">
            <CrmSelect id={pickerId} onChange={(event) => requestMove({ kind: "seat", seatId: event.target.value, tab: null })} value={seatId}>
              {groupByLine(options).map((group) => (
                <optgroup key={group.line} label={group.line}>
                  {group.territories.map((territory) => (
                    <option key={territory.seatId} value={territory.seatId}>
                      {`${placeOf(territory)} · ${territory.repName ?? "No rep"}`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </CrmSelect>
          </CrmField>
        </CrmBlock>
      </CrmPanel>
    );
  }

  /** Asked before a territory or test-mode change lets held work go. */
  function questionNote() {
    if (!asking) return null;
    const { move, work } = asking;
    const title = move.kind === "seat" ? "Change the territory?" : move.test ? "Switch to test mode?" : "Switch to real entries?";
    const doing = move.kind === "seat" ? "Changing the territory" : "Switching";
    // One piece of work on a tab behind this one: keeping it opens that tab.
    const backTo = work.length === 1 && work[0] !== activeTab ? work[0] : null;
    return (
      <div className="scroll-mt-24" ref={revealQuestion}>
        <CrmNote title={title} tone="warn">
          <p>{`${doing} lets go of ${joinWords(work.map((key) => HELD_WORK[key]))}.`}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <CrmButton onClick={() => applyMove(move)} size="sm" variant="danger">
              Let it go
            </CrmButton>
            <CrmButton onClick={() => (backTo ? openTab(backTo) : setAsking(null))} size="sm">
              {backTo ? `Back to ${TAB_LABELS[backTo]}` : "Keep working"}
            </CrmButton>
          </div>
        </CrmNote>
      </div>
    );
  }

  function tabContent(key: TabKey): ReactNode {
    const { cairoToday } = overview;
    if (key === "team") {
      return (
        <TeamTab
          cairoToday={cairoToday}
          key={`team|${test}`}
          onChanged={refreshOverview}
          onDirtyChange={holdReporters.team}
          onOpenList={openTerritoryList}
          test={test}
        />
      );
    }
    if (key === "doctors") {
      return (
        <DoctorsTab
          key={`doctors|${test}`}
          onOpenList={openTerritoryList}
          openableSeatIds={overview.territories.map((territory) => territory.seatId)}
          reach={viewer.isRep ? (viewer.isManager ? "own-and-beneath" : "own") : "beneath"}
          test={test}
        />
      );
    }
    if (key === "reports") return <ReportsTab cairoToday={cairoToday} key={`reports|${test}`} test={test} />;
    if (key === "settings") return <SettingsTab onChanged={settingsChanged} onDirtyChange={holdReporters.settings} />;

    const seatId = seats[key];
    if (seatId === null) {
      return (
        <CrmPanel eyebrow={TAB_LABELS[key]} title={TAB_LABELS[key]}>
          <CrmEmpty message="A territory shows here once its line opens in Phoenix CRM." title="No territory to show" />
        </CrmPanel>
      );
    }
    if (key === "visits") {
      return (
        <VisitsTab
          cairoToday={cairoToday}
          key={`${seatId}|${test}`}
          onPendingVisitDone={pendingVisitDone}
          onStartValidate={startValidate}
          onWorkChange={holdReporters.visits}
          pendingVisit={pendingVisit}
          seatId={seatId}
          test={test}
        />
      );
    }
    if (key === "list") {
      return (
        <ListTab
          cairoToday={cairoToday}
          key={`${seatId}|${test}`}
          onPendingValidateDone={pendingValidateDone}
          onStartVisit={entersVisits(seatId) ? startVisit : undefined}
          onWorkChange={holdReporters.list}
          pendingValidate={pendingValidate}
          seatId={seatId}
          test={test}
        />
      );
    }
    return (
      <MonthlyPlanTab
        key={`${seatId}|${test}`}
        onChanged={refreshOverview}
        onDirtyChange={holdReporters.plan}
        onOpenList={() => requestMove({ kind: "seat", seatId, tab: "list" })}
        seatId={seatId}
        test={test}
      />
    );
  }

  // A tab's save bar sits above the portal's bottom navigation on a phone.
  const stickyOffset = { "--crm-sticky-bottom": surface === "portal" ? PORTAL_BOTTOM_BAR : "0px" } as CSSProperties;

  if (overview.closedMessage !== null || tabs.length === 0) {
    const sentences = openingSentences(overview);
    const reasons = sentences.length > 0 ? sentences : [overview.closedMessage ?? "Nothing in Phoenix CRM is open for you yet."];
    return (
      <div className="min-w-0 space-y-4" ref={topRef} style={stickyOffset}>
        {refreshNote()}
        <CrmPanel>
          <CrmEmpty
            action={
              <CrmButton busy={refreshing} onClick={refreshOverview}>
                Check again
              </CrmButton>
            }
            message={reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
            title="Phoenix CRM is not open for you yet"
          />
        </CrmPanel>
      </div>
    );
  }

  const seatTab = isSeatTab(activeTab) ? activeTab : null;

  return (
    <div className="min-w-0 scroll-mt-24 space-y-4" ref={topRef} style={stickyOffset}>
      {testModePanel()}
      {refreshNote()}
      {notice ? <CrmNote tone="warn">{notice}</CrmNote> : null}
      {waitingNote()}
      {tabBar()}
      {seatTab ? territoryPicker(seatTab) : null}
      {questionNote()}
      {tabs.map((key) => {
        const active = key === activeTab;
        return (
          <div
            aria-labelledby={tabs.length > 1 ? tabId(key) : undefined}
            className="min-w-0"
            hidden={!active}
            id={panelId(key)}
            key={key}
            role={tabs.length > 1 ? "tabpanel" : undefined}
          >
            {active || isHeld(key) ? tabContent(key) : null}
          </div>
        );
      })}
    </div>
  );
}
