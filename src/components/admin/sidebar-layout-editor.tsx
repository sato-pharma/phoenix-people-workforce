"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EyeOff, GripVertical, LayoutList, PanelBottom, PanelTop, Pin, RotateCcw, Save } from "lucide-react";

import {
  applyPersonalLayout,
  HORIZONTAL_ZONES,
  PERSONAL_LAYOUT_VERSION,
  type PersonalLayoutRowSet,
  type PersonalNavigationLayout,
} from "@/lib/navigation/personal-layout";

type CataloguePage = { href: string; label: string };
type CatalogueSection = { id: string; label: string; items: CataloguePage[] };

/** The two rows, as the editor holds them (mutable, unlike the stored readonly shape). */
type EditableRows = { upperRow: string[]; lowerRow: string[] };

/**
 * Editable state.
 *
 * `rows` is the DEFAULT pair of horizontal rows — what renders in any module with no arrangement of
 * its own. `moduleRows` holds the per-module overrides the owner asked for on 2026-08-28: "in the
 * marketing and ROI, I want to have [tabs] related in the horizontal like this. But in sales, I want
 * to have another." A module present in `moduleRows` replaces the defaults while you are inside it.
 *
 * The strip, the sidebar sections and Hidden are NOT per-module: the sidebar does not change as you
 * move between modules, and nobody asked it to.
 */
type EditorState = {
  strip: string[];
  rows: EditableRows;
  moduleRows: Record<string, EditableRows>;
  sections: { id: string; label: string; items: string[] }[];
  hidden: string[];
};

/**
 * Which arrangement the row columns are editing: `null` is the default pair, a string is that
 * module's own pair. Held next to the state rather than inside it because it is a view, not data —
 * saving must produce the same document whichever module happens to be selected.
 */
type Scope = string | null;

const STRIP = "strip";
const UPPER = "upperRow";
const LOWER = "lowerRow";
const HIDDEN = "hidden";
const AVAILABLE = "available";
const SECTION_PREFIX = "section:";

/** One icon per column, so they are told apart at a glance rather than read. */
const ZONE_ICON: Record<string, ReactNode> = {
  [STRIP]: <Pin className="h-3.5 w-3.5 shrink-0 text-[#F8B56B]" />,
  [UPPER]: <PanelTop className="h-3.5 w-3.5 shrink-0 text-[#F8B56B]" />,
  [LOWER]: <PanelBottom className="h-3.5 w-3.5 shrink-0 text-[#F8B56B]" />,
};

const emptyRows = (): EditableRows => ({ upperRow: [], lowerRow: [] });
const cloneRows = (rows: PersonalLayoutRowSet): EditableRows => ({
  upperRow: [...rows.upperRow],
  lowerRow: [...rows.lowerRow],
});

/**
 * Build the editable state from the catalogue and whatever was saved.
 *
 * Reconciliation goes through the SAME applyPersonalLayout the live navigation uses, rather than a
 * second copy of the rules. That is what guarantees the arrangement shown here is the arrangement
 * that will render — including the fallback for pages added since the layout was saved, which
 * appear in their original module instead of silently vanishing.
 */
function buildInitialState(catalogue: CatalogueSection[], saved: PersonalNavigationLayout | null): EditorState {
  const applied = applyPersonalLayout(catalogue, saved);
  const known = new Set(catalogue.flatMap((section) => section.items.map((item) => item.href)));
  const moduleRows: Record<string, EditableRows> = {};
  for (const [moduleId, rows] of Object.entries(saved?.moduleRows ?? {})) {
    moduleRows[moduleId] = cloneRows(rows);
  }
  return {
    strip: applied.strip.map((item) => item.href),
    // applyPersonalLayout was called with no active module, so these are the DEFAULT rows.
    rows: { upperRow: applied.upperRow.map((i) => i.href), lowerRow: applied.lowerRow.map((i) => i.href) },
    moduleRows,
    sections: applied.sections.map((section) => ({
      id: section.id,
      label: section.label,
      items: section.items.map((item) => item.href),
    })),
    // applyPersonalLayout drops hidden hrefs from its output, so they are read from the saved
    // document directly — filtered to what this viewer can actually reach, so a stale hidden entry
    // for a page they no longer have cannot linger invisibly in the saved document.
    hidden: (saved?.hidden ?? []).filter((href) => known.has(href)),
  };
}

function toLayout(state: EditorState): PersonalNavigationLayout {
  return {
    version: PERSONAL_LAYOUT_VERSION,
    strip: state.strip,
    upperRow: state.rows.upperRow,
    lowerRow: state.rows.lowerRow,
    moduleRows: state.moduleRows,
    sections: state.sections.map((section) => ({ id: section.id, label: section.label, items: section.items })),
    hidden: state.hidden,
  };
}

/** The pair of rows the columns are currently editing. */
function rowsForScope(state: EditorState, scope: Scope): EditableRows {
  if (!scope) return state.rows;
  return state.moduleRows[scope] ?? emptyRows();
}

function containerIdOf(state: EditorState, scope: Scope, available: string[], href: string): string | null {
  const rows = rowsForScope(state, scope);
  if (rows.upperRow.includes(href)) return UPPER;
  if (rows.lowerRow.includes(href)) return LOWER;
  if (scope) {
    // In module scope the only other place a page can be is the pool of pages not yet placed.
    return available.includes(href) ? AVAILABLE : null;
  }
  if (state.strip.includes(href)) return STRIP;
  if (state.hidden.includes(href)) return HIDDEN;
  const section = state.sections.find((entry) => entry.items.includes(href));
  return section ? `${SECTION_PREFIX}${section.id}` : null;
}

function readContainer(state: EditorState, scope: Scope, available: string[], containerId: string): string[] {
  const rows = rowsForScope(state, scope);
  if (containerId === UPPER) return rows.upperRow;
  if (containerId === LOWER) return rows.lowerRow;
  if (containerId === AVAILABLE) return available;
  if (containerId === STRIP) return state.strip;
  if (containerId === HIDDEN) return state.hidden;
  return state.sections.find((entry) => `${SECTION_PREFIX}${entry.id}` === containerId)?.items ?? [];
}

function writeContainer(state: EditorState, scope: Scope, containerId: string, items: string[]): EditorState {
  if (containerId === UPPER || containerId === LOWER) {
    // Written out rather than as `{ ...rows, [containerId]: items }`: a computed key whose type is
    // not a literal widens the object to an index signature, which no longer satisfies EditableRows.
    const current = rowsForScope(state, scope);
    const next: EditableRows =
      containerId === UPPER ? { ...current, upperRow: items } : { ...current, lowerRow: items };
    if (!scope) return { ...state, rows: next };
    return { ...state, moduleRows: { ...state.moduleRows, [scope]: next } };
  }
  if (containerId === STRIP) return { ...state, strip: items };
  if (containerId === HIDDEN) return { ...state, hidden: items };
  return {
    ...state,
    sections: state.sections.map((entry) =>
      `${SECTION_PREFIX}${entry.id}` === containerId ? { ...entry, items } : entry,
    ),
  };
}

function DraggableRow({ href, label }: { href: string; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: href });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex w-max min-w-full items-center gap-2 border border-slate-200 bg-white px-2.5 py-2 ${
        isDragging ? "opacity-40" : "hover:border-slate-300"
      }`}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-slate-400" />
      {/* Owner rule: never truncate with an ellipsis and never let a label wrap. The row grows
          instead, and the column scrolls sideways if it must. */}
      <span className="whitespace-nowrap text-phx-md font-medium text-slate-700">{label}</span>
      <span className="ml-auto whitespace-nowrap pl-3 text-phx-xs text-slate-400">{href}</span>
    </div>
  );
}

function DropColumn({
  containerId,
  title,
  hint,
  items,
  labelOf,
  accent,
  icon,
  onRename,
}: {
  containerId: string;
  title: string;
  hint?: string;
  items: string[];
  labelOf: Map<string, string>;
  accent?: "zone" | "hidden";
  icon?: ReactNode;
  onRename?: (label: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: containerId });
  const border =
    accent === "zone"
      ? "border-[#F8B56B]"
      : accent === "hidden"
        ? "border-slate-300 border-dashed"
        : "border-slate-200";

  return (
    <div className={`flex min-w-0 flex-col border ${border} bg-[#FBFCFE] ${isOver ? "ring-2 ring-[#F8B56B]" : ""}`}>
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
        {icon}
        {onRename ? (
          <input
            aria-label={`Rename ${title}`}
            className="min-w-0 flex-1 whitespace-nowrap border-none bg-transparent text-phx-md font-bold text-slate-800 outline-none focus:bg-slate-50"
            onChange={(event) => onRename(event.target.value)}
            value={title}
          />
        ) : (
          <span className="whitespace-nowrap text-phx-md font-bold text-slate-800">{title}</span>
        )}
        <span className="ml-auto whitespace-nowrap text-phx-xs text-slate-400">{items.length}</span>
      </div>
      {hint ? (
        <div className="overflow-x-auto px-3 pt-2">
          <p className="whitespace-nowrap text-phx-xs text-slate-500">{hint}</p>
        </div>
      ) : null}
      <div ref={setNodeRef} className="min-h-[64px] space-y-1.5 overflow-x-auto p-2">
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          {items.map((href) => (
            <DraggableRow href={href} key={href} label={labelOf.get(href) ?? href} />
          ))}
        </SortableContext>
        {items.length === 0 ? (
          <p className="px-1 py-3 text-phx-xs text-slate-400">Drop a page here.</p>
        ) : null}
      </div>
    </div>
  );
}

export function SidebarLayoutEditor({
  catalogue,
  pageCount,
  savedLayout,
}: {
  catalogue: CatalogueSection[];
  pageCount: number;
  savedLayout: PersonalNavigationLayout | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<EditorState>(() => buildInitialState(catalogue, savedLayout));
  const [scope, setScope] = useState<Scope>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const labelOf = useMemo(
    () => new Map(catalogue.flatMap((section) => section.items.map((item) => [item.href, item.label] as const))),
    [catalogue],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * The pool of pages a module arrangement can draw from: everything the viewer can reach that is
   * not already in one of that module's two rows, with the module's OWN pages first — those are
   * what he will reach for, and hunting for them in a list of 243 is the difference between the
   * screen being usable and not.
   */
  function poolFor(current: EditorState, moduleId: string): string[] {
    const rows = rowsForScope(current, moduleId);
    // Hidden pages are excluded: `applyPersonalLayout` refuses to place a hidden href anywhere, so
    // offering one here would let him drag a tab into a row and watch nothing appear.
    const unavailable = new Set([...rows.upperRow, ...rows.lowerRow, ...current.hidden]);
    const own = catalogue.find((section) => section.id === moduleId)?.items.map((item) => item.href) ?? [];
    const ownSet = new Set(own);
    const rest = catalogue
      .flatMap((section) => section.items.map((item) => item.href))
      .filter((href) => !ownSet.has(href));
    return [...own, ...rest].filter((href) => !unavailable.has(href));
  }

  // Computed on the click that changes scope, never in an effect — setState inside useEffect is a
  // lint error in this repo, and an effect would also render one frame with the wrong pool.
  function changeScope(next: Scope) {
    setScope(next);
    setAvailable(next ? poolFor(state, next) : []);
  }

  /** Give a module its own rows, seeded from the defaults so it starts from what he already sees. */
  function createOverride(moduleId: string) {
    // The next state is computed once and used for BOTH writes. An updater form here would leave
    // `poolFor` reading the state from before the override existed, so the seeded tabs would appear
    // in the rows AND in the pool — the same href twice, which is a duplicate drag id.
    const next: EditorState = {
      ...state,
      moduleRows: { ...state.moduleRows, [moduleId]: cloneRows(state.rows) },
    };
    setState(next);
    setAvailable(poolFor(next, moduleId));
    setDirty(true);
  }

  /** Drop a module's own rows so it falls back to the defaults again. */
  function clearOverride(moduleId: string) {
    setState((current) => {
      const next = { ...current.moduleRows };
      delete next[moduleId];
      return { ...current, moduleRows: next };
    });
    setAvailable([]);
    setScope(null);
    setDirty(true);
  }

  // Which container is the drop target? `over.id` is either a container's own id (dropped on empty
  // space) or an href sitting inside one.
  function resolveContainer(id: string): string | null {
    if (id === STRIP || id === UPPER || id === LOWER || id === HIDDEN || id === AVAILABLE) return id;
    if (id.startsWith(SECTION_PREFIX)) return id;
    return containerIdOf(state, scope, available, id);
  }

  function moveBetweenContainers(from: string, to: string, activeId: string, overId: string) {
    // The pool is view state, not part of the saved document, so it is written separately.
    const source = readContainer(state, scope, available, from).filter((href) => href !== activeId);
    const target = readContainer(state, scope, available, to);
    const overIndex = target.indexOf(overId);
    const insertAt = overIndex === -1 ? target.length : overIndex;
    const nextTarget = [...target.slice(0, insertAt), activeId, ...target.slice(insertAt)];

    if (from === AVAILABLE) setAvailable(source);
    if (to === AVAILABLE) setAvailable(nextTarget);
    setState((current) => {
      let next = current;
      if (from !== AVAILABLE) next = writeContainer(next, scope, from, source);
      if (to !== AVAILABLE) next = writeContainer(next, scope, to, nextTarget);
      return next;
    });
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    const from = containerIdOf(state, scope, available, String(active.id));
    const to = resolveContainer(String(over.id));
    if (!from || !to || from === to) return;
    moveBetweenContainers(from, to, String(active.id), String(over.id));
    setDirty(true);
  }

  function handleDragEnd(event: DragEndEvent) {
    setDragging(null);
    const { active, over } = event;
    if (!over) return;
    const container = containerIdOf(state, scope, available, String(active.id));
    if (!container) return;
    const items = readContainer(state, scope, available, container);
    const oldIndex = items.indexOf(String(active.id));
    const newIndex = items.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
    const reordered = arrayMove(items, oldIndex, newIndex);
    if (container === AVAILABLE) setAvailable(reordered);
    else setState((current) => writeContainer(current, scope, container, reordered));
    setDirty(true);
  }

  function renameSection(sectionId: string, label: string) {
    setState((current) => ({
      ...current,
      sections: current.sections.map((entry) => (entry.id === sectionId ? { ...entry, label } : entry)),
    }));
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/navigation/personal-layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: toLayout(state) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "The layout could not be saved.");
      setStatus({ tone: "ok", text: "Saved. Your navigation has been rearranged." });
      setDirty(false);
      // The navigation is rendered server-side from the stored layout, so it only picks up the
      // change on a refresh — without this the editor would say "saved" beside an unchanged nav.
      router.refresh();
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "The layout could not be saved." });
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/navigation/personal-layout", { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "The layout could not be reset.");
      setState(buildInitialState(catalogue, null));
      setScope(null);
      setAvailable([]);
      setStatus({ tone: "ok", text: "Reset. Your navigation is back to the standard arrangement." });
      setDirty(false);
      router.refresh();
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "The layout could not be reset." });
    } finally {
      setBusy(false);
    }
  }

  const rows = rowsForScope(state, scope);
  const scopeLabel = scope
    ? state.sections.find((section) => section.id === scope)?.label ??
      catalogue.find((section) => section.id === scope)?.label ??
      scope
    : null;
  const scopeHasOwnRows = scope !== null && state.moduleRows[scope] !== undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3">
        <span className="whitespace-nowrap text-phx-md text-slate-600">
          {pageCount} pages you can reach, across {catalogue.length} modules.
        </span>
        {dirty ? (
          <span className="whitespace-nowrap bg-[#FEF3C7] px-2 py-0.5 text-phx-xs font-semibold text-[#92400E]">
            Unsaved changes
          </span>
        ) : null}
        {status ? (
          <span
            className={`whitespace-nowrap text-phx-sm font-medium ${
              status.tone === "ok" ? "text-emerald-700" : "text-red-700"
            }`}
          >
            {status.text}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 whitespace-nowrap border border-slate-300 px-3 py-1.5 text-phx-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            disabled={busy}
            onClick={reset}
            type="button"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to standard
          </button>
          <button
            className="flex items-center gap-1.5 whitespace-nowrap bg-phx-ink px-3.5 py-1.5 text-phx-sm font-semibold text-white hover:bg-[#1E293B] disabled:opacity-50"
            disabled={busy || !dirty}
            onClick={save}
            type="button"
          >
            <Save className="h-3.5 w-3.5" />
            {busy ? "Saving…" : "Save layout"}
          </button>
        </div>
      </div>

      {/* WHICH MODULE THE TWO ROWS ARE BEING ARRANGED FOR.
          The owner's ask: marketing tabs in the rows while inside Marketing & ROI, a different set
          inside Sales. A module with no arrangement of its own shows the default pair, so this
          starts as one arrangement and only grows where he wants it to. */}
      <div className="border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <LayoutList className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <span className="whitespace-nowrap text-phx-md font-bold text-slate-800">Rows shown in</span>
          <button
            className={`whitespace-nowrap border px-2.5 py-1 text-phx-sm font-semibold ${
              scope === null
                ? "border-[#F8B56B] bg-[#FFF7ED] text-[#92400E]"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
            onClick={() => changeScope(null)}
            type="button"
          >
            Every module
          </button>
          {catalogue.map((section) => {
            const label = state.sections.find((entry) => entry.id === section.id)?.label ?? section.label;
            const own = state.moduleRows[section.id] !== undefined;
            return (
              <button
                className={`whitespace-nowrap border px-2.5 py-1 text-phx-sm font-semibold ${
                  scope === section.id
                    ? "border-[#F8B56B] bg-[#FFF7ED] text-[#92400E]"
                    : own
                      ? "border-[#F8B56B] text-[#92400E] hover:bg-[#FFF7ED]"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
                key={section.id}
                onClick={() => changeScope(section.id)}
                type="button"
              >
                {label}
                {own ? " ·" : ""}
              </button>
            );
          })}
        </div>
        <div className="mt-2 overflow-x-auto">
          <p className="whitespace-nowrap text-phx-xs text-slate-500">
            {scope === null
              ? "The default pair of rows — shown in every module that has no arrangement of its own. A module with one is marked ·"
              : scopeHasOwnRows
                ? `These two rows replace the default pair while you are anywhere inside ${scopeLabel}.`
                : `${scopeLabel} currently shows the default rows. Give it its own to put different tabs there.`}
          </p>
        </div>
        {scope !== null ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {scopeHasOwnRows ? (
              <button
                className="flex items-center gap-1.5 whitespace-nowrap border border-slate-300 px-3 py-1.5 text-phx-sm font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => clearOverride(scope)}
                type="button"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Use the default rows here
              </button>
            ) : (
              <button
                className="flex items-center gap-1.5 whitespace-nowrap bg-phx-ink px-3.5 py-1.5 text-phx-sm font-semibold text-white hover:bg-[#1E293B]"
                onClick={() => createOverride(scope)}
                type="button"
              >
                <PanelTop className="h-3.5 w-3.5" />
                Give {scopeLabel} its own rows
              </button>
            )}
          </div>
        ) : null}
      </div>

      <DndContext
        collisionDetection={closestCorners}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))}
        sensors={sensors}
      >
        {scope === null ? (
          <>
            {/* The three horizontal zones, in the order they appear down the page, then Hidden.
                Drag a page between any of them and the modules below — that free exchange between
                the row above the page title and the row below it is the point of this screen. */}
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
              {HORIZONTAL_ZONES.map((zone) => (
                <DropColumn
                  accent="zone"
                  containerId={zone.key}
                  hint={zone.hint}
                  icon={ZONE_ICON[zone.key]}
                  items={zone.key === STRIP ? state.strip : rows[zone.key === UPPER ? "upperRow" : "lowerRow"]}
                  key={zone.key}
                  labelOf={labelOf}
                  title={zone.label}
                />
              ))}
              <DropColumn
                accent="hidden"
                containerId={HIDDEN}
                hint="Hidden from your navigation. This only affects what you see — it removes no access."
                icon={<EyeOff className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
                items={state.hidden}
                labelOf={labelOf}
                title="Hidden"
              />
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {state.sections.map((section) => (
                <DropColumn
                  containerId={`${SECTION_PREFIX}${section.id}`}
                  items={section.items}
                  key={section.id}
                  labelOf={labelOf}
                  onRename={(label) => renameSection(section.id, label)}
                  title={section.label}
                />
              ))}
            </div>
          </>
        ) : scopeHasOwnRows ? (
          // Module scope edits only the two rows. The strip, Hidden and the sidebar modules are
          // deliberately absent: they are not per-module, and showing them here would invite a drag
          // that looks local and is not.
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <DropColumn
              accent="zone"
              containerId={UPPER}
              hint={`Above the page title, inside ${scopeLabel}.`}
              icon={ZONE_ICON[UPPER]}
              items={rows.upperRow}
              labelOf={labelOf}
              title="Upper nav row"
            />
            <DropColumn
              accent="zone"
              containerId={LOWER}
              hint={`Below the page title, inside ${scopeLabel}.`}
              icon={ZONE_ICON[LOWER]}
              items={rows.lowerRow}
              labelOf={labelOf}
              title="Lower nav row"
            />
            <DropColumn
              containerId={AVAILABLE}
              hint={`Every page you can reach. ${scopeLabel} pages are listed first.`}
              items={available}
              labelOf={labelOf}
              title="Pages you can add"
            />
          </div>
        ) : null}

        <DragOverlay>
          {dragging ? (
            <div className="flex items-center gap-2 border border-[#F8B56B] bg-white px-2.5 py-2 shadow-lg">
              <GripVertical className="h-3.5 w-3.5 text-slate-400" />
              <span className="whitespace-nowrap text-phx-md font-medium text-slate-700">
                {labelOf.get(dragging) ?? dragging}
              </span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
