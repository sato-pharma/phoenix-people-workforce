"use client";

// WHAT A FIELD USED TO SAY.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A save OVERWRITES. Editing a field in the field table changes the TEMPLATE — the rule for every
// person the document is printed for — and until this existed the previous rule was simply gone.
// "What did this field print in September" had no answer at all, on papers people sign, and a reset
// deleted every row on a document without leaving a trace of what it deleted.
//
// THE DATE IS THE HEADLINE AND THE NAME IS NOT. `updated_by_hr_id` is known to be unreliable across
// this system, and on a DELETE there is no actor to record at all — the only name available there is
// whoever last EDITED the field, which is not who removed it, so the history stores null rather than
// a name that would be wrong. A wrong name gets defended rather than looked up. The timestamp is the
// half that can be relied on, so it leads, and the person is shown underneath it only when there
// genuinely is one.
//
// EVERY TIME IS CAIRO, per the standing rule. These are instants this system stamped itself, which
// is the one case that belongs in local time — a date column would not.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { History, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import type { DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import type { FieldHistoryEntry } from "@/lib/hiring-pack/field-layout-store";

export type FieldHistoryPanelProps = {
  /** The states themselves, or null while they are still being read. */
  entries: readonly FieldHistoryEntry[] | null;
  error: string | null;
  onClose: () => void;
  /** The field being looked at. Shown immediately, before the states arrive. */
  row: DocumentFieldRow;
};

/** A recorded instant, in Cairo local time — never raw UTC. */
function stamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

function humaniseKey(key: string): string {
  const spaced = key.includes("_")
    ? key.toLowerCase().replace(/_/g, " ")
    : key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** What a placement printed, in the same words the field table uses for a live row. */
function describeSource(source: DocumentFieldRow["source"]): string {
  return source.kind === "literal" ? source.text : `Reads ${humaniseKey(source.key)} off the record`;
}

/** Where a placement sat, rounded — the numbers are points and a hundredth of one says nothing. */
function describePlace(state: DocumentFieldRow): string {
  const where =
    state.page !== null
      ? `Page ${state.page + 1} · ${Math.round(state.x)}, ${Math.round(state.y)}`
      : "Anchored in the text";
  return `${where} · ${Math.round(state.w)}×${Math.round(state.h)}pt · ${state.size}pt ${state.align}`;
}

export function FieldHistoryPanel({ entries, error, onClose, row }: FieldHistoryPanelProps) {
  const dialogRef = useDialogA11y<HTMLDivElement>({ onClose, open: true });

  const title =
    row.defaultKey !== null
      ? humaniseKey(row.defaultKey)
      : row.source.kind === "value"
        ? humaniseKey(row.source.key)
        : "Your own text";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div
        aria-labelledby="hp-history-title"
        aria-modal
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-phx-line bg-white shadow-xl sm:rounded-2xl"
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-3 border-b border-phx-line px-4 py-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-phx-sm font-semibold text-phx-ink" id="hp-history-title">
              <History className="h-4 w-4 shrink-0" />
              <span className="break-words">{title}</span>
            </h3>
            <p className="mt-0.5 text-phx-2xs text-phx-ink-faint">
              What this field said before. Newest first.
            </p>
          </div>
          <Button aria-label="Close" onClick={onClose} size="sm" type="button" variant="ghost">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* The list scrolls INSIDE the panel. The page itself never scrolls sideways, and a long
            history must not be what breaks that. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-phx-2xs text-red-700">
              {error}
            </p>
          ) : entries === null ? (
            <p className="text-phx-2xs text-phx-ink-faint">Reading what this field used to say…</p>
          ) : entries.length === 0 ? (
            <p className="text-phx-2xs text-phx-ink-faint">
              Nothing recorded yet. This field still prints what the document was built with, or its
              only change came before the history was kept.
            </p>
          ) : (
            <ol className="space-y-2">
              {entries.map((entry) => (
                <li
                  className="rounded-xl border border-phx-line bg-phx-surface-soft px-3 py-2.5"
                  key={entry.id}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {entry.action === "delete" ? (
                      <span className="inline-flex items-center gap-1 text-phx-2xs font-semibold text-red-700">
                        <Trash2 className="h-3 w-3" />
                        Removed
                      </span>
                    ) : (
                      <span className="text-phx-2xs font-semibold text-phx-ink">Replaced</span>
                    )}
                    <span className="text-phx-2xs text-phx-ink-soft">{stamp(entry.changedAt)}</span>
                  </div>

                  <p className="mt-1.5 break-words text-phx-xs text-phx-ink" dir="auto">
                    {describeSource(entry.state.source)}
                  </p>
                  <p className="mt-0.5 font-mono text-phx-2xs text-phx-ink-faint">
                    {describePlace(entry.state)}
                    {entry.state.hidden ? " · hidden" : ""}
                  </p>

                  {/* Secondary, and deliberately quiet: written-when, and the person ONLY when the
                      history actually holds one. See the header. */}
                  <p className="mt-1 text-phx-2xs text-phx-ink-faint">
                    Written {stamp(entry.wasUpdatedAt)}
                    {entry.changedByHrId ? ` · replaced by ${entry.changedByHrId}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
