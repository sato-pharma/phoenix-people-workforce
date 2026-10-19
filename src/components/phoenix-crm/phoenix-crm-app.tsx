"use client";

/**
 * Phoenix CRM — the module's page: its tabs and the territory they show.
 *
 * Owner, 2026-09-16:
 *   - the rep validates the customer list at the clinic, plans the week on it and adds each visit on
 *     the day; the district manager approves the plans and decides grade and drop requests; the SFE
 *     Manager sees every plan and can return one; everyone reads the territories beneath them only;
 *   - lines open one at a time, and a line's people see the module from its opening day.
 *
 * 🔒 THE SUPER ADMIN'S TEST MODE IS RETIRED — owner, 2026-10-03: *"the test in the phoenix crm is now
 * irrelevant, u can fully retire it"*. It was the page's OPENING state (`useState(true)`), so an admin
 * account opened Phoenix CRM looking at a world with nothing real in it and had to find a toggle to
 * see the field force at all — the first of the "many defaults … not easy at all" he named in the same
 * message. He now reads REAL entries from the first paint, everywhere, with nothing to switch. His
 * own try-out rows stay in the database and are simply never read again; the ONE real-data entry he
 * had all along is unchanged — "Record a missed visit", on a day page, for a rep who forgot to log.
 *
 * 🔴 A `TEST-` LOGIN STILL HAS ITS TEST WORLD, and that is not the retired thing. A test account
 * mirrors a REAL employee (src/lib/auth/test-persona.ts) and writes only test rows; retiring its
 * world would break the reps' own test logins, which the same message put out of scope
 * (*"without touching the reps account"*). So `test` below is `viewer.isTestPersona` and nothing else.
 *
 * The server decides the tabs, the territories and the counts (GET /api/phoenix-crm/overview) and
 * checks every read and save again; this page only lays them out.
 *
 * A tab left with nothing unsaved and nothing under way is let go when another tab opens, so it reads
 * fresh when it comes back: a customer validated on the List is on the Plan straight away. A tab
 * holding work (Add Visit or a customer entry under way, unsaved plan or settings changes) stays as it
 * is behind the others, and changing the territory or test mode asks before it lets that work go.
 *
 * Owner, 2026-09-29: the portal's "+" offers a rep "Add visit" and "Make weekly plan". They land here
 * as `?tab=visits&add=visit` and `?tab=plan&add=week`, and the page answers them WITHOUT reloading —
 * the tab opens and the screen starts the Add flow or opens the week to plan, never dropping work
 * already under way. The `add` word is taken off the address once read, so the next tap is a new ask.
 */

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { announceRouteTransition } from "@/components/layout/route-transition-provider";
import { crmGet, crmUrl, messageOf } from "@/components/phoenix-crm/api";
import { countText, plural } from "@/components/phoenix-crm/format";
// The leaf module, never the camera: see captured-photo.ts for why the shell must not import the camera.
import { releaseCapturedPhoto } from "@/components/phoenix-crm/captured-photo";
import { preloadPhoenixCrmTab } from "@/components/phoenix-crm/tab-preload";
import { TelegramConnectCard } from "@/components/phoenix-crm/telegram-connect-card";
import { CrmSurfaceProvider, type CrmSurface } from "@/components/phoenix-crm/surface";
import { CrmBlock, CrmButton, CrmChoice, CrmEmpty, CrmField, CrmLoading, CrmNote, CrmPanel, CrmPill, CrmSelect } from "@/components/phoenix-crm/ui";
import type { PendingValidate, PendingVisit } from "@/components/phoenix-crm/visits-tab";
import { isForecastLine } from "@/lib/phoenix-crm/daily-forecast";
import { PHOENIX_CRM_PORTAL_BASE, phoenixCrmModulePath } from "@/lib/phoenix-crm/modules";
import { showsTelegramCard } from "@/lib/phoenix-crm/telegram-card";
import type { PhoenixCrmOverview, PhoenixCrmTabs, TerritorySummary } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

// ── Each module's screen is its own chunk (owner, 2026-10-01: "slow to transfer between page and page",
// Phoenix CRM first). Imported statically, all eight shipped to every module page as ONE 108 KB gzip
// chunk (measured on the production build), so a rep opening Visits downloaded Reports, Team and the
// Super Admin's Settings with it. Only the module on screen renders (see the panels at the bottom),
// so only its chunk is fetched; the placeholder is the tabs' own loading look, so a screen arriving
// reads exactly as one reading its data. The `import()` stays INSIDE each `dynamic()` on purpose: that
// is what lets Next preload the chunk with a server-rendered page. `tab-preload.ts` warms the same
// chunks ahead of a client navigation.
const tabLoading = () => <CrmLoading />;
const VisitsTab = dynamic(() => import("@/components/phoenix-crm/visits-tab").then((mod) => mod.VisitsTab), { loading: tabLoading });
const ListTab = dynamic(() => import("@/components/phoenix-crm/list-tab").then((mod) => mod.ListTab), { loading: tabLoading });
const PlanBoard = dynamic(() => import("@/components/phoenix-crm/plan-board").then((mod) => mod.PlanBoard), { loading: tabLoading });
// The district manager's own week and his own single visits (owner, 2026-10-16) — fetched only by him.
const ManagerPlanBoard = dynamic(() => import("@/components/phoenix-crm/manager-plan-board").then((mod) => mod.ManagerPlanBoard), { loading: tabLoading });
const ManagerSingleVisits = dynamic(() => import("@/components/phoenix-crm/manager-single-visits").then((mod) => mod.ManagerSingleVisits), {
  loading: tabLoading,
});
const ForecastTab = dynamic(() => import("@/components/phoenix-crm/forecast-tab").then((mod) => mod.ForecastTab), { loading: tabLoading });
const TeamTab = dynamic(() => import("@/components/phoenix-crm/team-tab").then((mod) => mod.TeamTab), { loading: tabLoading });
const CalendarTab = dynamic(() => import("@/components/phoenix-crm/calendar-tab").then((mod) => mod.CalendarTab), { loading: tabLoading });
const DoctorsTab = dynamic(() => import("@/components/phoenix-crm/doctors-tab").then((mod) => mod.DoctorsTab), { loading: tabLoading });
const ReportsTab = dynamic(() => import("@/components/phoenix-crm/reports-tab").then((mod) => mod.ReportsTab), { loading: tabLoading });
const SettingsTab = dynamic(() => import("@/components/phoenix-crm/settings-tab").then((mod) => mod.SettingsTab), { loading: tabLoading });

type TabKey = keyof PhoenixCrmTabs;

const TAB_ORDER: readonly TabKey[] = ["visits", "list", "plan", "forecast", "team", "calendar", "doctors", "reports", "settings"];

const TAB_LABELS: Record<TabKey, string> = {
  visits: "Visits",
  list: "List",
  plan: "Plan",
  forecast: "Forecast",
  team: "Team",
  calendar: "Calendar",
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
  // Eight is the Super Admin's full set. TWO a row on a phone, not three: at three, "Directory" and
  // "Settings" wrap onto a second line, and the fits-the-screen rule says merge or wrap, never shrink
  // the type. A rep's own set is six, which already had its own row above.
  8: "grid-cols-2 sm:grid-cols-4 lg:grid-cols-8",
  // Nine since the CNS daily forecast (2026-10-01) — the Super Admin's full set. Two a row on a phone
  // for the same reason as eight; five a row from `sm` keeps "Directory" and "Settings" on one line.
  9: "grid-cols-2 sm:grid-cols-5 lg:grid-cols-9",
};

/** The tabs that show one territory, chosen with the picker above them. */
type SeatTab = "visits" | "list" | "plan";

const SEAT_TABS: readonly SeatTab[] = ["visits", "list", "plan"];

/** The tabs that can hold work the page keeps while another tab is open. Reports and Doctors hold none. */
/** Today holds none either: it is a read, and every action on it opens another tab. */
/** Nor does the Calendar: it is a month laid out to be read, and nothing on it is entered. */
/** Nor the Forecast: every box is pre-filled from the target, so leaving it loses nothing he typed out. */
type HoldingTab = Exclude<TabKey, "reports" | "doctors" | "calendar" | "forecast">;

/** Each tab's work, as the question before letting it go names it. */
const HELD_WORK: Record<HoldingTab, string> = {
  visits: "the visit being added",
  list: "the customer entry under way",
  plan: "the unsaved changes to the plan",
  team: "the unsaved changes to the plan opened from Team",
  settings: "the unsaved settings",
};

/**
 * The employee portal pins its navigation bar to the bottom of a phone's screen: 60 px of buttons, its
 * top border and the safe area, hidden from `lg` up. A tab's save bar sits above it. The admin shell
 * has no such bar.
 */
const PORTAL_BOTTOM_BAR = "calc(61px + env(safe-area-inset-bottom))";

/** Coming back to the page after at least this long reads the counts and territories again. */
const REFRESH_AFTER_MS = 60_000;

/** Show another territory; `tab` opens that tab too (a territory's list, from Team or the Plan). */
type Move = { kind: "seat"; seatId: string; tab: TabKey | null };

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TAB_ORDER as readonly string[]).includes(value);
}

/** What the portal's "+" asks for: start a visit, or plan a week. Anything else is no ask. */
type AddIntent = "visit" | "week";

function addIntentOf(value: string | null): AddIntent | null {
  return value === "visit" || value === "week" ? value : null;
}

function isSeatTab(key: TabKey): key is SeatTab {
  return key === "visits" || key === "list" || key === "plan";
}

function isHoldingTab(key: TabKey): key is HoldingTab {
  return key !== "reports" && key !== "doctors" && key !== "calendar" && key !== "forecast";
}

function allowedTabs(tabs: PhoenixCrmTabs): TabKey[] {
  return TAB_ORDER.filter((key) => tabs[key]);
}

/**
 * The tab the page opens on: the one the address asks for, when the viewer has it; else Team for a
 * manager with a real decision waiting, or for one who reads the territories without entering visits
 * (a regional or national manager, the CEO, the SFE team); else the viewer's first tab.
 *
 * 🔴 AN ADMIN ACCOUNT NEVER OPENS ON ONE REP'S ENTRY SCREEN (owner, 2026-10-03: *"in admin accounts i
 * find many defaults usage not easy at all"*). `allowed[0]` is **Visits** — a single territory's
 * day, chosen for him out of 74 by `seatOf`, with nothing to enter on it since his test mode was
 * retired. On the admin surface the landing is the whole company instead: **Team**, and **Reports**
 * where there is no Team tab (the Training Manager, a product manager). The portal keeps its own
 * landing exactly as it was — a rep still opens onto his day (A2, owner 2026-09-26).
 */
function openingTab(overview: PhoenixCrmOverview, requested: string | null, surface: CrmSurface): TabKey {
  const allowed = allowedTabs(overview.tabs);
  if (isTabKey(requested) && allowed.includes(requested)) return requested;
  const { tabs, viewer, visitSeatIds, waitingForYou } = overview;
  if (surface === "admin" && !viewer.isRep) {
    if (tabs.team) return "team";
    if (tabs.reports) return "reports";
  }
  // The off-plan visits are one of the decisions since 2026-10-02 — a manager with one waiting and
  // nothing else lands on Team now, instead of on the tab he happened to be given first.
  const decisions =
    (waitingForYou.isTest && !viewer.isTestPersona
      ? 0
      : waitingForYou.plans +
        waitingForYou.requests +
        waitingForYou.planEdits +
        waitingForYou.offPlanVisits +
        waitingForYou.visitAsks);
  if (tabs.team && !viewer.isRep && decisions > 0) return "team";
  if (tabs.team && !viewer.isSuperAdmin && visitSeatIds.length === 0) return "team";
  // A2 (owner, 2026-09-26): he opens the app onto his DAY, not onto a tab bar. A manager with a real
  // decision waiting still lands on Team — the two branches above run first on purpose.
  return allowed[0] ?? "visits";
}

/** The territories a tab offers. A plan is its own rep's to change; the Super Admin reads any of them. */
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
  single = false,
  surface,
}: {
  initialOverview: PhoenixCrmOverview;
  /** The page's `?tab=` as typed; kept only when the viewer has that tab. */
  initialTab: string | null;
  /**
   * ONE module, on its own page, with nothing of the others on it.
   *
   * 🔴 OWNER, 2026-09-30, after seeing the first split: "I don't want, when I press on any one of the
   * ones you split, that they redirect me to the same screen that has all of them beside each other.
   * SEPARATE THEM TOTALLY, make them separate pages." So in this mode there is no tab bar, only the
   * one module is in the DOM at all (the others are not rendered hidden beside it), and every
   * hand-off that used to switch tabs in place NAVIGATES to the other module's own page, carrying
   * what it needs in the address. The way back is the chooser, linked at the top.
   *
   * The admin twin keeps the one-screen shape, and so does `single={false}`.
   */
  single?: boolean;
  /**
   * Which surface this is. The employee portal draws a navigation bar along the bottom of a phone and
   * the admin shell does not — and since 2026-10-03 it is also what every control on the page reads
   * through `CrmSurfaceProvider`: the admin's dropdowns are combo boxes, the rep's are not.
   */
  surface: CrmSurface;
}) {
  const idPrefix = useId();
  const [overview, setOverview] = useState(initialOverview);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>(() => openingTab(initialOverview, initialTab, surface));
  const [chosenSeat, setChosenSeat] = useState<string | null>(null);
  const [pendingVisit, setPendingVisit] = useState<PendingVisit | null>(null);
  // The mirror of pendingVisit, running the other way: Add Visit hands a still-pending customer to the
  // List's Validate screen, so the rep who is already at the door with his phone out can finish it now.
  const [pendingValidate, setPendingValidate] = useState<PendingValidate | null>(null);
  const [holding, setHolding] = useState<ReadonlySet<HoldingTab>>(() => new Set<HoldingTab>());
  const [asking, setAsking] = useState<{ move: Move; work: HoldingTab[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The portal's "+": each ask bumps a counter the screen watches, so a second tap is a second ask
  // even when the address reads the same, and nothing remounts to answer it.
  const searchParams = useSearchParams();
  const router = useRouter();
  const addParam = addIntentOf(searchParams?.get("add") ?? null);
  const tabParam = searchParams?.get("tab") ?? null;
  // A hand-off that crossed a page boundary (single mode): the customer Today sent here, or the
  // iReports360 entry Add Visit sent to the List's Validate screen.
  const customerParam = searchParams?.get("customer") ?? null;
  const customerNameParam = searchParams?.get("name") ?? null;
  const validateParam = searchParams?.get("validate") ?? null;
  const [seenAddress, setSeenAddress] = useState<{ add: AddIntent | null; tab: string | null }>({ add: null, tab: tabParam });
  const [addVisitNonce, setAddVisitNonce] = useState(0);
  // A district manager's own visit on a VACANT territory is saved from Add visit but lands in My single
  // visits (owner, 2026-10-19), which is a sibling panel with its own read: bumping this remounts it, so
  // the visit he just logged is on screen under it rather than one reload behind.
  const [ownSingleVisitNonce, setOwnSingleVisitNonce] = useState(0);
  const [planWeekNonce, setPlanWeekNonce] = useState(0);
  // Nosiba Salah holds a rep seat AND plans as acting district manager (owner, 2026-10-16: she files
  // both): which of her two weeks the Plan tab shows. Everyone else has one of them, or none.
  const [planScope, setPlanScope] = useState<"territory" | "district">("territory");
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

  // The "+" ask is read once: the word comes off the address, so the next tap on the same action is a
  // change the page sees. The tab stays in the address, as `openTab` keeps it.
  useEffect(() => {
    if (addParam === null) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("add");
      window.history.replaceState(null, "", url);
    } catch {
      // The address keeps the word; a second tap then reads as no change, and the tab is still open.
    }
  }, [addParam]);

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
  // A TEST- login's world, and nothing else: the Super Admin's test mode is retired (the header).
  const test = viewer.isTestPersona;
  const tabs = allowedTabs(overview.tabs);

  // The address changed under the page (the "+" menu, or a link to another tab): answered here, while
  // rendering, from what the address said last time — state derived from a prop, never an effect.
  if (seenAddress.add !== addParam || seenAddress.tab !== tabParam) {
    setSeenAddress({ add: addParam, tab: tabParam });
    if (addParam !== null && addParam !== seenAddress.add) {
      const target: TabKey = addParam === "visit" ? "visits" : "plan";
      if (tabs.includes(target)) {
        setTab(target);
        if (addParam === "visit") setAddVisitNonce((value) => value + 1);
        else setPlanWeekNonce((value) => value + 1);
      }
    } else if (tabParam !== seenAddress.tab && isTabKey(tabParam) && tabs.includes(tabParam)) {
      setTab(tabParam);
    }
  }
  const activeTab: TabKey = tabs.includes(tab) ? tab : (tabs[0] ?? "visits");
  const seats: Record<SeatTab, string | null> = {
    list: seatOf(overview, "list", chosenSeat),
    plan: seatOf(overview, "plan", chosenSeat),
    visits: seatOf(overview, "visits", chosenSeat),
  };
  // The hand-off that crossed the page boundary, rebuilt from the address. Derived while rendering,
  // never in an effect: the tab below must see it on its FIRST paint or it opens on its own start
  // screen and the rep has to find the customer again.
  const arrivedVisit: PendingVisit | null =
    single && activeTab === "visits" && customerParam
      ? {
          seatId: seats.visits ?? "",
          test,
          customerId: customerParam,
          customerName: customerNameParam ?? "",
          photo: null,
          // No photo on this path, and this only times out a REUSED validation photo — so there is
          // nothing to age, and calling Date.now() while rendering would break the purity rule.
          validatedAtMs: 0,
        }
      : null;
  const arrivedValidate: PendingValidate | null =
    single && activeTab === "list" && validateParam && Number.isFinite(Number(validateParam))
      ? { seatId: seats.list ?? "", test, contactCrmId: Number(validateParam), customerName: customerNameParam ?? "" }
      : null;
  // A test login's counts are its own world's; everyone else's — the Super Admin's included since his
  // test mode was retired — are the real ones.
  const { waitingForYou } = overview;
  // A rep's asks for a visit waiting for this viewer's answer (owner, 2026-10-02): counted on Team for a
  // manager, and on Reports for a product manager, who has no Team tab.
  const visitAskCount = waitingForYou.isTest === test ? waitingForYou.visitAsks : 0;
  const waitingCount =
    (waitingForYou.isTest === test
      ? waitingForYou.plans + waitingForYou.requests + waitingForYou.planEdits + waitingForYou.offPlanVisits
      : 0) +
    visitAskCount;
  const tabId = (key: TabKey) => `${idPrefix}-tab-${key}`;
  const panelId = (key: TabKey) => `${idPrefix}-panel-${key}`;
  /** A tab kept behind the others because it holds work (and is still one of the viewer's tabs). */
  const isHeld = (key: TabKey) => isHoldingTab(key) && holding.has(key) && tabs.includes(key);

  function scrollToTop() {
    const top = topRef.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  }

  /** The other module's own address, with whatever the hand-off has to carry. */
  function moduleHref(next: TabKey, carry?: Record<string, string>): string {
    const url = new URL(phoenixCrmModulePath(PHOENIX_CRM_PORTAL_BASE, next), window.location.origin);
    for (const [key, value] of Object.entries(carry ?? {})) if (value) url.searchParams.set(key, value);
    return `${url.pathname}${url.search}`;
  }

  function openTab(next: TabKey, carry?: Record<string, string>) {
    // 🔴 SEPARATE PAGES, SO THIS IS A NAVIGATION (owner, 2026-09-30). Switching the panel in place is
    // what he objected to: it left him on one module's address looking at another's.
    //
    // 🔴 A CLIENT NAVIGATION, NEVER A RELOAD (owner, 2026-10-01: "slow to transfer between page and
    // page", Phoenix CRM first). This was `window.location.assign`, so Visits → List to validate a
    // customer threw the whole page away: the HTML and the portal shell rendered again on the server,
    // every script parsed and hydrated again, before the List could even start. A push keeps the
    // shell and swaps only the module page, which REMOUNTS — its segment changes — so each module
    // still opens fresh, and the hand-off (`?validate=`, `?customer=`, `?name=`) is read from the
    // address on the first paint exactly as before. Nothing is held across it: `pendingVisit` is
    // never set on this path, so there is no captured photo to let go. The next module's screen starts
    // downloading here too, beside the page rather than after it (tab-preload.ts).
    if (single) {
      const href = moduleHref(next, carry);
      preloadPhoenixCrmTab(next);
      announceRouteTransition(href);
      router.push(href);
      return;
    }
    setTab(next);
    setAsking(null);
    setNotice(null);
    try {
      // 🔴 EACH MODULE HAS ITS OWN ADDRESS ON THE PORTAL (owner, 2026-09-30, the split modules). The
      // switch stays IN PAGE — that is what lets the page ask before dropping work he has started —
      // but the address follows it, so the tab he is looking at is the tab his link reopens.
      //
      // `?add=` is dropped on the way: it is an instruction to open something on ARRIVAL, and leaving
      // it behind would re-open that form every time he came back to the address.
      const url = new URL(window.location.href);
      if (surface === "portal") {
        // By SLUG, never the raw key: the Directory tab's key is a retired word and the address is UI.
        url.pathname = phoenixCrmModulePath(PHOENIX_CRM_PORTAL_BASE, next);
        url.searchParams.delete("tab");
        url.searchParams.delete("add");
      } else {
        url.searchParams.set("tab", next);
      }
      window.history.replaceState(null, "", url);
    } catch {
      // The address keeps the old tab; nothing on the page reads it back.
    }
  }

  /** The held work a move lets go: a territory tab whose territory changes. */
  function workDroppedBy(move: Move): HoldingTab[] {
    // The guard is re-typed for SeatTab rather than reused as-is: `isHoldingTab` takes a TabKey and
    // narrows to HoldingTab, which is NOT a subtype of SeatTab (it also holds team and settings), so
    // `filter` cannot pick its narrowing overload and hands back SeatTab[] with no complaint until
    // the return type rejects it.
    const isHeldSeatTab = (key: SeatTab): key is SeatTab & HoldingTab => isHoldingTab(key);
    return SEAT_TABS.filter(isHeldSeatTab).filter((key) => isHeld(key) && seatOf(overview, key, move.seatId) !== seats[key]);
  }

  function applyMove(move: Move) {
    const dropped = workDroppedBy(move);
    setAsking(null);
    setNotice(null);
    if (!overview.territories.some((territory) => territory.seatId === move.seatId)) {
      // Opened from a list read after the page's own (Team): the page reads its territories again.
      setNotice("That territory is not on this page yet. The page is reading the latest territories: open it again in a moment.");
      refreshOverview();
      return;
    }
    // Add Visit's hand-off belongs to one territory; it goes when that territory is no longer shown.
    const nextVisitsSeat = seatOf(overview, "visits", move.seatId);
    if (pendingVisit && (pendingVisit.seatId !== nextVisitsSeat || pendingVisit.test !== test)) {
      releaseCapturedPhoto(pendingVisit.photo);
      setPendingVisit(null);
    }
    // The Validate hand-off belongs to one territory in the same way. It carries no photo.
    const nextListSeat = seatOf(overview, "list", move.seatId);
    if (pendingValidate && (pendingValidate.seatId !== nextListSeat || pendingValidate.test !== test)) {
      setPendingValidate(null);
    }
    // A tab let go does not say so on its way out.
    if (dropped.length > 0) {
      setHolding((current) => new Set([...current].filter((key) => !dropped.includes(key))));
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

  /** Add Visit used the hand-off or put it aside; the validation photo is let go either way. */
  function pendingVisitDone() {
    releaseCapturedPhoto(pendingVisit?.photo);
    setPendingVisit(null);
  }

  /** The other direction: a visit was just saved on a pending customer and he chose to validate now. */
  function startValidate(validate: PendingValidate) {
    if (single) {
      openTab("list", { validate: String(validate.contactCrmId), name: validate.customerName });
      return;
    }
    setPendingValidate(validate);
    openTab("list");
    scrollToTop();
  }

  /** The Validate screen opened from that hand-off was saved or backed out of. No photo to release. */
  function pendingValidateDone() {
    setPendingValidate(null);
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

  /** A test account's standing note: what it is working on, and that none of it is real. */
  function testAccountPanel() {
    return (
      <CrmPanel>
        <CrmBlock>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-black text-slate-950">Test login</h2>
              <CrmPill tone="orange">Test entries</CrmPill>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              You are working as {viewer.name}. Every visit, plan, request and decision you make here is a test entry: the real
              person&apos;s entries never change, and nothing you do reaches a real report.
            </p>
          </div>
        </CrmBlock>
      </CrmPanel>
    );
  }

  /**
   * The only standing note the top of the page carries now: a TEST- login's.
   *
   * 🔴 THE SUPER ADMIN GETS NO PANEL AT ALL, which is the point rather than a gap. The retired toggle
   * sat above every tab with a paragraph about a world he can no longer enter; a note saying "these
   * are the real entries" would be the same furniture with nothing to decide. He simply reads the
   * module.
   */
  function standingNote() {
    return viewer.isTestPersona ? testAccountPanel() : null;
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
    // 🔴 Separate pages carry no bar of the others (owner, 2026-09-30).
    if (single || tabs.length < 2) return null;
    return (
      <div aria-label="Phoenix CRM" className={cn("grid gap-1.5", TAB_COLUMNS[tabs.length])} role="tablist">
        {tabs.map((key, index) => {
          const selected = key === activeTab;
          const count = key === "team" ? waitingCount : key === "reports" && !overview.tabs.team ? visitAskCount : 0;
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

  /**
   * The one-page start guide, in English or Arabic.
   *
   * IT IS SHOWN TO EVERYONE IN THE MODULE, THE MEDICAL REP INCLUDED, and that is the point rather
   * than an oversight. Golden Rule #1 draws its line at WHOSE WORK IT IS: learning to use his own
   * app is his, the way his plan and his day are his. The page names no rep, no customer and no
   * figure, so there is nothing on it a scope could narrow and nothing it could disclose.
   *
   * It opens in a new tab rather than navigating, because a rep who taps it in the middle of
   * entering a visit must come back to a form he has not lost — and it is a link to a document, not
   * a step added to his day, which would need the owner's word first.
   *
   * Quiet on purpose: one line of small type under the tabs, no panel, no border, no fill. A card
   * here would compete with the tab he actually came to press.
   */
  function startGuideLink() {
    const linkClass = "font-black text-slate-700 underline underline-offset-2 hover:text-orange-700";
    return (
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
        <span className="min-w-0">New here? The one-page guide to recording a visit:</span>
        <a className={linkClass} href={crmUrl("/api/phoenix-crm/start-guide", { lang: "en" })} rel="noreferrer" target="_blank">
          English
        </a>
        <span aria-hidden>·</span>
        {/* Its own direction, never a mixed run — the Arabic name of the same page. */}
        <a
          className={linkClass}
          dir="rtl"
          href={crmUrl("/api/phoenix-crm/start-guide", { lang: "ar" })}
          lang="ar"
          rel="noreferrer"
          target="_blank"
        >
          العربية
        </a>
      </p>
    );
  }

  function territoryPicker(seatTab: SeatTab) {
    const options = territoriesFor(overview, seatTab);
    const seatId = seats[seatTab];
    if (options.length < 2 || seatId === null) return null;
    const pickerId = `${idPrefix}-territory`;
    const count = plural(options.length, "territory", "territories");
    const groups = groupByLine(options);
    // 🔴 THE COMBO BOX FLATTENS `optgroup`, so on the admin surface the line is written INTO each
    // option instead of standing above a group of them. That is not a workaround: it is what makes
    // the control answer the admin's real question — he types "Pedia" or "Tanta" or a rep's name and
    // the 74 seats narrow to one, which no group heading on a native dropdown ever did for him.
    const combo = surface === "admin";
    const hint = combo
      ? `${count}. Type a line, a place or a rep's name to find one.`
      : !viewer.isSuperAdmin
        ? `${count} you can open.`
        : `${count}, with the field force's own entries.`;
    return (
      <CrmPanel>
        <CrmBlock>
          <CrmField className="lg:max-w-xl" hint={hint} htmlFor={pickerId} label="Territory">
            <CrmSelect id={pickerId} onChange={(event) => requestMove({ kind: "seat", seatId: event.target.value, tab: null })} value={seatId}>
              {combo
                ? groups.flatMap((group) =>
                    group.territories.map((territory) => (
                      <option key={territory.seatId} value={territory.seatId}>
                        {`${group.line} · ${placeOf(territory)} · ${territory.repName ?? "No rep"}`}
                      </option>
                    )),
                  )
                : groups.map((group) => (
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

  /** Asked before a territory change lets held work go. */
  function questionNote() {
    if (!asking) return null;
    const { work } = asking;
    const move = asking.move;
    // One piece of work on a tab behind this one: keeping it opens that tab.
    const backTo = work.length === 1 && work[0] !== activeTab ? work[0] : null;
    return (
      <div className="scroll-mt-24" ref={revealQuestion}>
        <CrmNote title="Change the territory?" tone="warn">
          <p>{`Changing the territory lets go of ${joinWords(work.map((key) => HELD_WORK[key]))}.`}</p>
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

  /** "My territory · My district" — over the Plan tab, for the one person who plans both weeks. */
  function planScopeSwitch(): ReactNode {
    return (
      <CrmPanel>
        <CrmBlock>
          <CrmChoice
            columns={2}
            label="Which week"
            onChange={setPlanScope}
            options={[
              { value: "territory", label: "My territory", note: "Your own customers, as a rep" },
              { value: "district", label: "My district", note: "Your week as district manager" },
            ]}
            value={planScope}
          />
        </CrmBlock>
      </CrmPanel>
    );
  }

  function tabContent(key: TabKey): ReactNode {
    const { cairoToday } = overview;
    // A district manager whose team is live plans HIS week here (owner, 2026-10-16) and logs his own
    // single visits on Visits; since 2026-10-17 so do the regional, national and product managers (a
    // product manager, with no territory, gets the single visits as the whole tab). Never a rep's screen:
    // the server sets `planner` for one of those four writers only.
    const managerPlanner = overview.managerPlans?.planner === true;
    if (key === "plan" && managerPlanner && (!viewer.isRep || planScope === "district")) {
      return (
        <div className="min-w-0 space-y-4">
          {viewer.isRep ? planScopeSwitch() : null}
          <ManagerPlanBoard key={`manager|${test}`} onChanged={refreshOverview} onDirtyChange={holdReporters.plan} test={test} />
        </div>
      );
    }
    if (key === "visits" && managerPlanner && seats.visits === null) return <ManagerSingleVisits key={`single|${test}`} test={test} />;
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
    if (key === "calendar") return <CalendarTab cairoToday={cairoToday} key={`calendar|${test}`} test={test} />;
    if (key === "forecast") {
      // The FORM is for the territory's OWN REP and nobody else — the Super Admin reached it in test
      // mode, which is retired, so he now reads the BOARD only, as the CEO and the SFE Manager always
      // did. The board is for whoever has the Team tab: the same readers, by the same rule.
      const cns = overview.territories.filter((territory) => isForecastLine(territory.lineCode));
      const formTerritories = viewer.isSuperAdmin ? [] : cns.filter((territory) => overview.ownSeatIds.includes(territory.seatId));
      return <ForecastTab formTerritories={formTerritories} key={`forecast|${test}`} showBoard={overview.tabs.team} test={test} />;
    }
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
        <div className="min-w-0 space-y-4">
          {managerPlanner ? <ManagerSingleVisits key={`single|${test}|${ownSingleVisitNonce}`} test={test} /> : null}
          <VisitsTab
            addNonce={addVisitNonce}
            // Answered once: a Visits tab let go and remounted later must not see the same ask again.
            onAddHandled={() => setAddVisitNonce(0)}
            openingDay={overview.visitDay}
            key={`${seatId}|${test}`}
            onOpenList={() => openTab("list")}
            onOwnSingleVisitSaved={() => setOwnSingleVisitNonce((current) => current + 1)}
            onPendingVisitDone={pendingVisitDone}
            onStartValidate={startValidate}
            onWorkChange={holdReporters.visits}
            pendingVisit={arrivedVisit ?? pendingVisit}
            seatId={seatId}
            test={test}
          />
        </div>
      );
    }
    if (key === "list") {
      return (
        <ListTab
          cairoToday={cairoToday}
          key={`${seatId}|${test}`}
          onPendingValidateDone={pendingValidateDone}
          onWorkChange={holdReporters.list}
          pendingValidate={arrivedValidate ?? pendingValidate}
          seatId={seatId}
          test={test}
        />
      );
    }
    return (
      <div className="min-w-0 space-y-4">
        {managerPlanner && viewer.isRep ? planScopeSwitch() : null}
        <PlanBoard
          key={`${seatId}|${test}`}
          onChanged={refreshOverview}
          onDirtyChange={holdReporters.plan}
          onOpenList={() => requestMove({ kind: "seat", seatId, tab: "list" })}
          seatId={seatId}
          test={test}
          weekNonce={planWeekNonce}
        />
      </div>
    );
  }

  // A tab's save bar sits above the portal's bottom navigation on a phone.
  const stickyOffset = { "--crm-sticky-bottom": surface === "portal" ? PORTAL_BOTTOM_BAR : "0px" } as CSSProperties;

  if (overview.closedMessage !== null || tabs.length === 0) {
    const sentences = openingSentences(overview);
    const reasons = sentences.length > 0 ? sentences : [overview.closedMessage ?? "Nothing in Phoenix CRM is open for you yet."];
    return (
      <CrmSurfaceProvider surface={surface}>
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
      </CrmSurfaceProvider>
    );
  }

  const seatTab = isSeatTab(activeTab) ? activeTab : null;

  // 🔴 THE PROVIDER WRAPS THE WHOLE PAGE, not each tab. Every screen below is lazily imported, so a
  // provider added per tab would have to be added again for the ninth one somebody writes — and the
  // tab that forgot it would silently serve a rep's controls to an admin, or an admin's to a rep.
  return (
    <CrmSurfaceProvider surface={surface}>
      <div className="min-w-0 scroll-mt-24 space-y-4" ref={topRef} style={stickyOffset}>
        {/* "Get Phoenix CRM messages on Telegram" (owner, 2026-10-02): at the top, for the reps and
            managers the notices go to, until the server says he is connected. */}
        {showsTelegramCard(overview.telegram) ? <TelegramConnectCard cairoToday={overview.cairoToday} /> : null}
        {standingNote()}
        {refreshNote()}
        {notice ? <CrmNote tone="warn">{notice}</CrmNote> : null}
        {waitingNote()}
        {tabBar()}
        {startGuideLink()}
        {seatTab ? territoryPicker(seatTab) : null}
        {questionNote()}
        {(single ? [activeTab] : tabs).map((key) => {
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
    </CrmSurfaceProvider>
  );
}
