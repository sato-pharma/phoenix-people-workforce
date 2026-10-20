"use client";

// Recruitment workspace — one WhatsApp answer as a labelled chip, and its in-place editor.
//
// THE OWNER'S THREE RULES FOR A CHIP (20 Oct 2026):
//   • a missing answer is an amber dashed "Missing · add" — never a CV reading put in its place;
//   • an answer HR typed says "added by HR", with who and when, so nobody mistakes it for the
//     applicant's own reply;
//   • Medical Rep's six lead the row in larger type.
//
// The editor opens IN the chip's place, inside the same wrapping row, so it can never push the page
// sideways the way a floating panel near the right edge does.
//
// `variant="cell"` is the same answer inside a cell of the candidate table, where the column head is
// already the question: the value alone, in reading size, the "added by HR" mark under it, and the
// same amber "Missing · add" and the same editor.

import { Check, PenLine, Plus, X } from "lucide-react";
import { useState } from "react";

import { adminChipDepthClassName } from "@/components/admin/admin-design-tokens";
import { phxFieldClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { cairoDayLabel, errorText } from "@/components/recruitment/workspace/workspace-format";
import type { WorkspaceAnswerChip } from "@/lib/recruitment/workspace/types";
import { cn } from "@/lib/utils";

export type AnswerOption = { value: string; label: string };

export function AnswerChip({
  canEdit,
  chip,
  onSave,
  options,
  today,
  variant = "chip",
}: {
  canEdit: boolean;
  chip: WorkspaceAnswerChip;
  /** Writes the answer (null clears it). Rejects with the server's own sentence. */
  onSave?: (chip: WorkspaceAnswerChip, value: string | null) => Promise<void>;
  /** The question's options, when it is a choice; free text otherwise. */
  options?: readonly AnswerOption[];
  today: string;
  /** "cell": the value alone, for a table cell whose column head names the question. */
  variant?: "chip" | "cell";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chip.rawValue ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const open = () => {
    setDraft(chip.rawValue ?? "");
    setProblem(null);
    setEditing(true);
  };

  const save = async () => {
    if (!onSave) return;
    setBusy(true);
    setProblem(null);
    try {
      await onSave(chip, draft.trim() ? draft.trim() : null);
      setEditing(false);
    } catch (error) {
      setProblem(errorText(error, "The answer was not saved."));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <span
        className={cn("inline-flex max-w-full flex-wrap items-center gap-1.5 border border-orange-300 bg-orange-50/60 p-1.5", adminChipDepthClassName)}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="text-phx-xs font-black uppercase tracking-wide text-slate-600">{chip.label}</span>
        {options && options.length > 0 ? (
          <select
            aria-label={chip.label}
            autoFocus
            className={cn(phxSelectClassName, "h-8 w-auto min-w-[9rem] max-w-full px-2 text-xs")}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            value={draft}
          >
            <option value="">Not answered</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {draft && !options.some((option) => option.value === draft) ? <option value={draft}>{draft}</option> : null}
          </select>
        ) : (
          <input
            aria-label={chip.label}
            autoFocus
            className={cn(phxFieldClassName, "h-8 w-56 max-w-full px-2 text-xs")}
            dir="auto"
            disabled={busy}
            maxLength={300}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
              if (event.key === "Escape") setEditing(false);
            }}
            value={draft}
          />
        )}
        <button
          aria-label="Save the answer"
          className="inline-flex h-8 items-center gap-1 border border-slate-900 bg-slate-900 px-2 text-xs font-bold text-white transition hover:bg-slate-800 disabled:opacity-50"
          disabled={busy}
          onClick={() => void save()}
          type="button"
        >
          <Check aria-hidden className="h-3.5 w-3.5" />
          Save
        </button>
        <button
          aria-label="Cancel"
          className={`inline-flex h-8 items-center border border-slate-300 bg-white px-2 text-xs font-bold text-slate-600 transition hover:bg-slate-100 ${adminChipDepthClassName}`}
          disabled={busy}
          onClick={() => setEditing(false)}
          type="button"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
        {problem ? (
          <span className="basis-full break-words text-xs font-bold text-rose-700" dir="auto" role="alert">
            {problem}
          </span>
        ) : null}
      </span>
    );
  }

  const cell = variant === "cell";
  const openEditor = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    open();
  };

  if (cell) {
    if (chip.value === null) {
      const missingCell = "inline-flex max-w-full flex-wrap items-center gap-1 border border-dashed border-amber-400 bg-amber-50/70 px-1.5 py-0.5 text-xs font-bold text-amber-900";
      return canEdit ? (
        <button className={cn(missingCell, "transition hover:border-amber-600 hover:bg-amber-100")} onClick={openEditor} title={`Add the answer to “${chip.label}”`} type="button">
          <Plus aria-hidden className="h-3 w-3" />
          Missing · add
        </button>
      ) : (
        <span className={missingCell}>Missing</span>
      );
    }
    const byHrCell = chip.addedByHr;
    const valueCell = (
      <>
        <span className="break-words text-sm font-semibold leading-5 text-slate-900" dir="auto">
          {chip.value}
          {canEdit ? <PenLine aria-hidden className="ml-1 inline h-3 w-3 text-slate-300 group-hover:text-orange-600" /> : null}
        </span>
        {byHrCell ? (
          <span className="block text-phx-xs font-bold text-violet-700" title={byHrCell.name ?? undefined}>
            {`added by HR${byHrCell.name ? ` · ${byHrCell.name}` : ""}${byHrCell.at ? ` · ${cairoDayLabel(byHrCell.at, today)}` : ""}`}
          </span>
        ) : null}
      </>
    );
    return canEdit ? (
      <button className="group block w-full text-left transition hover:text-orange-800" onClick={openEditor} title={`Edit “${chip.label}”`} type="button">
        {valueCell}
      </button>
    ) : (
      <span className="block">{valueCell}</span>
    );
  }

  if (chip.value === null) {
    const body = (
      <>
        <span className="font-black uppercase tracking-wide">{chip.label}</span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-0.5 font-bold">
          {canEdit ? <Plus aria-hidden className="h-3 w-3" /> : null}
          {canEdit ? "Missing · add" : "Missing"}
        </span>
      </>
    );
    const missingClass = cn(
      "inline-flex max-w-full flex-wrap items-center gap-1 border border-dashed border-amber-400 bg-amber-50/70 px-1.5 py-0.5 text-amber-900",
      chip.lead ? "text-xs" : "text-phx-xs",
    );
    return canEdit ? (
      <button
        className={cn(missingClass, "transition hover:border-amber-600 hover:bg-amber-100")}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        title={`Add the answer to “${chip.label}”`}
        type="button"
      >
        {body}
      </button>
    ) : (
      <span className={missingClass}>{body}</span>
    );
  }

  const byHr = chip.addedByHr;
  const content = (
    <>
      <span className={cn("font-black uppercase tracking-wide text-slate-500", chip.lead ? "text-phx-xs" : "text-phx-xs")}>{chip.label}</span>
      <span className={cn("break-words font-bold text-slate-900", chip.lead ? "text-sm" : "text-xs")} dir="auto">
        {chip.value}
      </span>
      {byHr ? (
        <span className="border border-violet-200 bg-violet-50 px-1 text-phx-xs font-bold text-violet-800" title={byHr.name ?? undefined}>
          added by HR{byHr.name ? ` · ${byHr.name}` : ""}
          {byHr.at ? ` · ${cairoDayLabel(byHr.at, today)}` : ""}
        </span>
      ) : null}
      {canEdit ? <PenLine aria-hidden className="h-3 w-3 text-slate-300 group-hover:text-orange-600" /> : null}
    </>
  );
  const chipClass = cn(
    "group inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5 border px-1.5 py-0.5 text-left",
    chip.lead ? "border-slate-300 bg-white" : "border-slate-200 bg-slate-50/70",
    adminChipDepthClassName,
  );
  return canEdit ? (
    <button
      className={cn(chipClass, "transition hover:border-orange-300")}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
      title={`Edit “${chip.label}”`}
      type="button"
    >
      {content}
    </button>
  ) : (
    <span className={chipClass}>{content}</span>
  );
}
