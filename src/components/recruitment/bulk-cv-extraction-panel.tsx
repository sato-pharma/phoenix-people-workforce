"use client";

// Talent Acquisition — create several candidates from a batch of CVs at once. Files are
// processed sequentially (not in parallel — bounds AI cost/concurrency and avoids hammering
// the extraction endpoint with a burst of requests); each file gets its own row in a queue
// with its own status, and a failure on one file (e.g. an unsupported type) doesn't stop the
// rest of the batch. "Review" on a completed row opens the same drag-and-drop review board
// used by the single-CV flow.

import { useRef, useState } from "react";

import { CvExtractionReviewBoard } from "@/components/recruitment/cv-extraction-review-board";
import { Button } from "@/components/ui/button";
import type { ExtractedCandidateFields } from "@/lib/recruitment/cv-extraction";
import { defaultCvPositionKey, getCvPositionSchema, listCvPositionSchemas } from "@/lib/recruitment/cv-field-schemas";

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
      <div className="flex flex-wrap items-center gap-2">
        {/* Rendered only if a second schema ever exists — the schema is universal now and the job
            title is an extracted field, so there is nothing left to pick before reading the CV.
            That matters most here: a bulk drop is a mixed pile of roles, and this control used to
            force one template onto all of them. */}
        {positionOptions.length > 1 ? (
          <select
            className="rounded-md border border-gray-200 px-2 py-1.5 text-sm"
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
        <input ref={fileRef} accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" className="text-sm" multiple type="file" />
        <Button disabled={running} onClick={() => void startBatch()} variant="secondary">
          {running ? "Processing batch…" : "Create from CVs (bulk)"}
        </Button>
      </div>

      {/* Desktop keeps the table; a phone gets cards. The wrapper here used to be
          `overflow-hidden`, not `overflow-x-auto`, so a long CV filename on a phone was not
          scrolled off — it was CLIPPED, and the Review button with it. A queue row whose
          action is invisible reads as "this one cannot be reviewed". */}
      {queue.length > 0 ? (
        <>
          <div className="divide-y divide-slate-100 rounded border border-slate-200 md:hidden">
            {queue.map((item) => (
              <div className="px-3 py-2.5" key={item.id}>
                {/* break-all, not truncate: a CV filename is how the reader tells two
                    candidates apart, and the owner's rule forbids an ellipsis. */}
                <p className="break-all text-sm font-bold text-slate-900" dir="auto">
                  {item.fileName}
                </p>
                <div className="mt-1.5 flex items-center justify-between gap-3">
                  <span className={`text-xs ${item.status === "error" ? "text-rose-600" : "text-slate-600"}`}>
                    {statusLabel(item)}
                  </span>
                  {item.status === "done" && !item.saved ? (
                    <Button onClick={() => setReviewingId(item.id)} size="sm" variant="secondary">
                      Review
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className="hidden overflow-hidden rounded border border-slate-200 md:block">
            <table className="w-full text-sm" data-portal-desktop-table>
              <thead>
                <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2 font-semibold">File</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => (
                  <tr className="border-t border-slate-100" key={item.id}>
                    <td className="px-3 py-2">{item.fileName}</td>
                    <td className={`px-3 py-2 ${item.status === "error" ? "text-rose-600" : "text-slate-600"}`}>
                      {statusLabel(item)}
                    </td>
                    <td className="px-3 py-2">
                      {item.status === "done" && !item.saved ? (
                        <Button onClick={() => setReviewingId(item.id)} size="sm" variant="secondary">
                          Review
                        </Button>
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
