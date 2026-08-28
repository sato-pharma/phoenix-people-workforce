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
import { EyeOff, GripVertical, PanelBottom, PanelTop, Pin, RotateCcw, Save } from "lucide-react";

import {
  applyPersonalLayout,
  HORIZONTAL_ZONES,
  PERSONAL_LAYOUT_VERSION,
  type HorizontalZoneKey,
  type PersonalNavigationLayout,
} from "@/lib/navigation/personal-layout";

type CataloguePage = { href: string; label: string };
type CatalogueSection = { id: string; label: string; items: CataloguePage[] };

/**
 * Editable state. Every href in the catalogue lives in exactly ONE of these places: one of the
 * three horizontal zones, one sidebar section, or hidden.
 *
 * The zones are keyed by `HorizontalZoneKey` rather than written out as three fields so that the
 * editor iterates the same HORIZONTAL_ZONES list the layout model exports — adding a fourth zone
 * later means adding it there, not finding every place here that enumerates three.
 */
type EditorState = {
  zones: Record<HorizontalZoneKey, string[]>;
  sections: { id: string; label: string; items: string[] }[];
  hidden: string[];
};

const HIDDEN = "hidden";
const SECTION_PREFIX = "section:";
const ZONE_KEYS: readonly HorizontalZoneKey[] = HORIZONTAL_ZONES.map((zone) => zone.key);

/** A zone's own key doubles as its drop-container id — they are already unique strings. */
function isZoneId(containerId: string): containerId is HorizontalZoneKey {
  return (ZONE_KEYS as readonly string[]).includes(containerId);
}

/**
 * Build the editable state from the catalogue and whatever was saved.
 *
 * Reconciliation goes through the SAME applyPersonalLayout the live sidebar uses, rather than a
 * second copy of the rules. That is what guarantees the arrangement shown here is the arrangement
 * that will render — including the fallback for pages added since the layout was saved, which
 * appear in their original module instead of silently vanishing.
 */
function buildInitialState(catalogue: CatalogueSection[], saved: PersonalNavigationLayout | null): EditorState {
  const applied = applyPersonalLayout(catalogue, saved);
  const known = new Set(catalogue.flatMap((section) => section.items.map((item) => item.href)));
  return {
    zones: {
      strip: applied.strip.map((item) => item.href),
      upperRow: applied.upperRow.map((item) => item.href),
      lowerRow: applied.lowerRow.map((item) => item.href),
    },
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
    strip: state.zones.strip,
    upperRow: state.zones.upperRow,
    lowerRow: state.zones.lowerRow,
    sections: state.sections.map((section) => ({ id: section.id, label: section.label, items: section.items })),
    hidden: state.hidden,
  };
}

function containerIdOf(state: EditorState, href: string): string | null {
  for (const key of ZONE_KEYS) {
    if (state.zones[key].includes(href)) return key;
  }
  if (state.hidden.includes(href)) return HIDDEN;
  const section = state.sections.find((entry) => entry.items.includes(href));
  return section ? `${SECTION_PREFIX}${section.id}` : null;
}

function readContainer(state: EditorState, containerId: string): string[] {
  if (isZoneId(containerId)) return state.zones[containerId];
  if (containerId === HIDDEN) return state.hidden;
  return state.sections.find((entry) => `${SECTION_PREFIX}${entry.id}` === containerId)?.items ?? [];
}

function writeContainer(state: EditorState, containerId: string, items: string[]): EditorState {
  if (isZoneId(containerId)) {
    // Written out rather than as `{ ...state.zones, [containerId]: items }`: a computed key whose
    // type is a union widens the result to an index signature, which no longer satisfies
    // Record<HorizontalZoneKey, string[]>.
    const zones = { ...state.zones };
    zones[containerId] = items;
    return { ...state, zones };
  }
  if (containerId === HIDDEN) return { ...state, hidden: items };
  return {
    ...state,
    sections: state.sections.map((entry) =>
      `${SECTION_PREFIX}${entry.id}` === containerId ? { ...entry, items } : entry,
    ),
  };
}

/** One icon per horizontal zone, so the three columns are told apart at a glance rather than read. */
const ZONE_ICON: Record<HorizontalZoneKey, ReactNode> = {
  strip: <Pin className="h-3.5 w-3.5 shrink-0 text-[#F8B56B]" />,
  upperRow: <PanelTop className="h-3.5 w-3.5 shrink-0 text-[#F8B56B]" />,
  lowerRow: <PanelBottom className="h-3.5 w-3.5 shrink-0 text-[#F8B56B]" />,
};

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
      {hint ? <p className="whitespace-nowrap px-3 pt-2 text-phx-xs text-slate-500">{hint}</p> : null}
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

  // Which container is the drop target? `over.id` is either a container's own id (dropped on empty
  // space) or an href sitting inside one.
  function resolveContainer(id: string): string | null {
    if (isZoneId(id) || id === HIDDEN || id.startsWith(SECTION_PREFIX)) return id;
    return containerIdOf(state, id);
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    const from = containerIdOf(state, String(active.id));
    const to = resolveContainer(String(over.id));
    if (!from || !to || from === to) return;

    setState((current) => {
      const source = readContainer(current, from).filter((href) => href !== active.id);
      const target = readContainer(current, to);
      const overIndex = target.indexOf(String(over.id));
      const insertAt = overIndex === -1 ? target.length : overIndex;
      const nextTarget = [...target.slice(0, insertAt), String(active.id), ...target.slice(insertAt)];
      return writeContainer(writeContainer(current, from, source), to, nextTarget);
    });
    setDirty(true);
  }

  function handleDragEnd(event: DragEndEvent) {
    setDragging(null);
    const { active, over } = event;
    if (!over) return;
    const container = containerIdOf(state, String(active.id));
    if (!container) return;
    const items = readContainer(state, container);
    const oldIndex = items.indexOf(String(active.id));
    const newIndex = items.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
    setState((current) => writeContainer(current, container, arrayMove(readContainer(current, container), oldIndex, newIndex)));
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
      setStatus({ tone: "ok", text: "Saved. Your sidebar has been rearranged." });
      setDirty(false);
      // The sidebar is rendered server-side from the stored layout, so it only picks up the change
      // on a refresh — without this the editor would say "saved" beside an unchanged sidebar.
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
      setStatus({ tone: "ok", text: "Reset. Your sidebar is back to the standard arrangement." });
      setDirty(false);
      router.refresh();
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "The layout could not be reset." });
    } finally {
      setBusy(false);
    }
  }

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

      <DndContext
        collisionDetection={closestCorners}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))}
        sensors={sensors}
      >
        {/* The three horizontal zones, in the order they appear down the page, then Hidden. Drag a
            page between any of them and the modules below — that free exchange between the row
            above the page title and the row below it is the whole point of this screen. */}
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
          {HORIZONTAL_ZONES.map((zone) => (
            <DropColumn
              accent="zone"
              containerId={zone.key}
              hint={zone.hint}
              icon={ZONE_ICON[zone.key]}
              items={state.zones[zone.key]}
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
