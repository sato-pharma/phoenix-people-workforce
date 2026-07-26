"use client";

// Recruitment / ATS — drag-and-drop review board for CV extraction.
//
// One draggable "chip" per string field that was extracted (its value, plus a low-confidence
// badge). Each field also has a droppable slot; dropping a chip into a slot assigns that
// value to that field — dropping onto an occupied slot swaps the bumped chip back to the
// unassigned pool. "Populate" resets every slot to the original field-to-value mapping
// (the default state on load). Clicking a chip switches it into an inline text edit so the
// VALUE itself can be corrected, not just which slot it sits in. Boolean fields (extracted
// judgments, not extracted text) are plain Yes/No/Not-stated selects, not draggable chips.
//
// Schema-driven (src/lib/recruitment/cv-field-schemas.ts) — works for any position's field
// list, not just Medical Rep.

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";

import { Button } from "@/components/ui/button";
import type { ExtractedField, ExtractedFieldConfidence } from "@/lib/recruitment/cv-extraction";
import type { CvFieldDefinition, CvPositionSchema } from "@/lib/recruitment/cv-field-schemas";

const POOL_ID = "__pool__";

function slotId(fieldKey: string) {
  return `slot:${fieldKey}`;
}

type ChipData = { key: string; value: string; confidence: ExtractedFieldConfidence };

function toBoolDraft(value: string | boolean | null | undefined): "" | "true" | "false" {
  return value === true ? "true" : value === false ? "false" : "";
}

function toStringValue(value: string | boolean | null | undefined): string {
  return typeof value === "string" ? value : "";
}

export type CvExtractionReviewBoardProps = {
  schema: CvPositionSchema;
  fields: Record<string, ExtractedField<string | boolean | null>>;
  busy?: boolean;
  error?: string | null;
  saveLabel?: string;
  onSave: (values: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
};

function Chip({ chip, isEditing, onEdit, onCommitEdit }: {
  chip: ChipData;
  isEditing: boolean;
  onEdit: (key: string | null) => void;
  onCommitEdit: (key: string, value: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: chip.key });
  const style = { transform: CSS.Translate.toString(transform) };

  if (isEditing) {
    return (
      <input
        autoFocus
        className="w-full rounded-md border border-orange-300 bg-white px-2 py-1 text-sm outline-none"
        defaultValue={chip.value}
        onBlur={(event) => onCommitEdit(chip.key, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") onEdit(null);
        }}
      />
    );
  }

  return (
    <div
      className={`flex cursor-grab items-center gap-1.5 rounded-md border px-2 py-1 text-sm active:cursor-grabbing ${
        isDragging ? "opacity-40" : "border-gray-200 bg-white"
      }`}
      onClick={() => onEdit(chip.key)}
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
    >
      <span className="min-w-0 flex-1 truncate">{chip.value || <span className="text-slate-400">(empty)</span>}</span>
      {chip.confidence === "low" ? (
        <span className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1 py-0.5 text-[10px] font-semibold text-amber-700">
          Check this
        </span>
      ) : null}
    </div>
  );
}

function DroppableArea({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div className={`${className ?? ""} ${isOver ? "ring-2 ring-orange-300" : ""}`} ref={setNodeRef}>
      {children}
    </div>
  );
}

export function CvExtractionReviewBoard({
  schema,
  fields,
  busy = false,
  error,
  saveLabel = "Save candidate",
  onSave,
  onCancel,
}: CvExtractionReviewBoardProps) {
  const stringFields = useMemo(() => schema.fields.filter((field) => field.type === "string"), [schema]);
  const boolFields = useMemo(() => schema.fields.filter((field) => field.type === "boolean"), [schema]);

  const chips = useMemo(() => {
    const map: Record<string, ChipData> = {};
    for (const field of stringFields) {
      const extracted = fields[field.key];
      map[field.key] = { confidence: extracted?.confidence ?? "low", key: field.key, value: toStringValue(extracted?.value) };
    }
    return map;
  }, [fields, stringFields]);

  // Default state: every field's slot holds its own chip — "Populate" resets to this.
  const defaultAssignment = useMemo(() => {
    const assignment: Record<string, string | null> = {};
    for (const field of stringFields) assignment[field.key] = field.key;
    return assignment;
  }, [stringFields]);

  const [slotAssignment, setSlotAssignment] = useState<Record<string, string | null>>(defaultAssignment);
  const [chipValues, setChipValues] = useState<Record<string, string>>(() => {
    const values: Record<string, string> = {};
    for (const key of Object.keys(chips)) values[key] = chips[key].value;
    return values;
  });
  const [booleanValues, setBooleanValues] = useState<Record<string, "" | "true" | "false">>(() => {
    const values: Record<string, "" | "true" | "false"> = {};
    for (const field of boolFields) values[field.key] = toBoolDraft(fields[field.key]?.value);
    return values;
  });
  const [editingChip, setEditingChip] = useState<string | null>(null);
  const [activeChip, setActiveChip] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const isFieldVisible = (field: CvFieldDefinition): boolean => {
    if (!field.showWhen) return true;
    return booleanValues[field.showWhen.field] === (field.showWhen.equals ? "true" : "false");
  };

  const poolChipKeys = stringFields
    .map((field) => field.key)
    .filter((key) => !Object.values(slotAssignment).includes(key));

  const handleDragStart = (event: DragStartEvent) => setActiveChip(String(event.active.id));

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveChip(null);
    const { active, over } = event;
    if (!over) return;
    const chipKey = String(active.id);
    const overId = String(over.id);

    setSlotAssignment((prev) => {
      const next = { ...prev };
      // Clear the chip from wherever it currently sits.
      for (const key of Object.keys(next)) {
        if (next[key] === chipKey) next[key] = null;
      }
      if (overId === POOL_ID) return next;
      const targetField = overId.startsWith("slot:") ? overId.slice(5) : null;
      if (!targetField) return next;
      // Bump whatever chip currently occupies the target slot back to the pool.
      next[targetField] = chipKey;
      return next;
    });
  };

  const applyAiPopulate = () => setSlotAssignment(defaultAssignment);

  const commitEdit = (chipKey: string, value: string) => {
    setChipValues((prev) => ({ ...prev, [chipKey]: value }));
    setEditingChip(null);
  };

  const buildValues = (): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    for (const field of schema.fields) {
      const visible = isFieldVisible(field);
      if (field.type === "boolean") {
        const raw = booleanValues[field.key];
        values[field.key] = raw === "true" ? true : raw === "false" ? false : null;
        continue;
      }
      if (!visible) {
        values[field.key] = null;
        continue;
      }
      const assignedChipKey = slotAssignment[field.key];
      values[field.key] = assignedChipKey ? (chipValues[assignedChipKey] ?? "").trim() || null : null;
    }
    return values;
  };

  const chipDisplay = (chipKey: string): ChipData => ({
    confidence: chips[chipKey]?.confidence ?? "low",
    key: chipKey,
    value: chipValues[chipKey] ?? "",
  });

  return (
    <DndContext onDragEnd={handleDragEnd} onDragStart={handleDragStart} sensors={sensors}>
      <div className="space-y-3 rounded border border-slate-200 bg-slate-50/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Drag a field into the right column, or drag one out to leave it blank. Populate resets everything to the original suggested values.
          </p>
          <Button onClick={applyAiPopulate} size="sm" type="button" variant="secondary">
            Populate
          </Button>
        </div>
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}

        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Unassigned</p>
          <DroppableArea className="flex min-h-[42px] flex-wrap gap-2 rounded-md border border-dashed border-gray-300 bg-white p-2" id={POOL_ID}>
            {poolChipKeys.length === 0 ? (
              <span className="px-1 py-1 text-xs text-slate-400">Nothing unassigned.</span>
            ) : (
              poolChipKeys.map((key) => (
                <Chip
                  chip={chipDisplay(key)}
                  isEditing={editingChip === key}
                  key={key}
                  onCommitEdit={commitEdit}
                  onEdit={setEditingChip}
                />
              ))
            )}
          </DroppableArea>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stringFields.filter(isFieldVisible).map((field) => {
            const assignedChipKey = slotAssignment[field.key];
            return (
              <div key={field.key}>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{field.label}</p>
                <DroppableArea className="min-h-[42px] rounded-md border border-gray-200 bg-white p-1.5" id={slotId(field.key)}>
                  {assignedChipKey ? (
                    <Chip
                      chip={chipDisplay(assignedChipKey)}
                      isEditing={editingChip === assignedChipKey}
                      onCommitEdit={commitEdit}
                      onEdit={setEditingChip}
                    />
                  ) : (
                    <span className="block px-1 py-1 text-xs text-slate-400">Drop a field here</span>
                  )}
                </DroppableArea>
              </div>
            );
          })}

          {boolFields.map((field) => (
            <div key={field.key}>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{field.label}</p>
              <select
                className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                onChange={(event) =>
                  setBooleanValues((prev) => ({ ...prev, [field.key]: event.target.value as "" | "true" | "false" }))
                }
                value={booleanValues[field.key] ?? ""}
              >
                <option value="">Not stated</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => void onSave(buildValues())}>
            {saveLabel}
          </Button>
          <Button disabled={busy} onClick={onCancel} variant="ghost">
            Cancel
          </Button>
        </div>
      </div>

      <DragOverlay>
        {activeChip ? (
          <div className="flex items-center gap-1.5 rounded-md border border-orange-300 bg-white px-2 py-1 text-sm shadow-lg">
            {chipValues[activeChip] || <span className="text-slate-400">(empty)</span>}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
