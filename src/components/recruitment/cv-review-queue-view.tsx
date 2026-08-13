"use client";

// Recruitment / ATS — worklist of CV extractions that no human has ever reviewed.
//
// See src/lib/recruitment/cv-review-queue.ts for why this exists: auto-intake never had a route
// to the review UI, so the AI's low-confidence proposals sat in the database unseen. Each row is
// one candidate; "Review" opens the SAME drag-and-drop board the manual paths use
// (cv-extraction-review-board.tsx) and saves through the SAME PATCH route, which records
// applied_fields — the "a human reviewed this" signal cv-extraction-analytics.ts measures from.

import { useState } from "react";
import { useRouter } from "next/navigation";

import { CvExtractionReviewBoard } from "@/components/recruitment/cv-extraction-review-board";
import { Button } from "@/components/ui/button";
import type { ExtractedCandidateFields } from "@/lib/recruitment/cv-extraction-fields";
import { getCvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import type { CvReviewQueue, CvReviewQueueItem, PendingReviewField } from "@/lib/recruitment/cv-review-queue";

/**
 * Drops every null from the board's output, so a review from this queue can only ever FILL a
 * column — never clear one.
 *
 * The board writes each of its fields on save, emitting null for anything unassigned or hidden by
 * a showWhen rule, and PATCH /api/recruitment/candidates/[id] treats a present null as "clear this
 * column" (an omitted key is what leaves it untouched). buildReviewBoardFields already prefills
 * every stored value so the common case never produces a null in the first place; this is the
 * backstop for the cases it cannot reach — most concretely a conditional field, which the board
 * hides and nulls whenever its controlling boolean is not `true`, however the candidate row got
 * into that state.
 *
 * Clearing a field stays possible from the candidate editor, which is where a deliberate deletion
 * belongs. This queue's entire contract is filling gaps the AI found and a human never saw.
 */
function fillOnly(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}

function formatPendingValue(field: PendingReviewField): string {
  if (field.type === "boolean") return field.value === true ? "Yes" : "No";
  return String(field.value);
}

function formatExtractedAt(value: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function PendingChips({ fields }: { fields: readonly PendingReviewField[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {fields.map((field) => (
        <li
          className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
          key={field.key}
        >
          <span className="font-semibold text-slate-500">{field.label}</span>
          <span className="text-slate-900">{formatPendingValue(field)}</span>
          {field.confidence === "low" ? (
            <span className="rounded border border-amber-200 bg-amber-50 px-1 py-0.5 text-[10px] font-semibold text-amber-700">
              Check this
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function QueueRow({
  item,
  isOpen,
  onToggle,
  onReviewed,
}: {
  item: CvReviewQueueItem;
  isOpen: boolean;
  onToggle: () => void;
  onReviewed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schema = getCvPositionSchema(item.positionKey);

  const save = async (values: Record<string, unknown>) => {
    if (!String(values.fullName ?? "").trim()) {
      setError("Full name is required — drag or type a value into that column first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${item.candidateId}`, {
        body: JSON.stringify({ ...fillOnly(values), extractionId: item.extractionId }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to save the review.");
      onReviewed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save the review.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-900">{item.candidateName}</span>
            {item.candidateSource ? (
              <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {item.candidateSource}
              </span>
            ) : null}
            <span className="text-xs text-slate-500">
              {item.pendingFields.length} field{item.pendingFields.length === 1 ? "" : "s"} waiting · extracted{" "}
              {formatExtractedAt(item.extractedAt)}
            </span>
          </div>
          <PendingChips fields={item.pendingFields} />
        </div>
        <div className="flex shrink-0 gap-2">
          <a
            className="inline-flex items-center rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            href={`/recruitment/candidates?candidateId=${item.candidateId}`}
          >
            Open candidate
          </a>
          <Button onClick={onToggle} size="sm" type="button" variant={isOpen ? "ghost" : "secondary"}>
            {isOpen ? "Close" : "Review"}
          </Button>
        </div>
      </div>

      {isOpen ? (
        schema ? (
          <div className="mt-3">
            <CvExtractionReviewBoard
              busy={busy}
              error={error}
              fields={item.boardFields as ExtractedCandidateFields}
              onCancel={onToggle}
              onSave={save}
              saveLabel="Save review"
              schema={schema}
            />
          </div>
        ) : (
          <p className="mt-3 text-sm text-rose-600">
            No field schema is registered for position &quot;{item.positionKey}&quot;, so this extraction cannot be
            reviewed here. Add it to cv-field-schemas.ts.
          </p>
        )
      ) : null}
    </li>
  );
}

export function CvReviewQueueView({ queue }: { queue: CvReviewQueue }) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);

  if (queue.items.length === 0) {
    return (
      <p className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
        Nothing waiting. Every CV extraction has either been reviewed or had its confident fields applied
        automatically.
      </p>
    );
  }

  const totalFields = queue.items.reduce((sum, item) => sum + item.pendingFields.length, 0);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        {totalFields} field{totalFields === 1 ? "" : "s"} across {queue.items.length} candidate
        {queue.items.length === 1 ? "" : "s"}. Highest-yield first.
      </p>
      {queue.truncated ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          Showing a capped slice of the unreviewed extractions — there are more than this page scanned.
        </p>
      ) : null}
      <ul className="space-y-3">
        {queue.items.map((item) => (
          <QueueRow
            isOpen={openId === item.extractionId}
            item={item}
            key={item.extractionId}
            onReviewed={() => {
              setOpenId(null);
              router.refresh();
            }}
            onToggle={() => setOpenId((prev) => (prev === item.extractionId ? null : item.extractionId))}
          />
        ))}
      </ul>
    </div>
  );
}
