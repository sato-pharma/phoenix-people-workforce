"use client";

// Recruitment / ATS — drag-and-drop review board for CV extraction.
//
// One draggable "chip" per scalar field that was extracted (its value, plus a low-confidence
// badge). Each field also has a droppable slot; dropping a chip into a slot assigns that
// value to that field — dropping onto an occupied slot swaps the bumped chip back to the
// unassigned pool. "Populate" resets every slot to the original field-to-value mapping
// (the default state on load). Clicking a chip switches it into an inline text edit so the
// VALUE itself can be corrected, not just which slot it sits in. Boolean fields (extracted
// judgments, not extracted text) are plain Yes/No/Not-stated selects, not draggable chips.
//
// Schema-driven (src/lib/recruitment/cv-field-schemas.ts) — works for whatever field list the
// schema declares, and fields are grouped by section because the universal schema carries 36 of
// them where the old Medical Rep template carried 12.
//
// THREE field shapes, and every one of them must round-trip. This board's save writes EVERY
// schema field, so a shape it does not understand is not merely unshown — it is written back as
// null and the value is destroyed. That is exactly what happened to `date`, `number` and `array`
// fields when the schema gained them: the chip list matched only `type === "string"`, so date of
// birth, graduation year and all five history blocks had no slot and buildValues nulled them on
// every save. Hence:
//   • string | date | number → chips (a text input; coerced back on save)
//   • boolean                → a select
//   • array (repeating block) → its own card list, entries removable but not free-text edited
// If a fourth shape is ever added to CvFieldType, it MUST be handled in buildValues before it
// ships, or it will silently blank on the first review.
//
// THE LOOK (2026-10-19 premium sweep). Every state a value can be in reads at a glance, square and
// in the module's colours: a slot holding a value carries an emerald rule (it will be saved), an
// empty slot is a dashed drop target, the Unassigned tray is dashed rose while it holds anything
// (those values are not saved) and turns emerald when it is empty, an irrelevant field is
// a dashed grey well, and a value the reader was unsure of wears an amber "Check this" chip. The
// footer is the form's own pair: the orange commit and the plain Cancel.

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
import { AlertCircle, CheckCircle2, GripVertical, Inbox, RotateCcw, Save, X } from "lucide-react";

import type { ExtractedCvValue, ExtractedField, ExtractedFieldConfidence } from "@/lib/recruitment/cv-extraction";
import {
  CV_FIELD_SECTIONS,
  fieldIsIrrelevant,
  type CvFieldDefinition,
  type CvPositionSchema,
  type CvSubFieldDefinition,
} from "@/lib/recruitment/cv-field-schemas";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import { cn } from "@/lib/utils";

/** The micro-caps label over every slot, select and block. */
const fieldLabelClassName = "mb-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500";

/** A section's heading: the module's orange tick, then the section name on a hairline. */
function SectionHeading({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 border-b border-slate-200 pb-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-slate-700">
      <span aria-hidden="true" className="h-3 w-0.5 bg-orange-500" />
      {children}
    </p>
  );
}

const POOL_ID = "__pool__";

function slotId(fieldKey: string) {
  return `slot:${fieldKey}`;
}

type ChipData = { key: string; value: string; confidence: ExtractedFieldConfidence };

// The field types that are edited as a text chip. `date` is a YYYY-MM-DD string and `number` is
// typed as digits, so all three share one editor; only the save coercion differs.
const CHIP_TYPES: ReadonlySet<string> = new Set(["string", "date", "number"]);

function toBoolDraft(value: ExtractedCvValue | undefined): "" | "true" | "false" {
  return value === true ? "true" : value === false ? "false" : "";
}

function toStringValue(value: ExtractedCvValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function toBlockEntries(value: ExtractedCvValue | undefined): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

export type CvExtractionReviewBoardProps = {
  schema: CvPositionSchema;
  fields: Record<string, ExtractedField<ExtractedCvValue>>;
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
        className={phxFieldClassName}
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
      className={cn(
        `flex cursor-grab items-start gap-1.5 border px-2 py-1 text-sm text-slate-900 transition-colors active:cursor-grabbing ${adminChipDepthClassName}`,
        isDragging
          ? "border-dashed border-orange-300 bg-orange-50/40 opacity-40"
          : "border-slate-200 bg-white hover:border-orange-300",
      )}
      onClick={() => onEdit(chip.key)}
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
    >
      <GripVertical aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300" />
      {/* break-words, never truncate: the universal schema carries a professional summary and
          per-role responsibilities, and a reviewer cannot check a value they can only see half of. */}
      <span className="min-w-0 flex-1 break-words" dir="auto">
        {chip.value || <span className="text-slate-400">(empty)</span>}
      </span>
      {chip.confidence === "low" ? (
        <span className="shrink-0 border border-amber-300 bg-amber-50 px-1 py-0.5 text-phx-2xs font-bold uppercase tracking-[0.06em] text-amber-800">
          Check this
        </span>
      ) : null}
    </div>
  );
}

function DroppableArea({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div className={`${className ?? ""} ${isOver ? "ring-2 ring-orange-400 ring-offset-1" : ""}`} ref={setNodeRef}>
      {children}
    </div>
  );
}

function subValueText(subField: CvSubFieldDefinition, raw: unknown): string | null {
  if (subField.type === "boolean") return typeof raw === "boolean" ? (raw ? "Yes" : "No") : null;
  if (subField.type === "number") return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

// A repeating block. Entries are shown in full and can be removed — the realistic review action is
// "the model invented this row" or "this one is a duplicate", not rewriting six sub-fields inline.
// Whatever is left is saved verbatim, so nothing the AI read is lost by passing through here.
function BlockCard({
  field,
  entries,
  onRemove,
}: {
  field: CvFieldDefinition;
  entries: Array<Record<string, unknown>>;
  onRemove: (fieldKey: string, index: number) => void;
}) {
  const itemFields = field.itemFields ?? [];
  return (
    <div>
      <p className={fieldLabelClassName}>
        {field.label} <span className="text-slate-300">·</span> {entries.length}{" "}
        {entries.length === 1 ? "entry" : "entries"}
      </p>
      {entries.length === 0 ? (
        <p className="border border-dashed border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-400">
          The CV listed none.
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry, index) => {
            const lines = itemFields
              .map((subField) => ({ subField, text: subValueText(subField, entry[subField.key]) }))
              .filter((line): line is { subField: CvSubFieldDefinition; text: string } => line.text !== null);
            return (
              <div
                className={`border border-slate-200 border-l-[3px] border-l-emerald-500 bg-white px-2.5 py-2 ${adminSoftDepthClassName}`}
                key={index}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {lines.length === 0 ? (
                      <p className="text-xs text-slate-400">(empty entry)</p>
                    ) : (
                      lines.map(({ subField, text }) => (
                        <p className="break-words text-xs leading-5 text-slate-700" dir="auto" key={subField.key}>
                          <span className="font-medium text-slate-500">{subField.label}:</span> {text}
                        </p>
                      ))
                    )}
                  </div>
                  <button
                    className={`inline-flex shrink-0 items-center gap-1 border border-slate-200 bg-white px-1.5 py-0.5 text-phx-xs font-semibold text-slate-500 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 ${adminControlDepthClassName}`}
                    onClick={() => onRemove(field.key, index)}
                    type="button"
                  >
                    <X aria-hidden="true" className="h-3 w-3" />
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
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
  const chipFields = useMemo(() => schema.fields.filter((field) => CHIP_TYPES.has(field.type)), [schema]);
  const boolFields = useMemo(() => schema.fields.filter((field) => field.type === "boolean"), [schema]);
  const blockFields = useMemo(() => schema.fields.filter((field) => field.type === "array"), [schema]);

  const chips = useMemo(() => {
    const map: Record<string, ChipData> = {};
    for (const field of chipFields) {
      const extracted = fields[field.key];
      map[field.key] = { confidence: extracted?.confidence ?? "low", key: field.key, value: toStringValue(extracted?.value) };
    }
    return map;
  }, [fields, chipFields]);

  // Default state: every field's slot holds its own chip — "Populate" resets to this.
  const defaultAssignment = useMemo(() => {
    const assignment: Record<string, string | null> = {};
    for (const field of chipFields) assignment[field.key] = field.key;
    return assignment;
  }, [chipFields]);

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
  const [blockValues, setBlockValues] = useState<Record<string, Array<Record<string, unknown>>>>(() => {
    const values: Record<string, Array<Record<string, unknown>>> = {};
    for (const field of blockFields) values[field.key] = toBlockEntries(fields[field.key]?.value);
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

  // The live (draft) text of a chip field — whatever chip currently sits in its slot. Used so
  // `irrelevantWhen` reacts to the gender the reviewer is looking at right now, not the original.
  const fieldTextValue = (fieldKey: string): string | null => {
    const assigned = slotAssignment[fieldKey];
    const text = assigned ? (chipValues[assigned] ?? "") : "";
    return text.trim() ? text : null;
  };
  const fieldIrrelevant = (field: CvFieldDefinition): boolean => fieldIsIrrelevant(field, fieldTextValue);

  const poolChipKeys = chipFields
    .map((field) => field.key)
    .filter((key) => !Object.values(slotAssignment).includes(key))
    // Don't leave a military-status chip floating in the pool for a female candidate.
    .filter((key) => {
      const field = chipFields.find((entry) => entry.key === key);
      return !(field && fieldIrrelevant(field));
    });

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

  const removeBlockEntry = (fieldKey: string, index: number) => {
    setBlockValues((prev) => ({ ...prev, [fieldKey]: (prev[fieldKey] ?? []).filter((_, i) => i !== index) }));
  };

  const buildValues = (): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    for (const field of schema.fields) {
      if (field.type === "boolean") {
        const raw = booleanValues[field.key];
        values[field.key] = raw === "true" ? true : raw === "false" ? false : null;
        continue;
      }
      if (field.type === "array") {
        // Always an array, never null — "the CV listed none" and "nobody looked" must stay
        // distinguishable, and the PATCH route merges rather than replaces.
        values[field.key] = blockValues[field.key] ?? [];
        continue;
      }
      if (fieldIrrelevant(field)) {
        // Irrelevant for this candidate (e.g. military status for a female) — never persist a value.
        values[field.key] = null;
        continue;
      }
      if (!isFieldVisible(field)) {
        values[field.key] = null;
        continue;
      }
      const assignedChipKey = slotAssignment[field.key];
      const text = assignedChipKey ? (chipValues[assignedChipKey] ?? "").trim() : "";
      if (!text) {
        values[field.key] = null;
        continue;
      }
      if (field.type === "number") {
        // A chip can be dragged into any slot, so the text in a number slot is not guaranteed
        // numeric. Send null rather than NaN — the column is nullable and a wrong number is worse
        // than a blank one.
        const parsed = Number(text);
        values[field.key] = Number.isFinite(parsed) ? parsed : null;
        continue;
      }
      values[field.key] = text;
    }
    return values;
  };

  const chipDisplay = (chipKey: string): ChipData => ({
    confidence: chips[chipKey]?.confidence ?? "low",
    key: chipKey,
    value: chipValues[chipKey] ?? "",
  });

  // Sections in schema order, each carrying only the fields it actually holds.
  const sections = CV_FIELD_SECTIONS.map((section) => ({
    ...section,
    blocks: blockFields.filter((field) => field.section === section.key),
    bools: boolFields.filter((field) => field.section === section.key),
    chipsInSection: chipFields.filter((field) => field.section === section.key && isFieldVisible(field)),
  })).filter((section) => section.chipsInSection.length + section.bools.length + section.blocks.length > 0);

  return (
    <DndContext onDragEnd={handleDragEnd} onDragStart={handleDragStart} sensors={sensors}>
      <div className={`space-y-4 border border-slate-200 bg-slate-50/60 p-4 ${adminRecessedDepthClassName}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 grow basis-72 space-y-2">
            <p className="text-xs font-medium leading-5 text-slate-600">
              Drag a field into the right column, or drag one out to leave it blank. Populate resets everything to the original suggested values.
            </p>
            {/* The four states, named once, so the colours below never have to be guessed. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-phx-2xs font-bold uppercase tracking-[0.06em] text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2.5 w-2.5 border-l-[3px] border-l-emerald-500 bg-emerald-100" />
                Saved
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2.5 w-2.5 border border-dashed border-slate-400 bg-white" />
                Empty slot
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2.5 w-2.5 border border-dashed border-rose-300 bg-rose-50" />
                Not saved
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2.5 w-2.5 border border-amber-300 bg-amber-50" />
                Check this
              </span>
            </div>
          </div>
          <button
            className={`${phxButtonGhostClassName} ${adminControlDepthClassName}`}
            onClick={applyAiPopulate}
            type="button"
          >
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
            Populate
          </button>
        </div>
        {error ? (
          <p
            className="flex items-start gap-2 border border-rose-200 border-l-[3px] border-l-rose-500 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800"
            role="alert"
          >
            <AlertCircle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        ) : null}

        <div>
          <p className={cn(fieldLabelClassName, "flex flex-wrap items-center gap-x-2")}>
            <Inbox aria-hidden="true" className="h-3 w-3 text-slate-400" />
            Unassigned
            {poolChipKeys.length > 0 ? (
              <span className="font-semibold normal-case tracking-normal text-rose-700">
                {poolChipKeys.length} not saved
              </span>
            ) : null}
          </p>
          <DroppableArea
            className={cn(
              "flex min-h-[42px] flex-wrap gap-2 border border-dashed p-2",
              poolChipKeys.length === 0 ? "border-emerald-300 bg-emerald-50/40" : "border-rose-300 bg-rose-50/40",
            )}
            id={POOL_ID}
          >
            {poolChipKeys.length === 0 ? (
              <span className="inline-flex items-center gap-1.5 px-1 py-1 text-xs font-medium text-emerald-800">
                <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
                Nothing unassigned.
              </span>
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

        {sections.map((section) => (
          <div className="space-y-2" key={section.key}>
            <SectionHeading>{section.label}</SectionHeading>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {section.chipsInSection.map((field) => {
                const assignedChipKey = slotAssignment[field.key];
                if (fieldIrrelevant(field)) {
                  return (
                    <div key={field.key}>
                      <p className={fieldLabelClassName}>{field.label}</p>
                      <div
                        className={`flex min-h-[42px] items-center border border-dashed border-slate-200 bg-slate-50 px-2 text-xs italic text-slate-400 ${adminRecessedDepthClassName}`}
                      >
                        Irrelevant
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={field.key}>
                    <p className={fieldLabelClassName}>{field.label}</p>
                    <DroppableArea
                      className={cn(
                        "min-h-[42px] border p-1.5",
                        assignedChipKey
                          ? `border-slate-200 border-l-[3px] border-l-emerald-500 bg-emerald-50/40 ${adminRecessedDepthClassName}`
                          : "border-dashed border-slate-300 bg-white",
                      )}
                      id={slotId(field.key)}
                    >
                      {assignedChipKey ? (
                        <Chip
                          chip={chipDisplay(assignedChipKey)}
                          isEditing={editingChip === assignedChipKey}
                          onCommitEdit={commitEdit}
                          onEdit={setEditingChip}
                        />
                      ) : (
                        <span className="block px-1 py-1 text-xs italic text-slate-400">Drop a field here</span>
                      )}
                    </DroppableArea>
                  </div>
                );
              })}

              {section.bools.map((field) => (
                <div key={field.key}>
                  <p className={fieldLabelClassName}>{field.label}</p>
                  <select
                    className={phxSelectClassName}
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

            {section.blocks.length > 0 ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {section.blocks.map((field) => (
                  <BlockCard entries={blockValues[field.key] ?? []} field={field} key={field.key} onRemove={removeBlockEntry} />
                ))}
              </div>
            ) : null}
          </div>
        ))}

        {/* The form's own pair: orange is the one terminal commit, Cancel is plain. Green stays
            reserved for a decision pair (form-tokens.ts) — saving a review is not one. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
          <button
            className={`${phxButtonAccentClassName} ${adminControlDepthClassName} disabled:shadow-none`}
            disabled={busy}
            onClick={() => void onSave(buildValues())}
            type="button"
          >
            <Save aria-hidden="true" className="h-3.5 w-3.5" />
            {saveLabel}
          </button>
          <button
            className={`${phxButtonGhostClassName} ${adminControlDepthClassName} disabled:shadow-none`}
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>

      <DragOverlay>
        {activeChip ? (
          <div className="flex items-center gap-1.5 border border-orange-400 bg-white px-2 py-1 text-sm text-slate-900 shadow-[0_12px_28px_rgba(15,23,42,0.18)]">
            <GripVertical aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-orange-400" />
            {chipValues[activeChip] || <span className="text-slate-400">(empty)</span>}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
