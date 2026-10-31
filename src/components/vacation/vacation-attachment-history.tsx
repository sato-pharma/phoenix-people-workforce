"use client";

import { useRef, useState } from "react";
import { FileText, Loader2, Paperclip } from "lucide-react";
import { useRouter } from "next/navigation";

import { cairoDateTime12h } from "@/lib/format/cairo-datetime";
import type { VacationRequestAttachment } from "@/lib/vacation/types";

/*
 * Every evidence file on a leave request, each on its own line WITH THE DATE IT ARRIVED — the whole
 * point of the owner's 2026-10-03 ruling: *"I get the admin get that till the day — for example
 * 3 October he uploaded this, by 10 October he uploaded those"*. One slot with one date could not
 * say that, so the history is the list and a later upload adds a line rather than overwriting one.
 *
 * `canUpload` is deliberately separate from being able to OPEN the files: an assigned manager may
 * read the sick note before approving, but only the employee who filed the request and HR/Super
 * Admin may add to it. The route enforces the same split — this prop only keeps a button off a
 * screen where pressing it would be refused.
 */

const MAX_FILES_PER_UPLOAD = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_LABEL = "20MB";
// A request with a dozen files made one table row thousands of pixels tall, so the list shows this many and expands on demand.
const COLLAPSED_ATTACHMENT_COUNT = 3;

// Built from digits, never asked of the browser. This list is drawn on the server and again in the
// reader's browser, so the two texts must be byte-identical: `Intl.DateTimeFormat("en", { hour12:
// true })` put a plain space before PM on the server and U+202F on every Apple device, and the
// vacation approval page threw React #418 for a Regional Manager's iPhone and a Super Admin's Mac
// on sick notes (System Audit, 28 and 31 Oct 2026) — the Vacation Report's bug, a second time.
function formatUploadedAt(value: string | null | undefined) {
  return cairoDateTime12h(value);
}

function fileLabel(attachment: VacationRequestAttachment) {
  if (attachment.originalName) return attachment.originalName;
  return attachment.kind === "compensatory" ? "Event photo" : "Medical document";
}

function sizeLabel(sizeBytes: number) {
  if (!sizeBytes) return null;
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))}KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Stream one file straight to Storage and return the pending path the add route accepts. */
async function uploadToPendingSlot(file: File, kind: "compensatory" | "sick") {
  const urlRes = await fetch("/api/vacations/attachments/upload-url", {
    body: JSON.stringify({ fileName: file.name, kind }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const urlPayload = (await urlRes.json().catch(() => ({}))) as { message?: string; path?: string; signedUrl?: string };
  if (!urlRes.ok || !urlPayload.signedUrl || !urlPayload.path) {
    throw new Error(urlPayload.message ?? "Could not start the upload for this file.");
  }
  const putRes = await fetch(urlPayload.signedUrl, {
    body: file,
    headers: { "content-type": file.type || "application/octet-stream", "x-upsert": "false" },
    method: "PUT",
  });
  if (!putRes.ok) throw new Error(`${file.name} could not be uploaded. Please try again.`);
  return urlPayload.path;
}

export function VacationAttachmentHistory({
  attachments,
  canUpload,
  kind,
  requestId,
}: {
  attachments: VacationRequestAttachment[];
  canUpload: boolean;
  kind: "compensatory" | "sick";
  requestId: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedCount, setAddedCount] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const visibleAttachments = expanded ? attachments : attachments.slice(0, COLLAPSED_ATTACHMENT_COUNT);
  const hiddenCount = attachments.length - visibleAttachments.length;

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    if (files.length > MAX_FILES_PER_UPLOAD) {
      setError(`Upload up to ${MAX_FILES_PER_UPLOAD} files at a time.`);
      return;
    }
    const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      const sizeMb = (oversized.size / (1024 * 1024)).toFixed(1);
      setError(`${oversized.name} is too large (${sizeMb}MB). Maximum size is ${MAX_ATTACHMENT_LABEL} per file.`);
      return;
    }

    setBusy(true);
    try {
      const uploaded: { contentType: string; fileName: string; path: string }[] = [];
      for (const file of files) {
        uploaded.push({
          contentType: file.type,
          fileName: file.name,
          path: await uploadToPendingSlot(file, kind),
        });
      }
      const response = await fetch(`/api/vacations/requests/${encodeURIComponent(requestId)}/attachments`, {
        body: JSON.stringify({ files: uploaded }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { added?: unknown[]; message?: string };
      if (!response.ok) throw new Error(payload.message ?? "The documents could not be added.");
      setAddedCount(Array.isArray(payload.added) ? payload.added.length : files.length);
      router.refresh();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The documents could not be added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      {attachments.length > 0 ? (
        <ul className="space-y-1">
          {visibleAttachments.map((attachment) => (
            <li key={attachment.id}>
              <a
                className="flex flex-col gap-0.5 rounded-sm border border-sky-200 bg-sky-50 px-2 py-1.5 transition hover:border-sky-300 hover:bg-sky-100"
                href={`/api/vacations/requests/${encodeURIComponent(requestId)}/attachments/file/${encodeURIComponent(attachment.id)}`}
                rel="noreferrer"
                target="_blank"
              >
                <span className="flex min-w-0 items-start gap-1.5 text-phx-2xs font-bold leading-4 text-sky-700">
                  <FileText className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="break-words">{fileLabel(attachment)}</span>
                </span>
                <span className="pl-[18px] text-phx-2xs font-semibold text-slate-500">
                  {formatUploadedAt(attachment.uploadedAt)}
                  {sizeLabel(attachment.sizeBytes) ? ` · ${sizeLabel(attachment.sizeBytes)}` : ""}
                </span>
              </a>
            </li>
          ))}
          {attachments.length > COLLAPSED_ATTACHMENT_COUNT ? (
            <li>
              <button
                className="w-full rounded-sm border border-sky-200 bg-white px-2 py-1 text-left text-phx-2xs font-bold text-sky-700 transition hover:bg-sky-50"
                onClick={() => setExpanded((open) => !open)}
                type="button"
              >
                {expanded ? "Show fewer documents" : `Show all ${attachments.length} documents (${hiddenCount} more)`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="text-phx-2xs font-semibold text-slate-500">No documents uploaded yet.</p>
      )}

      {canUpload ? (
        <div className="space-y-1">
          <input
            accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp"
            className="sr-only"
            multiple
            ref={inputRef}
            type="file"
            // Cleared after every pick so the same file, or a second trip to the picker, still fires.
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void uploadFiles(files);
            }}
          />
          <button
            className="inline-flex items-center gap-1.5 rounded-sm border border-sky-600 bg-sky-600 px-2.5 py-1.5 text-phx-2xs font-bold text-white transition hover:bg-sky-700 disabled:opacity-50"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Paperclip className="h-3 w-3" />}
            {busy ? "Uploading..." : "Add documents"}
          </button>
          <p className="text-phx-2xs font-medium leading-4 text-slate-500">
            New files are added to the ones above — nothing already uploaded is replaced or removed.
          </p>
          {addedCount > 0 && !busy ? (
            <p className="text-phx-2xs font-bold text-emerald-700">
              {addedCount} document{addedCount === 1 ? "" : "s"} added.
            </p>
          ) : null}
          {error ? <p className="text-phx-2xs font-bold text-rose-700">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
