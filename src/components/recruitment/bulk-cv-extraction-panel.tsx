"use client";

// The recruiter — create several candidates from a batch of CVs at once. Files are
// processed sequentially (not in parallel — bounds AI cost/concurrency and avoids hammering
// the extraction endpoint with a burst of requests); each file gets its own row in a queue
// with its own status, and a failure on one file (e.g. an unsupported type) doesn't stop the
// rest of the batch. "Review" on a completed row opens the same drag-and-drop review board
// used by the single-CV flow.
//
// THE LOOK (2026-10-19 premium sweep): the picker and the action sit in the module's recessed
// toolbar tray; every queue row says its state as one of the module's pills — waiting slate,
// reading sky, ready to review amber, saved emerald — and a failure is said in rose words that
// wrap, because an error message has no length bound and a pill would have to cut it.

import { useRef, useState } from "react";
import { AlertCircle, ClipboardCheck, Files, Loader2 } from "lucide-react";

import {
  adminControlDepthClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import { CvExtractionReviewBoard } from "@/components/recruitment/cv-extraction-review-board";
import {
  RecruitmentPill,
  recruitmentToolbarClassName,
  type RecruitmentPillTone,
} from "@/components/recruitment/recruitment-premium";
import type { ExtractedCandidateFields } from "@/lib/recruitment/cv-extraction";
import { defaultCvPositionKey, getCvPositionSchema, listCvPositionSchemas } from "@/lib/recruitment/cv-field-schemas";
import { phxButtonGhostClassName, phxLabelTextClassName, phxSelectClassName } from "@/components/ui/form-tokens";

type QueueItemStatus = "pending" | "processing" | "done" | "error";

type QueueItem = {
  id: string;
  fileName: string;
  status: QueueItemStatus;
  candidateId?: string;
  extractionId?: string | null;
  fields?: ExtractedCandidateFields;
  error?: string;
  saved?: boolean;
};

const positionOptions = listCvPositionSchemas();

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Request failed.");
  return data;
}

function statusLabel(item: QueueItem): string {
  if (item.status === "pending") return "Waiting…";
  if (item.status === "processing") return "Reading CV…";
  if (item.status === "done") return item.saved ? "Saved" : "Ready to review";
  return item.error ?? "Failed";
}

/** The pill colour for each queue state that is not a failure. */
function statusTone(item: QueueItem): RecruitmentPillTone {
  if (item.status === "processing") return "sky";
  if (item.status === "done") return item.saved ? "emerald" : "amber";
  return "slate";
}

/** One row's state: a pill, or — for a failure — the server's own words in rose, wrapping. */
function QueueStatus({ item }: { item: QueueItem }) {
  if (item.status === "error") {
    return (
      <span className="inline-flex min-w-0 items-start gap-1.5 text-xs font-semibold text-rose-700">
        <AlertCircle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">{statusLabel(item)}</span>
      </span>
    );
  }
  return (
    <RecruitmentPill tone={statusTone(item)}>
      {item.status === "processing" ? <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> : null}
      {statusLabel(item)}
    </RecruitmentPill>
  );
}

/** "Review" — the one next step a ready row has, in the module's accent so it is the obvious one. */
const reviewButtonClassName = `inline-flex items-center gap-1.5 border border-orange-300 bg-orange-50 px-2.5 py-1 text-xs font-bold text-orange-800 transition hover:bg-orange-100 ${adminControlDepthClassName}`;

export function BulkCvExtractionPanel({ onCreated }: { onCreated: (candidateId: string) => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [positionKey, setPositionKey] = useState(defaultCvPositionKey);
  const schema = getCvPositionSchema(positionKey)!;

  const updateItem = (id: string, patch: Partial<QueueItem>) =>
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const startBatch = async () => {
    const files = Array.from(fileRef.current?.files ?? []);
    if (files.length === 0) return;
    const items: QueueItem[] = files.map((file, index) => ({ fileName: file.name, id: `${index}-${file.name}`, status: "pending" }));
    setQueue(items);
    setRunning(true);
    if (fileRef.current) fileRef.current.value = "";

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const file = files[i];
      updateItem(item.id, { status: "processing" });
      try {
        const created = await postJson("/api/recruitment/candidates", { fullName: "Pending CV Review" });
        const candidate = created.candidate as { id: string } | undefined;
        if (!candidate?.id) throw new Error("Could not create the candidate record.");

        const formData = new FormData();
        formData.append("file", file);
        formData.append("kind", "cv");
        const uploadRes = await fetch(`/api/recruitment/candidates/${candidate.id}/files`, { body: formData, method: "POST" });
        const uploadData = (await uploadRes.json().catch(() => ({}))) as Record<string, unknown>;
        if (!uploadRes.ok) throw new Error(typeof uploadData.message === "string" ? uploadData.message : "CV upload failed.");

        const extraction = await postJson(`/api/recruitment/candidates/${candidate.id}/cv-extract`, { positionKey });
        const fields = extraction.fields as ExtractedCandidateFields | undefined;
        if (!fields) throw new Error("No fields were returned. Try again.");

        updateItem(item.id, {
          candidateId: candidate.id,
          extractionId: typeof extraction.extractionId === "string" ? extraction.extractionId : null,
          fields,
          status: "done",
        });
      } catch (caught) {
        updateItem(item.id, { error: caught instanceof Error ? caught.message : "CV extraction failed.", status: "error" });
      }
    }
    setRunning(false);
  };

  const reviewingItem = queue.find((item) => item.id === reviewingId) ?? null;

  const saveReviewing = async (values: Record<string, unknown>) => {
    if (!reviewingItem?.candidateId) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${reviewingItem.candidateId}`, {
        body: JSON.stringify({ ...values, extractionId: reviewingItem.extractionId }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to save the candidate.");
      updateItem(reviewingItem.id, { saved: true });
      onCreated(reviewingItem.candidateId);
      setReviewingId(null);
    } catch (caught) {
      setReviewError(caught instanceof Error ? caught.message : "Failed to save the candidate.");
    } finally {
      setReviewBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className={recruitmentToolbarClassName}>
        {/* Rendered only if a second schema ever exists — the schema is universal now and the job
            title is an extracted field, so there is nothing left to pick before reading the CV.
            That matters most here: a bulk drop is a mixed pile of roles, and this control used to
            force one template onto all of them. */}
        {positionOptions.length > 1 ? (
          <select
            className={phxSelectClassName}
            disabled={running}
            onChange={(event) => setPositionKey(event.target.value)}
            value={positionKey}
          >
            {positionOptions.map((option) => (
              <option key={option.positionKey} value={option.positionKey}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        <div className="flex min-w-0 grow basis-60 flex-col gap-1.5">
          <span className={`inline-flex items-center gap-1.5 ${phxLabelTextClassName}`}>
            <Files aria-hidden="true" className="h-3.5 w-3.5 text-orange-600" />
            CV files
          </span>
          <span
            className={`flex min-w-0 items-center border border-dashed border-slate-300 bg-white px-3 py-2 ${adminRecessedDepthClassName}`}
          >
            <input
              ref={fileRef}
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
              className="min-w-0 max-w-full text-sm text-slate-700"
              multiple
              type="file"
            />
          </span>
        </div>
        <button
          className={`${phxButtonGhostClassName} ${adminControlDepthClassName} disabled:shadow-none`}
          disabled={running}
          onClick={() => void startBatch()}
          type="button"
        >
          {running ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : null}
          {running ? "Processing batch…" : "Create from CVs (bulk)"}
        </button>
      </div>

      {/* Desktop keeps the table; a phone gets cards. The wrapper here used to be
          `overflow-hidden`, not `overflow-x-auto`, so a long CV filename on a phone was not
          scrolled off — it was CLIPPED, and the Review button with it. A queue row whose
          action is invisible reads as "this one cannot be reviewed". */}
      {queue.length > 0 ? (
        <>
          <div className={`divide-y divide-slate-100 border border-slate-200 bg-white md:hidden ${adminSoftDepthClassName}`}>
            {queue.map((item) => (
              <div className="px-3 py-3" key={item.id}>
                {/* break-all, not truncate: a CV filename is how the reader tells two
                    candidates apart, and the owner's rule forbids an ellipsis. */}
                <p className="break-all text-sm font-bold text-slate-900" dir="auto">
                  {item.fileName}
                </p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <QueueStatus item={item} />
                  {item.status === "done" && !item.saved ? (
                    <button className={reviewButtonClassName} onClick={() => setReviewingId(item.id)} type="button">
                      <ClipboardCheck aria-hidden="true" className="h-3.5 w-3.5" />
                      Review
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className={`hidden border border-slate-200 bg-white md:block ${adminSoftDepthClassName}`}>
            <table className="w-full table-fixed text-sm" data-portal-desktop-table>
              <colgroup>
                <col className="w-[52%]" />
                <col className="w-[30%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead>
                <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2 font-semibold">File</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => (
                  <tr className="border-t border-slate-100 transition-colors hover:bg-slate-50/70" key={item.id}>
                    <td className="break-all px-3 py-2.5 font-semibold text-slate-900" dir="auto">
                      {item.fileName}
                    </td>
                    <td className="px-3 py-2.5">
                      <QueueStatus item={item} />
                    </td>
                    <td className="px-3 py-2.5">
                      {item.status === "done" && !item.saved ? (
                        <button className={reviewButtonClassName} onClick={() => setReviewingId(item.id)} type="button">
                          <ClipboardCheck aria-hidden="true" className="h-3.5 w-3.5" />
                          Review
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {reviewingItem?.fields ? (
        <CvExtractionReviewBoard
          busy={reviewBusy}
          error={reviewError}
          fields={reviewingItem.fields}
          onCancel={() => setReviewingId(null)}
          onSave={saveReviewing}
          saveLabel={`Save ${reviewingItem.fileName}`}
          schema={schema}
        />
      ) : null}
    </div>
  );
}
