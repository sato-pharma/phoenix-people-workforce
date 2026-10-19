"use client";

// The candidate pool's WhatsApp-question columns: the cell a reader can edit or fill in, and the
// chooser that adds, hides and reorders the columns (owner, 2026-10-19 — "make me able to edit or
// add a missing field and full control"). Which columns exist is pool-whatsapp-columns.ts; how an
// edit is saved is whatsapp-answer-edit.ts.

import { ArrowDown, ArrowUp, Columns3, Pencil, RotateCcw, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { adminControlDepthClassName } from "@/components/admin/admin-design-tokens";
import { Button } from "@/components/ui/button";
import { phxFieldClassName, phxLabelTextClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { candidateRegionLabels } from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilyLabels } from "@/lib/recruitment/candidate-role-family";
import { candidateBackgroundLabels, candidateExperienceLabels } from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import type { PoolTableColumn } from "@/lib/recruitment/pool-whatsapp-columns";
import { BUILT_IN_ANSWER_QUESTIONS } from "@/lib/recruitment/whatsapp-answers";

/** The wording of each answer key's field in the editor — the question itself, never a key. */
function fieldLabel(editKey: string, column: PoolTableColumn): string {
  if (editKey in BUILT_IN_ANSWER_QUESTIONS) return BUILT_IN_ANSWER_QUESTIONS[editKey as keyof typeof BUILT_IN_ANSWER_QUESTIONS];
  return column.header;
}

/** What the bot's own menu offers for that question, as typing suggestions. Free text is always allowed. */
function suggestionsFor(editKey: string): readonly string[] {
  switch (editKey) {
    case "background":
      return Object.values(candidateBackgroundLabels);
    case "experience":
      return Object.values(candidateExperienceLabels);
    case "region":
      return Object.values(candidateRegionLabels);
    case "job_title":
      return Object.values(candidateRoleFamilyLabels);
    default:
      return [];
  }
}

type PoolEditableAnswerProps = {
  canEdit: boolean;
  children: ReactNode;
  column: PoolTableColumn;
  /** The answer each edit key holds now, "" for a missing one. */
  currentValues: Readonly<Record<string, string>>;
  editing: boolean;
  onCancel: () => void;
  onSave: (values: Record<string, string>) => void;
  onStartEdit: () => void;
  pending: boolean;
};

/**
 * One answer cell. Shows `children`; for a reader who may edit, a pencil opens the question's
 * field(s) in place — filled with the current answer, or empty for a missing one. Saving an empty
 * field clears that answer.
 */
export function PoolEditableCell({ className, ...answer }: PoolEditableAnswerProps & { className: string }) {
  return (
    <td className={className}>
      <PoolEditableAnswer {...answer} />
    </td>
  );
}

/**
 * The answer and its pencil, wherever it sits: a table cell on a desktop, a line of the candidate card
 * on a phone (owner, 2026-10-19 — "Add it on phones"). Same editor, same save, same limit. A phone has
 * no hover, so there (`touch`) the pencil is drawn at full strength with room for a thumb instead of
 * brightening under the mouse.
 */
export function PoolEditableAnswer({
  canEdit,
  children,
  column,
  currentValues,
  editing,
  onCancel,
  onSave,
  onStartEdit,
  pending,
  touch = false,
}: PoolEditableAnswerProps & { touch?: boolean }) {
  if (editing) {
    return (
      <PoolAnswerEditor
        column={column}
        currentValues={currentValues}
        onCancel={onCancel}
        onSave={onSave}
        pending={pending}
      />
    );
  }
  return (
    <div className="group/answer relative min-w-0">
      {children}
      {canEdit ? (
        <button
          aria-label={`Edit the answer to "${column.header}"`}
          className={
            touch
              ? `mt-1.5 inline-flex min-h-8 items-center gap-1 border border-slate-200 bg-white px-2.5 text-phx-xs font-semibold text-slate-600 transition hover:border-orange-300 hover:text-orange-600 ${adminControlDepthClassName}`
              : "mt-1 inline-flex items-center gap-1 text-phx-xs font-semibold text-slate-400 opacity-60 transition hover:text-orange-600 group-hover/answer:opacity-100"
          }
          disabled={pending}
          onClick={onStartEdit}
          title={`Edit the answer to "${column.header}"`}
          type="button"
        >
          <Pencil aria-hidden className="h-3 w-3" />
          {Object.values(currentValues).some((value) => value.trim()) ? "Edit" : "Add"}
        </button>
      ) : null}
    </div>
  );
}

function PoolAnswerEditor({
  column,
  currentValues,
  onCancel,
  onSave,
  pending,
}: {
  column: PoolTableColumn;
  currentValues: Readonly<Record<string, string>>;
  onCancel: () => void;
  onSave: (values: Record<string, string>) => void;
  pending: boolean;
}) {
  const idBase = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(column.editKeys.map((key) => [key, currentValues[key] ?? ""])),
  );
  const changed = column.editKeys.some((key) => (drafts[key] ?? "").trim() !== (currentValues[key] ?? "").trim());
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) onSave(drafts);
      }}
    >
      {column.editKeys.map((editKey, index) => {
        const suggestions = suggestionsFor(editKey);
        const inputId = `${idBase}-${index}`;
        const listId = suggestions.length > 0 ? `${inputId}-list` : undefined;
        return (
          <label className="block" htmlFor={inputId} key={editKey}>
            <span className={`mb-1 block break-words normal-case ${phxLabelTextClassName}`} dir="auto">
              {fieldLabel(editKey, column)}
            </span>
            <input
              autoFocus={index === 0}
              className={phxFieldClassName}
              dir="auto"
              disabled={pending}
              id={inputId}
              list={listId}
              maxLength={400}
              onChange={(event) => setDrafts((current) => ({ ...current, [editKey]: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === "Escape") onCancel();
              }}
              value={drafts[editKey] ?? ""}
            />
            {listId ? (
              <datalist id={listId}>
                {suggestions.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            ) : null}
          </label>
        );
      })}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button disabled={pending || !changed} size="sm" type="submit">
          Save
        </Button>
        <Button disabled={pending} onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
      <p className="text-phx-xs text-slate-400">Leave a field empty to clear that answer.</p>
    </form>
  );
}

/**
 * The column chooser: the columns shown, in order, each with up, down and hide; and every other
 * question to add. "Back to the WhatsApp questions" forgets this view's changes.
 */
export function PoolColumnChooser({
  catalogue,
  columns,
  isCustom,
  onChange,
  viewLabel,
}: {
  catalogue: readonly PoolTableColumn[];
  columns: readonly PoolTableColumn[];
  isCustom: boolean;
  onChange: (keys: readonly string[] | null) => void;
  viewLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [toAdd, setToAdd] = useState("");
  const shown = new Set(columns.map((column) => column.key));
  const addable = catalogue.filter((column) => !shown.has(column.key));
  const keys = columns.map((column) => column.key);
  const move = (index: number, by: -1 | 1) => {
    const next = [...keys];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };

  return (
    <div className="relative">
      <Button onClick={() => setOpen((value) => !value)} size="sm" type="button" variant="secondary">
        <Columns3 aria-hidden className="h-3.5 w-3.5" />
        Columns{isCustom ? " (changed)" : ""}
      </Button>
      {open ? (
        <div className="mt-2 w-full max-w-xl border border-slate-200 bg-white p-3 shadow-lg">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-800">Columns for {viewLabel}</p>
            <button
              aria-label="Close the column chooser"
              className="text-slate-400 hover:text-slate-700"
              onClick={() => setOpen(false)}
              type="button"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
          {columns.length === 0 ? (
            <p className="text-xs text-slate-500">No question columns are shown. Add one below.</p>
          ) : (
            <ol className="divide-y divide-slate-100 border border-slate-100">
              {columns.map((column, index) => (
                <li className="flex items-start gap-2 px-2 py-1.5" key={column.key}>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm text-slate-800" dir="auto">
                      {column.header}
                    </p>
                    {column.askedTo ? <p className="text-phx-xs text-slate-400">{column.askedTo}</p> : null}
                  </div>
                  <button
                    aria-label={`Move "${column.header}" left`}
                    className="p-1 text-slate-400 hover:text-orange-600 disabled:opacity-30"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    title="Move left"
                    type="button"
                  >
                    <ArrowUp aria-hidden className="h-4 w-4" />
                  </button>
                  <button
                    aria-label={`Move "${column.header}" right`}
                    className="p-1 text-slate-400 hover:text-orange-600 disabled:opacity-30"
                    disabled={index === columns.length - 1}
                    onClick={() => move(index, 1)}
                    title="Move right"
                    type="button"
                  >
                    <ArrowDown aria-hidden className="h-4 w-4" />
                  </button>
                  <button
                    aria-label={`Hide "${column.header}"`}
                    className="p-1 text-slate-400 hover:text-rose-600"
                    onClick={() => onChange(keys.filter((key) => key !== column.key))}
                    title="Hide this column"
                    type="button"
                  >
                    <X aria-hidden className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ol>
          )}
          {addable.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1">
                <span className={`mb-1 block ${phxLabelTextClassName}`}>Add a column</span>
                <select className={phxSelectClassName} onChange={(event) => setToAdd(event.target.value)} value={toAdd}>
                  <option value="">Pick a question…</option>
                  {addable.map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.askedTo ? `${column.header} (${column.askedTo.replace(/^Asked only to /, "")})` : column.header}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={!toAdd}
                onClick={() => {
                  onChange([...keys, toAdd]);
                  setToAdd("");
                }}
                size="sm"
                type="button"
              >
                Add
              </Button>
            </div>
          ) : null}
          {isCustom ? (
            <button
              className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-orange-600"
              onClick={() => onChange(null)}
              type="button"
            >
              <RotateCcw aria-hidden className="h-3.5 w-3.5" />
              Back to the WhatsApp questions for {viewLabel}
            </button>
          ) : null}
          <p className="mt-2 text-phx-xs text-slate-400">Saved in this browser, for this view only.</p>
        </div>
      ) : null}
    </div>
  );
}
