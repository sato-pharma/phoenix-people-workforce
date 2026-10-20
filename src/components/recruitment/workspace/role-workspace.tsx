"use client";

// Recruitment workspace — the shell (owner, 19–20 Oct 2026: "retire and destroy the Recruitment
// workspace … rebuild from scratch", then the full phased plan).
//
// WHAT IT HOLDS. A pinned header — the role tabs, the place tabs with their counts and vacant seats,
// the filter bar — over the funnel and the candidates' bordered table; the bulk bar while rows are
// ticked; the 10-second Undo; the "N new CVs" bar; the "?" sheet.
//
// THE OPENED CV HALVES THE PAGE (owner, 20 Oct 2026: "i want the full page to be halfed and the cv 1
// page is fully appearing with no need to scroll … add the action buttons"). On a wide page the whole
// page splits 1fr / 1fr: everything above stays in the left half with the table, and the right half is
// the CV pane — pinned under the app's own bar, a FIXED height (the window less that bar), never
// scrolling as a whole: its header, the action bar and the tab row stay put and page 1 is fitted into
// the rest. Opening a CV first scrolls the page the few pixels it takes for the pane to be pinned, so
// page 1's foot is never under the window's edge. On a narrow page the CV is the same column as a
// full-screen sheet.
//
// NEEDS PLACING places by hand: the opened row there carries the "Place this candidate" form under it
// (Applying for, then the region, then only that region's areas, then that role's questions), so the
// CV reads whole on the right while HR types on the left; a save files the person and opens the next.
//
// THE URL IS THE ONLY STATE THAT OUTLIVES A PRESS. Tab, place, every filter and the opened CV are
// written to the address bar with `replaceState` as they change, so a copied link opens exactly this
// view — and a fresh visit to the page, with no query, starts clean (the owner's "filters start clean
// on every visit"). Nothing is kept in the browser's storage.
//
// NO RELOADS. Every fetch starts from an event handler — a tab press, a filter, a decision, the new-CVs
// bar — and decisions change the row in place (`use-workspace-actions.ts`). Nothing re-reads the list
// after a press; the counts are asked for again a second after the last change.
//
// WHO SEES WHAT IS THE SERVER'S. The role tabs this viewer is handed are already the Talent
// Acquisition fence's answer; the rows route applies the same fence; `canWork` false (the CEO) hides
// every action because every write route refuses him anyway.

import { BriefcaseBusiness, History, Keyboard } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createPortal } from "react-dom";

import { AdminCallout, AdminInsightChip } from "@/components/admin/admin-design-system";
import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import { PageContainer } from "@/components/layout/page-container";
import type { ManagerPickerOption } from "@/components/recruitment/manager-picker";
import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { RecruitmentEmptyState, RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { BulkBar } from "@/components/recruitment/workspace/bulk-bar";
import { CandidateTable, candidateTableFrameClassName } from "@/components/recruitment/workspace/candidate-table";
import type { CvPanel } from "@/components/recruitment/workspace/cv-actions";
import { FilterBar } from "@/components/recruitment/workspace/filter-bar";
import { FoldersTree, ManagersFolders, type ManagerShelfView } from "@/components/recruitment/workspace/folders-view";
import { FunnelStrip } from "@/components/recruitment/workspace/funnel-strip";
import { NewCvsBar } from "@/components/recruitment/workspace/new-cvs-bar";
import { OpenedCv } from "@/components/recruitment/workspace/opened-cv";
import { PlaceTabStrip } from "@/components/recruitment/workspace/place-tab-strip";
import { PlacingForm } from "@/components/recruitment/workspace/placing-form";
import { RoleTabStrip } from "@/components/recruitment/workspace/role-tab-strip";
import { RowSkeleton } from "@/components/recruitment/workspace/row-skeleton";
import { ShortcutSheet } from "@/components/recruitment/workspace/shortcut-sheet";
import { UndoToasts, WorkspaceNotice, useUndoQueue } from "@/components/recruitment/workspace/undo-toast";
import { useWorkspaceActions } from "@/components/recruitment/workspace/use-workspace-actions";
import { useWorkspaceCounts, useWorkspaceRows } from "@/components/recruitment/workspace/use-workspace-rows";
import { filterQuery, pageQuery } from "@/components/recruitment/workspace/workspace-format";
import { buildCvFolderTree, type CvFolderNode, type CvFolderRow } from "@/lib/recruitment/cv-folder-tree";
import { receivedRangeProblem, type WorkspaceFilters } from "@/lib/recruitment/workspace/filters";
import {
  FOLDERS_TAB,
  NEEDS_PLACING,
  isWorkspaceRoleTab,
  tabsWithRegions,
  workspaceTabLabels,
  type WorkspaceRoleTab,
  type WorkspaceTabKey,
} from "@/lib/recruitment/workspace/role-tabs";
import type {
  WorkspaceAnswerFilter,
  WorkspaceCounts,
  WorkspacePage,
  WorkspacePlaces,
  WorkspaceRow,
} from "@/lib/recruitment/workspace/types";
import { cn } from "@/lib/utils";

/** The page halves for an opened CV from this width of the page itself; below it the CV is a sheet. */
const SPLIT_MIN_WIDTH = 1100;
/** The gap kept between the pinned CV pane and the app's bar above it, and the window's foot below. */
const PANE_GAP_PX = 8;
/** The header pins from this width; on a phone it would eat the screen. */
const PIN_MIN_WIDTH = 1024;

export type RoleWorkspaceViewer = {
  canWork: boolean;
  /** May download the workbook: `recruitment: export`, read on the server. The CEO reads without it. */
  canExport: boolean;
  canHire: boolean;
  canDelete: boolean;
  roleTabs: WorkspaceRoleTab[];
  seesNeedsPlacing: boolean;
  /** The reader's own name, for an answer they add ("added by HR · Mona"). */
  name: string | null;
};

export type RoleWorkspaceProps = {
  today: string;
  viewer: RoleWorkspaceViewer;
  initialFilters: WorkspaceFilters;
  initialPage: WorkspacePage | null;
  initialPageError: string | null;
  initialCounts: WorkspaceCounts | null;
  initialPlaces: WorkspacePlaces | null;
  initialAnswerFilters: WorkspaceAnswerFilter[] | null;
  /** The CV a link opened, when it is not on the first page. */
  initialOpenedRow: WorkspaceRow | null;
  managers: ManagerPickerOption[];
  /** The hand-built folder tree, fenced: rows plus folder id -> candidate ids. */
  folderRows: CvFolderRow[];
  folderMembers: Record<string, string[]>;
  /** Null when the visit did not start on the Folders tab (they are read on request). */
  managerShelves: ManagerShelfView[] | null;
  /** Reads that failed on the server, named, so a blank part of the page is never mistaken for none. */
  unavailable: string[];
  /** What the link could not open ("That CV is not open to you …"), said once at the top. */
  notices: string[];
};

type Meta = { tab: WorkspaceTabKey; places: WorkspacePlaces | null; answerFilters: WorkspaceAnswerFilter[] | null };

function typingInField(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable;
}

/** What scrolls the page this element sits in: its nearest scrolling ancestor, else the document. */
function scrollerOf(element: HTMLElement): Element {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

function membersMap(record: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(record));
}

export function RoleWorkspace(props: RoleWorkspaceProps) {
  const { today, viewer } = props;
  const [filters, setFilters] = useState<WorkspaceFilters>(props.initialFilters);
  const filtersRef = useRef(props.initialFilters);
  const [meta, setMeta] = useState<Meta>({
    answerFilters: props.initialAnswerFilters,
    places: props.initialPlaces,
    tab: props.initialFilters.tab ?? NEEDS_PLACING,
  });
  const [extraRow, setExtraRow] = useState<WorkspaceRow | null>(props.initialOpenedRow);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const lastTicked = useRef<string | null>(null);
  const [panel, setPanel] = useState<CvPanel | null>(null);
  const [folderTree, setFolderTree] = useState<CvFolderNode[]>(() => buildCvFolderTree(props.folderRows, membersMap(props.folderMembers)));
  const [problems, setProblems] = useState<string[]>([]);
  const [shortcuts, setShortcuts] = useState(false);
  const [wide, setWide] = useState(true);
  const [pinned, setPinned] = useState(true);
  const [chrome, setChrome] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const rows = useWorkspaceRows({ error: props.initialPageError, page: props.initialPage });
  const counts = useWorkspaceCounts(props.initialCounts);
  const problem = useCallback((message: string) => setProblems((current) => [...current.slice(-2), message]), []);
  const undo = useUndoQueue(problem);

  const tab: WorkspaceTabKey = filters.tab ?? viewer.roleTabs[0] ?? NEEDS_PLACING;
  // `/recruitment` or the HR namespace's `/hr/recruitment` — the previous workspace sits under either.
  const pathname = usePathname();
  const router = useRouter();
  // Literal addresses, so the navigation guard can see the link (navigation-granted-but-unreachable).
  const previousHref = pathname?.startsWith("/hr/") ? "/hr/recruitment/previous" : "/recruitment/previous";
  const query = filterQuery(filters);

  // ── Measuring: the split, the pin, and the shell's own sticky chrome ─────────────────────────────
  useEffect(() => {
    const observers: ResizeObserver[] = [];
    // Both read the PAGE's own width: the split halves the page, so the half it leaves the list can
    // never be what decides whether it splits (that would flip it back and forth).
    const root = rootRef.current;
    if (root) {
      const observer = new ResizeObserver(([entry]) => {
        setPinned(entry.contentRect.width >= PIN_MIN_WIDTH);
        setWide(entry.contentRect.width >= SPLIT_MIN_WIDTH);
      });
      observer.observe(root);
      observers.push(observer);
    }
    const header = headerRef.current;
    if (header) {
      const observer = new ResizeObserver(() => setHeaderHeight(header.offsetHeight));
      observer.observe(header);
      observers.push(observer);
    }
    // The app shell's topbar is `sticky top-0` OUTSIDE the zoomed <main>; our header pins under it.
    const shell = document.querySelector<HTMLElement>(".phx-navrow-scope > .sticky");
    if (shell) {
      const observer = new ResizeObserver(() => setChrome(shell.offsetHeight));
      observer.observe(shell);
      observers.push(observer);
    }
    return () => observers.forEach((observer) => observer.disconnect());
  }, []);

  // ── Folders ──────────────────────────────────────────────────────────────────────────────────────
  const refreshFolders = useCallback(async () => {
    try {
      const data = await getJson("/api/recruitment/cv-folders");
      if (Array.isArray(data.folders)) setFolderTree(data.folders as CvFolderNode[]);
    } catch (error) {
      problem(error instanceof Error ? error.message : "The folders could not be re-read.");
    }
  }, [problem]);

  const actions = useWorkspaceActions({
    archivedMode: () => filtersRef.current.archived,
    canWork: viewer.canWork,
    countsSoon: () => counts.refreshSoon(filterQuery(filtersRef.current)),
    foldersChanged: () => void refreshFolders(),
    problem,
    push: undo.push,
    rows,
  });

  // ── The opened CV ────────────────────────────────────────────────────────────────────────────────
  const list = rows.state.rows;
  const openedId = filters.candidate;
  const openedIndex = openedId ? list.findIndex((row) => row.id === openedId) : -1;
  const openedRow = openedIndex >= 0 ? list[openedIndex] : extraRow && extraRow.id === openedId ? extraRow : null;

  // ── Writing state: the URL, then the reads ───────────────────────────────────────────────────────
  const writeUrl = useCallback((next: WorkspaceFilters) => {
    const search = pageQuery(next);
    const path = window.location.pathname;
    window.history.replaceState(window.history.state, "", search ? `${path}?${search}` : path);
  }, []);

  const loadMeta = useCallback(
    async (nextTab: WorkspaceTabKey) => {
      if (nextTab === FOLDERS_TAB) return;
      try {
        const data = await getJson(`/api/recruitment/workspace/meta?tab=${nextTab}`);
        setMeta({
          answerFilters: Array.isArray(data.answerFilters) ? (data.answerFilters as WorkspaceAnswerFilter[]) : null,
          places: (data.places as WorkspacePlaces | undefined) ?? null,
          tab: nextTab,
        });
      } catch {
        setMeta({ answerFilters: null, places: null, tab: nextTab });
      }
    },
    [],
  );

  const apply = useCallback(
    (next: WorkspaceFilters, options: { reload?: boolean; meta?: boolean } = {}) => {
      // Keep the opened CV on screen if the new list does not hold it.
      const current = filtersRef.current;
      if (options.reload && current.candidate) {
        const visible = rows.rowById(current.candidate);
        if (visible) setExtraRow(visible);
      }
      filtersRef.current = next;
      setFilters(next);
      writeUrl(next);
      if (options.reload) {
        const nextQuery = filterQuery(next);
        void rows.reload(nextQuery);
        void counts.refresh(nextQuery);
        setSelected(new Set());
      }
      if (options.meta && next.tab) void loadMeta(next.tab);
    },
    [counts, loadMeta, rows, writeUrl],
  );

  const changeTab = (nextTab: WorkspaceTabKey) => {
    if (nextTab === tab) return;
    setPanel(null);
    const leavingFolders = tab === FOLDERS_TAB || nextTab === FOLDERS_TAB;
    apply(
      {
        ...filtersRef.current,
        answers: {},
        area: null,
        candidate: null,
        folderIds: leavingFolders ? [] : filtersRef.current.folderIds,
        region: null,
        tab: nextTab,
      },
      { meta: true, reload: true },
    );
  };

  const open = (id: string | null) => {
    setPanel(null);
    apply({ ...filtersRef.current, candidate: id });
    if (!id) return;
    if (viewer.canWork) void postJson(`/api/recruitment/candidates/${id}/seen`, {}).catch(() => undefined);
    requestAnimationFrame(() => {
      // 1 — the half-page pane pins only once the page has scrolled past what sits above it; until then
      // its foot (and page 1's) is under the window's edge. Scroll exactly that far, never further.
      const pane = document.getElementById("ws-cv-pane");
      if (pane) {
        const scale = Number.parseFloat(getComputedStyle(pane).getPropertyValue("--phx-scale-applied")) || 1;
        const appBar = document.querySelector<HTMLElement>(".phx-navrow-scope > .sticky")?.offsetHeight ?? 0;
        const pinnedAt = appBar + PANE_GAP_PX * scale;
        const below = pane.getBoundingClientRect().top - pinnedAt;
        if (below > 1) scrollerOf(pane).scrollBy({ top: below });
      }
      // 2 — the row itself into view: the table's row on a wide page, the card on a phone.
      const target = [`ws-row-${id}`, `ws-card-${id}`]
        .map((key) => document.getElementById(key))
        .find((element) => element && element.getClientRects().length > 0);
      target?.scrollIntoView({ block: "nearest" });
    });
  };

  /** Open a CV that may not be on this list (the managers' folders, a search hit). */
  const openAnywhere = async (id: string) => {
    if (!rows.rowById(id)) {
      try {
        const data = await getJson(`/api/recruitment/workspace/rows?ids=${encodeURIComponent(id)}`);
        const found = Array.isArray(data.rows) ? (data.rows as WorkspaceRow[])[0] : undefined;
        if (!found) {
          problem("That CV is not open to you, or it is no longer in Recruitment.");
          return;
        }
        setExtraRow(found);
      } catch (error) {
        problem(error instanceof Error ? error.message : "That CV could not be opened.");
        return;
      }
    }
    open(id);
  };

  const step = (delta: 1 | -1) => {
    if (list.length === 0) return;
    if (openedIndex < 0) {
      open(list[delta === 1 ? 0 : list.length - 1].id);
      return;
    }
    const next = openedIndex + delta;
    if (next >= 0 && next < list.length) open(list[next].id);
    else if (next >= list.length && rows.state.nextCursor) void rows.loadMore(query);
  };

  const tick = (id: string, checked: boolean, withShift: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (withShift && lastTicked.current) {
        const from = list.findIndex((row) => row.id === lastTicked.current);
        const to = list.findIndex((row) => row.id === id);
        if (from >= 0 && to >= 0) {
          const [a, b] = from < to ? [from, to] : [to, from];
          for (const row of list.slice(a, b + 1)) {
            if (checked) next.add(row.id);
            else next.delete(row.id);
          }
          return next;
        }
      }
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    lastTicked.current = id;
  };

  // ── Paging: the next 50 arrive as the reader nears the end ───────────────────────────────────────
  const nextCursor = rows.state.nextCursor;
  const loadingMore = rows.state.loadingMore;
  const loadMore = rows.loadMore;
  const listLoading = rows.state.loading;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loadingMore) void loadMore(query);
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [listLoading, loadMore, loadingMore, nextCursor, query]);

  // ── The keyboard ─────────────────────────────────────────────────────────────────────────────────
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keys.current = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (typingInField(event.target)) return;
      const key = event.key;
      if (key === "?") {
        event.preventDefault();
        setShortcuts((value) => !value);
        return;
      }
      if (key === "Escape") {
        if (shortcuts) setShortcuts(false);
        else if (panel) setPanel(null);
        else if (filtersRef.current.candidate) open(null);
        return;
      }
      if (key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (key === "ArrowDown" || key === "j") {
        event.preventDefault();
        step(1);
        return;
      }
      if (key === "ArrowUp" || key === "k") {
        event.preventDefault();
        step(-1);
        return;
      }
      if (key === "u") {
        undo.undoLatest();
        return;
      }
      if (!openedRow || !viewer.canWork) return;
      if (key === "x") tick(openedRow.id, !selected.has(openedRow.id), false);
      else if (key === "s" && openedRow.status !== "hired") void actions.decide([openedRow.id], "shortlisted");
      else if (key === "b" && openedRow.status !== "hired") void actions.decide([openedRow.id], "backup");
      else if (key === "r" && openedRow.status !== "hired") setPanel("reject");
      else if (key === "m" && openedRow.status !== "hired") setPanel("manager");
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // ── What the screen shows ────────────────────────────────────────────────────────────────────────
  const tabCounts = counts.counts?.byTab ?? null;
  const answerOptions = useMemo(() => {
    const out: Record<string, { value: string; label: string }[]> = {};
    for (const filter of meta.answerFilters ?? []) out[filter.key] = filter.options;
    return out;
  }, [meta.answerFilters]);
  const selectedRows = list.filter((row) => selected.has(row.id));
  const newest = list.reduce<string | null>((latest, row) => (!latest || row.receivedAt > latest ? row.receivedAt : latest), null);
  const searching = filters.search.length > 0;
  const rangeProblem = receivedRangeProblem(filters);
  const showSplit = wide && openedRow !== null;
  const roleTab = isWorkspaceRoleTab(tab) ? tab : null;
  const exportHref = !viewer.canExport || (tab === FOLDERS_TAB && filters.folderIds.length === 0) ? null : `/api/recruitment/workspace/export?${query}`;
  const stickyTop = `calc(var(--ws-chrome, 0px) / var(--phx-scale-applied, 1))`;
  const rootStyle = { "--ws-chrome": `${chrome}px` } as CSSProperties;
  const nextAfter = (id: string): string | null => {
    const at = list.findIndex((row) => row.id === id);
    if (at < 0) return null;
    return list[at + 1]?.id ?? list[at - 1]?.id ?? null;
  };
  // The pane pins under the app's bar and is exactly the window less that bar: a HEIGHT, not a cap, so
  // the CV inside has a definite box to fit page 1 into.
  const cvTop = `calc(var(--ws-chrome, 0px) / var(--phx-scale-applied, 1) + ${PANE_GAP_PX}px)`;
  const cvHeight = `calc(100vh / var(--phx-scale-applied, 1) - var(--ws-chrome, 0px) / var(--phx-scale-applied, 1) - ${PANE_GAP_PX * 2}px)`;
  // A row scrolled into view stops below the pinned header, never under it.
  const rowMargin = `calc(var(--ws-chrome, 0px) / var(--phx-scale-applied, 1) + ${pinned ? headerHeight : 0}px + 8px)`;

  const emptyMessage = searching
    ? `Nobody in your tabs matches “${filters.search}”. Search reads names, phone numbers, emails and the CV's own text.`
    : tab === NEEDS_PLACING
      ? "Every CV is in its tab. A CV lands here when the applicant's reply did not say which role — place it by hand or ask again on WhatsApp."
      : tab === FOLDERS_TAB
        ? "Choose a folder on the left to see its CVs, or file CVs into a folder from any tab."
        : filters.region || filters.area || Object.keys(filters.answers).length || filters.statuses.length
          ? "No CV here matches these filters. Clear a filter, or choose another region."
          : `No ${workspaceTabLabels[tab]} CVs yet. They arrive here as applicants answer the WhatsApp bot or the careers form.`;

  const opened = openedRow ? (
    <OpenedCv
      actions={actions}
      answerOptions={answerOptions}
      canDelete={viewer.canDelete}
      canHire={viewer.canHire}
      canWork={viewer.canWork}
      folders={folderTree}
      hasNext={openedIndex >= 0 && (openedIndex < list.length - 1 || Boolean(rows.state.nextCursor))}
      hasPrevious={openedIndex > 0}
      fill
      layout={showSplit ? "split" : "sheet"}
      managers={props.managers}
      onClose={() => open(null)}
      onNext={() => step(1)}
      onPanel={setPanel}
      onPrevious={() => step(-1)}
      panel={panel}
      position={openedIndex >= 0 ? `${openedIndex + 1} of ${counts.counts?.total ?? list.length}` : null}
      roleTabs={viewer.roleTabs}
      row={openedRow}
      today={today}
      viewerName={viewer.name}
      viewingTab={tab}
    />
  ) : null;

  const rowList = (
    <div className={candidateTableFrameClassName}>
      <NewCvsBar key={query} onShow={() => void rows.reload(query)} query={query} since={newest} />
      {rows.state.error ? (
        <div className="p-3">
          <WorkspaceNotice message={rows.state.error} onClose={rows.clearError} />
        </div>
      ) : null}
      {rows.state.loading ? (
        <RowSkeleton />
      ) : list.length === 0 ? (
        <RecruitmentEmptyState
          action={
            filters.search || Object.keys(filters.answers).length || filters.statuses.length ? (
              <button
                className="text-sm font-bold text-orange-700 underline-offset-2 hover:underline"
                onClick={() => apply({ ...filtersRef.current, answers: {}, search: "", statuses: [] }, { reload: true })}
                type="button"
              >
                Clear the search and filters
              </button>
            ) : undefined
          }
          message={emptyMessage}
          title={searching ? "No match" : "Nothing here yet"}
        />
      ) : (
        <div style={{ "--ws-row-margin": rowMargin } as CSSProperties}>
          <CandidateTable
            answerOptions={answerOptions}
            canEdit={viewer.canWork}
            canSelect={viewer.canWork}
            detailFor={
              // Needs placing: the opened row carries the placing form, with the CV whole beside it. On a
              // narrow page the CV is a sheet over the list, and "Place in a tab" in its bar opens the same form.
              tab === NEEDS_PLACING && viewer.canWork && showSplit
                ? (row) => (
                    <PlacingForm
                      actions={actions}
                      editorName={viewer.name}
                      key={row.id}
                      leaves={row.placements.length === 0}
                      onClose={() => open(null)}
                      onPlaced={() => open(nextAfter(row.id))}
                      roleTabs={viewer.roleTabs}
                      row={row}
                    />
                  )
                : undefined
            }
            onSaveAnswer={viewer.canWork ? (target, chip, value) => actions.saveAnswer(target, chip, value, viewer.name) : undefined}
            onSelect={viewer.canWork ? tick : undefined}
            onToggle={(id) => open(filters.candidate === id ? null : id)}
            openedId={openedId}
            rows={list}
            selected={selected}
            showEveryPlacement={searching || tab === FOLDERS_TAB}
            today={today}
            viewingTab={tab}
          />
        </div>
      )}
      {rows.state.nextCursor && !rows.state.loading ? (
        <div className="flex justify-center border-t border-slate-100 p-3" ref={sentinelRef}>
          <button
            className="text-sm font-bold text-orange-700 underline-offset-2 hover:underline disabled:opacity-50"
            disabled={rows.state.loadingMore}
            onClick={() => void rows.loadMore(query)}
            type="button"
          >
            {rows.state.loadingMore ? "Loading the next 50…" : "Load the next 50"}
          </button>
        </div>
      ) : null}
      {viewer.canWork ? (
        <BulkBar
          actions={actions}
          allOnPageTicked={list.length > 0 && list.every((row) => selected.has(row.id))}
          folders={folderTree}
          managers={props.managers}
          onClear={() => setSelected(new Set())}
          onTickPage={() => setSelected(new Set(list.map((row) => row.id)))}
          rows={selectedRows}
        />
      ) : null}
    </div>
  );

  return (
    <PageContainer>
      <div
        className={cn("min-w-0", showSplit ? "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-3" : null)}
        ref={rootRef}
        style={rootStyle}
      >
        <div className="@container min-w-0 space-y-3">
          <RecruitmentPageHeader
            actions={
              <>
                <button
                  className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-white/20"
                  onClick={() => setShortcuts(true)}
                  type="button"
                >
                  <Keyboard aria-hidden className="h-3.5 w-3.5" />
                  Shortcuts
                </button>
                <a
                  className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-white/20"
                  href={previousHref}
                >
                  <History aria-hidden className="h-3.5 w-3.5" />
                  Previous workspace
                </a>
              </>
            }
            badges={
              tabCounts ? (
                <>
                  {viewer.seesNeedsPlacing && (tabCounts[NEEDS_PLACING] ?? 0) > 0 ? (
                    <AdminInsightChip tone="orange">{`${tabCounts[NEEDS_PLACING]} need placing`}</AdminInsightChip>
                  ) : null}
                  {!viewer.canWork ? <AdminInsightChip tone="slate">Read only</AdminInsightChip> : null}
                </>
              ) : null
            }
            description="Every CV filed by the role the applicant chose, with their answers on the row. Decide, send, book and file without leaving the list."
            eyebrow="People Management"
            icon={<BriefcaseBusiness className="h-3.5 w-3.5" />}
            title="Recruitment"
          />

          {props.notices.map((message) => (
            <AdminCallout key={message} tone="warning">
              {message}
            </AdminCallout>
          ))}
          {props.unavailable.length > 0 ? (
            <AdminCallout tone="warning">{`Not loaded just now: ${props.unavailable.join(", ")}. The rest of the page is current.`}</AdminCallout>
          ) : null}
          {problems.map((message, index) => (
            <WorkspaceNotice key={`${index}-${message}`} message={message} onClose={() => setProblems((current) => current.filter((_, at) => at !== index))} />
          ))}

          <div
            className={cn("space-y-3 bg-[#F3F6FA] pb-3", pinned ? "sticky z-30 pt-1" : null)}
            ref={headerRef}
            style={pinned ? { top: stickyTop } : undefined}
          >
            <RoleTabStrip
              counts={tabCounts}
              onChange={changeTab}
              roleTabs={viewer.roleTabs}
              seesNeedsPlacing={viewer.seesNeedsPlacing}
              value={tab}
            />
            {roleTab && !searching && tabsWithRegions.includes(roleTab) ? (
              <PlaceTabStrip
                area={filters.area}
                byPlace={counts.counts?.byPlace}
                onChange={(place) => apply({ ...filtersRef.current, ...place }, { reload: true })}
                places={meta.tab === tab ? meta.places : null}
                region={filters.region}
                tab={roleTab}
                tabCount={tabCounts?.[roleTab] ?? null}
              />
            ) : null}
            <FilterBar
              answerFilters={meta.tab === tab ? meta.answerFilters : []}
              byStatus={counts.counts?.byStatus}
              exportHref={exportHref}
              filters={filters}
              folders={folderTree}
              key={tab}
              onChange={(next) => apply(next, { reload: true })}
              onSearch={(value) => apply({ ...filtersRef.current, search: value }, { reload: true })}
              rangeProblem={rangeProblem}
              searchRef={searchRef}
              total={counts.counts?.total ?? null}
            />
          </div>

          {tab !== FOLDERS_TAB ? <FunnelStrip funnel={counts.counts?.funnel ?? null} unavailable={!counts.counts} /> : null}

          {searching ? (
            <p className="text-xs font-semibold text-slate-600">
              {`Searching every tab you can see for “${filters.search}”. Each result says which tab it sits in.`}
            </p>
          ) : null}

          <div className={cn(tab === FOLDERS_TAB ? "grid grid-cols-1 items-start gap-4 @min-[1100px]:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]" : null)}>
            {tab === FOLDERS_TAB ? (
              <div className="min-w-0 space-y-4">
                <FoldersTree
                  canManage={viewer.canWork}
                  onChanged={refreshFolders}
                  onSelect={(id) => apply({ ...filtersRef.current, candidate: null, folderIds: id ? [id] : [] }, { reload: true })}
                  selectedId={filters.folderIds[0] ?? null}
                  tree={folderTree}
                />
                <ManagersFolders
                  onLoad={() => {
                    // The page reads the managers' shelves for a visit on the Folders tab; ask it again.
                    router.push(`${pathname ?? "/recruitment"}?${pageQuery({ ...filtersRef.current, tab: FOLDERS_TAB })}`, { scroll: false });
                  }}
                  onOpenCandidate={(id) => void openAnywhere(id)}
                  shelves={props.managerShelves}
                />
              </div>
            ) : null}
            <div className="min-w-0">{rowList}</div>
          </div>
        </div>
        {showSplit ? (
          <div
            className={`sticky min-w-0 self-start overflow-hidden border border-slate-200 bg-white ${adminPanelDepthClassName}`}
            id="ws-cv-pane"
            style={{ height: cvHeight, top: cvTop }}
          >
            {opened}
          </div>
        ) : null}
      </div>

      {!showSplit && opened && typeof document !== "undefined"
        ? createPortal(
            <div aria-label={`CV of ${openedRow?.name ?? ""}`} aria-modal="true" className="fixed inset-0 z-[60] overflow-hidden bg-white" role="dialog">
              {opened}
            </div>,
            document.body,
          )
        : null}
      <ShortcutSheet onClose={() => setShortcuts(false)} open={shortcuts} />
      <UndoToasts entries={undo.entries} onUndo={undo.undo} />
      <span className="sr-only" aria-live="polite">
        {openedRow ? `Opened ${openedRow.name}, ${workspaceTabLabels[tab]}` : ""}
      </span>
    </PageContainer>
  );
}
