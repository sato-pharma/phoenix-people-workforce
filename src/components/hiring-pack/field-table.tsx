"use client";

// THE FIELD TABLE — every field a template has, and the rule that decides what goes in it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE OWNER ASKED FOR, 2026-09-03, in his own words: "I want a table out of the template. In
// this table, the first column, it is showing every field needed for the template as a header. And
// in the second column, a suggestion at what will be added in each field. First thing I want to be
// able to edit this, this what will be added … then I want to be able to tell him that this word
// will be replaced from this field." And, an hour later, the reason: "My goal is not to bulk many.
// My goal is to be able to control … I want to move anything I want anywhere. And I want to be able
// to change in anything anywhere."
//
// So this is the mail-merge half of the editor and the page is the layout half. THE TABLE IS FOR
// CONTENT, THE PAGE IS FOR POSITION — his choice, put to him directly — and both write to the same
// field-layer row, so the two screens can never disagree about one field.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RULE IS THE TEMPLATE'S, NOT THE EMPLOYEE'S. Typing here changes what this field prints for
// EVERYONE this document is printed for, which is the opposite of clicking the value on the page —
// that edits this one person's record. Both are legitimate and they are not the same act, so the
// screen says which one it is doing rather than leaving it to be inferred.
//
// A rule may carry `{{placeholders}}`, which is the part he described as Canva's bulk create: "this
// word will be replaced from this field". `{{employeeName}}` in the middle of a sentence fills per
// employee. An unknown name is refused here while he is still looking at it, and — whatever slips
// past that — `resolveFieldTemplate` blanks the WHOLE field rather than printing a brace, because a
// sentence quietly missing its middle still reads as a finished sentence.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY RETYPING A RULE IS PAGE-SURFACE ONLY, and why the screen says so instead of hiding it. A page
// document (Form 1, Form 6, the two exit letters) prints from absolute placements, and an override
// row carries its own source — so pointing one at fixed text is exactly what `movedPlacement`
// already does. A flow document (the contract, the worker form, custody, clearance) has no compiled
// overrides at all: `flowFieldLayer` renders ADDED rows only. Retyping a contract clause's token
// would need an override path that does not exist, and pretending otherwise with a disabled-looking
// input is worse than saying it plainly. Adding a box works on both.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { AlertTriangle, Check, MapPin, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { DocumentFieldInventoryEntry } from "@/lib/hiring-pack/document-inventory";
import type { DocumentFieldRow, DocumentSurface } from "@/lib/hiring-pack/field-layout";
import { resolveFieldTemplate, validateFieldTemplate } from "@/lib/hiring-pack/field-template";

export type FieldTableProps = {
  busy: boolean;
  /** Every field this template can print, as the server measured it against this employee. */
  entries: readonly DocumentFieldInventoryEntry[];
  error: string | null;
  loading: boolean;
  /** Arm the page to receive a new box carrying this key — the operator clicks where it goes. */
  onAddBox: (key: string | null) => void;
  /** Remove a field-layer row: an added field goes, an override returns to its compiled default. */
  onDeleteRow: (row: DocumentFieldRow) => void;
  /** Write a rule for a field the template already places. `null` restores the record value. */
  onSaveRule: (entry: DocumentFieldInventoryEntry, text: string | null) => void;
  /** Retype the text of a field the operator added. */
  onSaveRowText: (row: DocumentFieldRow, text: string) => void;
  rows: readonly DocumentFieldRow[];
  surface: DocumentSurface;
};

/** A flow token is UPPER_SNAKE and has no binding to name it, so it is titled from its own spelling. */
function humaniseKey(key: string): string {
  const spaced = key.includes("_")
    ? key.toLowerCase().replace(/_/g, " ")
    : key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The operator's own rule for a field, or null when it still prints straight from the record. */
function currentRule(override: DocumentFieldRow | null): string | null {
  if (!override) return null;
  return override.source.kind === "literal" ? override.source.text : null;
}

export function FieldTable({
  busy,
  entries,
  error,
  loading,
  onAddBox,
  onDeleteRow,
  onSaveRule,
  onSaveRowText,
  rows,
  surface,
}: FieldTableProps) {
  /**
   * Drafts, keyed by field. A key absent from here is NOT being edited — which is different from
   * being edited to an empty string, and the difference is the whole cancel behaviour.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  /** The values map, for previewing a rule exactly as the renderer will resolve it. */
  const values = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of entries) map[entry.key] = entry.value;
    return map;
  }, [entries]);

  const knownKeys = useMemo(() => new Set(entries.map((entry) => entry.key)), [entries]);
  const isKnownKey = useMemo(() => (key: string) => knownKeys.has(key), [knownKeys]);

  /** Overrides, by the compiled key they replace. Page surfaces only — see the header. */
  const overrides = useMemo(() => {
    const map = new Map<string, DocumentFieldRow>();
    for (const row of rows) {
      if (row.defaultKey !== null) map.set(row.defaultKey, row);
    }
    return map;
  }, [rows]);

  /** Fields the operator added, which are rows in their own right rather than rules over a default. */
  const added = useMemo(() => rows.filter((row) => row.defaultKey === null), [rows]);

  const setDraft = (key: string, text: string) => setDrafts((current) => ({ ...current, [key]: text }));
  const clearDraft = (key: string) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

  const insertPlaceholder = (key: string, placeholder: string, fallback: string) => {
    if (!placeholder) return;
    setDrafts((current) => ({ ...current, [key]: `${current[key] ?? fallback}{{${placeholder}}}` }));
  };

  if (loading) {
    return <p className="px-1 py-6 text-phx-xs text-phx-ink-faint">Reading this template’s fields…</p>;
  }

  if (entries.length === 0 && added.length === 0) {
    return (
      <p className="px-1 py-6 text-phx-xs text-phx-ink-faint">
        No fields found on this template. If the document is still loading in the panel, give it a
        moment and open this tab again.
      </p>
    );
  }

  const canRetype = surface === "page";

  return (
    <div className="space-y-4">
      <p className="text-phx-xs leading-relaxed text-phx-ink-soft">
        Every field this document prints, and what goes in each one.{" "}
        <strong>What you type here is the template’s rule — it applies to everyone</strong>, not just
        this employee. To correct one person’s own details instead, click the value on the page.
      </p>

      <div className="rounded-xl border border-phx-line bg-phx-surface-soft px-3 py-2 text-phx-2xs leading-relaxed text-phx-ink-soft">
        Write a sentence and pull values into it with{" "}
        <code className="rounded bg-white px-1 py-0.5 font-mono">{"{{fieldName}}"}</code> — use{" "}
        <em>Insert a field</em> so the name is always one this document has. If a placeholder has no
        value for someone, that whole field prints blank for them rather than printing half a
        sentence.
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-phx-xs text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      {!canRetype ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-phx-2xs leading-relaxed text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This document is typeset rather than printed onto a fixed form, so its own wording cannot
            be retyped from here — the list below shows what each field holds. You can still add a
            field anywhere on it and write whatever you need in that.
          </span>
        </div>
      ) : null}

      <div className="space-y-2">
        {entries.map((entry) => {
          const override = overrides.get(entry.key) ?? null;
          const saved = currentRule(override);
          const editing = entry.key in drafts;
          const draft = drafts[entry.key] ?? saved ?? "";
          const message = editing ? validateFieldTemplate(draft, isKnownKey) : null;
          const preview = editing && !message ? resolveFieldTemplate(draft, values) : null;
          const missing = entry.value !== "" && !entry.placed;

          return (
            <div
              className="rounded-xl border border-phx-line bg-white px-3 py-2.5"
              key={entry.key}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                {/* Column one — what the field IS. */}
                <div className="sm:w-[34%] sm:shrink-0">
                  <p className="text-phx-xs font-semibold text-phx-ink break-words">
                    {entry.labelEn ?? humaniseKey(entry.key)}
                  </p>
                  <p className="mt-0.5 font-mono text-phx-2xs text-phx-ink-faint break-all">
                    {entry.key}
                  </p>
                  {missing ? (
                    <p className="mt-1 text-phx-2xs font-semibold text-amber-700">
                      Has a value but no box on the paper
                    </p>
                  ) : null}
                  {!entry.editable ? (
                    <p className="mt-1 text-phx-2xs text-phx-ink-faint">
                      Standing company text — not part of this person’s record
                    </p>
                  ) : null}
                </div>

                {/* Column two — what goes IN it. */}
                <div className="min-w-0 flex-1 space-y-1.5">
                  {editing ? (
                    <>
                      <textarea
                        className="w-full resize-y rounded-lg border border-phx-accent-line bg-white px-2 py-1.5 text-phx-xs leading-relaxed text-phx-ink outline-none focus:border-phx-accent"
                        dir="auto"
                        onChange={(event) => setDraft(entry.key, event.target.value)}
                        rows={2}
                        value={draft}
                      />
                      {message ? (
                        <p className="text-phx-2xs font-semibold text-red-700 break-words">{message}</p>
                      ) : (
                        <p className="text-phx-2xs text-phx-ink-soft break-words">
                          <span className="text-phx-ink-faint">Prints: </span>
                          {preview === null ? (
                            <em className="text-amber-700">
                              nothing for this employee — a placeholder has no value
                            </em>
                          ) : preview === "" ? (
                            <em className="text-phx-ink-faint">nothing</em>
                          ) : (
                            <span dir="auto">{preview}</span>
                          )}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-phx-xs leading-relaxed text-phx-ink break-words" dir="auto">
                      {saved !== null ? (
                        saved
                      ) : entry.value !== "" ? (
                        entry.value
                      ) : (
                        <em className="text-phx-ink-faint">empty for this employee</em>
                      )}
                    </p>
                  )}
                  {saved !== null && !editing ? (
                    <p className="text-phx-2xs font-semibold text-phx-accent">
                      Set by you for everyone
                    </p>
                  ) : null}
                </div>

                {/* Column three — what you can DO. */}
                <div className="flex flex-wrap items-center gap-1.5 sm:w-[22%] sm:shrink-0 sm:justify-end">
                  {editing ? (
                    <>
                      <select
                        aria-label="Insert a field"
                        className="max-w-full rounded-lg border border-phx-line bg-white px-1.5 py-1 text-phx-2xs text-phx-ink-soft"
                        onChange={(event) => {
                          insertPlaceholder(entry.key, event.target.value, saved ?? "");
                          event.currentTarget.selectedIndex = 0;
                        }}
                        value=""
                      >
                        <option value="">Insert a field…</option>
                        {entries.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.labelEn ?? humaniseKey(option.key)}
                          </option>
                        ))}
                      </select>
                      <Button
                        className="gap-1"
                        disabled={busy || message !== null}
                        onClick={() => {
                          onSaveRule(entry, draft);
                          clearDraft(entry.key);
                        }}
                        size="sm"
                        type="button"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Save
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => clearDraft(entry.key)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      {canRetype && entry.placed ? (
                        <Button
                          disabled={busy}
                          onClick={() => setDraft(entry.key, saved ?? entry.value)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Change
                        </Button>
                      ) : null}
                      {override && saved !== null ? (
                        <Button
                          className="gap-1"
                          disabled={busy}
                          onClick={() => onSaveRule(entry, null)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Use the record
                        </Button>
                      ) : null}
                      {!entry.placed ? (
                        <Button
                          className="gap-1"
                          disabled={busy}
                          onClick={() => onAddBox(entry.key)}
                          size="sm"
                          type="button"
                          variant={missing ? "default" : "outline"}
                        >
                          <MapPin className="h-3.5 w-3.5" />
                          Add a box
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Fields the operator added. They are not part of the template's own list, so they get their
          own section rather than being mixed into it — the difference matters when deciding what to
          delete, because deleting one of these removes a box while "Use the record" only drops a
          rule. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <h4 className="text-phx-xs font-semibold text-phx-ink">Fields you added</h4>
          <Button
            className="gap-1.5"
            disabled={busy}
            onClick={() => onAddBox(null)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="h-4 w-4" />
            Add a field
          </Button>
        </div>

        {added.length === 0 ? (
          <p className="text-phx-2xs text-phx-ink-faint">
            None yet. <em>Add a field</em> — then click the spot on the page where it belongs.
          </p>
        ) : (
          added.map((row) => {
            const key = `row:${row.id}`;
            const saved = row.source.kind === "literal" ? row.source.text : "";
            const editing = key in drafts;
            const draft = drafts[key] ?? saved;
            const message = editing ? validateFieldTemplate(draft, isKnownKey) : null;
            const preview = editing && !message ? resolveFieldTemplate(draft, values) : null;

            return (
              <div className="rounded-xl border border-phx-accent-line bg-phx-accent/5 px-3 py-2.5" key={row.id}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                  <div className="sm:w-[34%] sm:shrink-0">
                    <p className="text-phx-xs font-semibold text-phx-ink">
                      {row.source.kind === "value"
                        ? humaniseKey(row.source.key)
                        : "Your own text"}
                    </p>
                    <p className="mt-0.5 text-phx-2xs text-phx-ink-faint">
                      {row.page !== null ? `Page ${row.page + 1}` : "Anchored in the text"}
                      {row.hidden ? " · hidden" : ""}
                    </p>
                  </div>

                  <div className="min-w-0 flex-1 space-y-1.5">
                    {row.source.kind === "value" ? (
                      <p className="text-phx-xs text-phx-ink break-words" dir="auto">
                        {values[row.source.key] ?? <em className="text-phx-ink-faint">empty</em>}
                      </p>
                    ) : editing ? (
                      <>
                        <textarea
                          className="w-full resize-y rounded-lg border border-phx-accent-line bg-white px-2 py-1.5 text-phx-xs leading-relaxed text-phx-ink outline-none focus:border-phx-accent"
                          dir="auto"
                          onChange={(event) => setDraft(key, event.target.value)}
                          rows={2}
                          value={draft}
                        />
                        {message ? (
                          <p className="text-phx-2xs font-semibold text-red-700 break-words">{message}</p>
                        ) : (
                          <p className="text-phx-2xs text-phx-ink-soft break-words">
                            <span className="text-phx-ink-faint">Prints: </span>
                            {preview === null ? (
                              <em className="text-amber-700">nothing for this employee</em>
                            ) : preview === "" ? (
                              <em className="text-phx-ink-faint">nothing</em>
                            ) : (
                              <span dir="auto">{preview}</span>
                            )}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-phx-xs text-phx-ink break-words" dir="auto">
                        {saved === "" ? <em className="text-phx-ink-faint">empty</em> : saved}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 sm:w-[22%] sm:shrink-0 sm:justify-end">
                    {row.source.kind === "literal" && editing ? (
                      <>
                        <select
                          aria-label="Insert a field"
                          className="max-w-full rounded-lg border border-phx-line bg-white px-1.5 py-1 text-phx-2xs text-phx-ink-soft"
                          onChange={(event) => {
                            insertPlaceholder(key, event.target.value, saved);
                            event.currentTarget.selectedIndex = 0;
                          }}
                          value=""
                        >
                          <option value="">Insert a field…</option>
                          {entries.map((option) => (
                            <option key={option.key} value={option.key}>
                              {option.labelEn ?? humaniseKey(option.key)}
                            </option>
                          ))}
                        </select>
                        <Button
                          className="gap-1"
                          disabled={busy || message !== null}
                          onClick={() => {
                            onSaveRowText(row, draft);
                            clearDraft(key);
                          }}
                          size="sm"
                          type="button"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Save
                        </Button>
                        <Button disabled={busy} onClick={() => clearDraft(key)} size="sm" type="button" variant="ghost">
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        {row.source.kind === "literal" ? (
                          <Button
                            disabled={busy}
                            onClick={() => setDraft(key, saved)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Change
                          </Button>
                        ) : null}
                        <Button
                          className="gap-1 text-red-700"
                          disabled={busy}
                          onClick={() => onDeleteRow(row)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
