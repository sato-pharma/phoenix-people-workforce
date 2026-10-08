"use client";

import { useRef, useState } from "react";
import { ImagePlus, Send, X } from "lucide-react";

import { phxButtonGhostClassName, phxButtonPrimaryClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { DISPUTE_ATTACHMENT_MAX_FILES } from "@/lib/dispute-center/attachment-rules.ts";
import type { DisputeAttachment, DisputeCase, DisputeMessage } from "@/lib/dispute-center/types.ts";

// ONE conversation for all three dispute modules. Both sides read the same component, so the two can
// never drift into two different answers to "who said what, and when" — the failure the three
// separate screens were already heading for.
//
// Pictures ride on a reply from EITHER side (owner, 2026-10-09: "upload a picture in both") and are
// served through a permission-checked route, never a stored link.

function authorLabel(message: DisputeMessage, employeeName: string): string {
  const name = message.authorName?.trim();
  if (message.side === "reviewer") return name ? `${name} · reviewer` : "Reviewer";
  return name || employeeName;
}

function Pictures({ attachments }: { attachments: DisputeAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <a
          className="block border border-slate-200 bg-white p-1 transition hover:border-orange-500"
          href={attachment.url}
          key={attachment.id}
          rel="noreferrer"
          target="_blank"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt={attachment.fileName} className="h-20 w-20 object-cover" src={attachment.url} />
        </a>
      ))}
    </div>
  );
}

function Line({ employeeName, message }: { employeeName: string; message: DisputeMessage }) {
  const fromReviewer = message.side === "reviewer";
  return (
    <li className={`border-l-2 pl-3 ${fromReviewer ? "border-l-orange-400" : "border-l-slate-300"}`}>
      <p className="flex flex-wrap items-baseline gap-x-2 text-phx-xs font-black uppercase tracking-wide text-slate-500">
        <span>{authorLabel(message, employeeName)}</span>
        <span className="font-bold normal-case tracking-normal text-slate-400">{cairoDateTime(message.createdAt)}</span>
      </p>
      {/* The body keeps its line breaks — a dispute is usually a list of times and places. */}
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{message.body}</p>
      <Pictures attachments={message.attachments} />
    </li>
  );
}

export function DisputeConversation({
  dispute,
  onSent,
}: {
  dispute: DisputeCase;
  onSent: () => void | Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const url = `/api/dispute-center/cases/${dispute.kind}/${encodeURIComponent(dispute.ref)}/messages`;
      let response: Response;
      if (files.length > 0) {
        const form = new FormData();
        form.set("body", body);
        for (const file of files) form.append("images", file);
        response = await fetch(url, { body: form, method: "POST" });
      } else {
        response = await fetch(url, {
          body: JSON.stringify({ body }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
      }
      const payload = (await response.json().catch(() => ({}))) as { message?: string; success?: boolean };
      if (!response.ok || payload.success !== true) throw new Error(payload.message || "The reply was not sent.");
      setBody("");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      await onSent();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The reply was not sent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-slate-200 bg-white">
      <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-black uppercase tracking-wide text-slate-600">
        Conversation
      </h3>
      <ul className="space-y-4 p-4">
        <Line employeeName={dispute.employeeName} message={dispute.opening} />
        {dispute.messages.map((message) => (
          <Line employeeName={dispute.employeeName} key={message.id} message={message} />
        ))}
      </ul>

      {dispute.canReply ? (
        <div className="border-t border-slate-200 p-4">
          <textarea
            className={phxTextareaClassName}
            disabled={busy}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Write a reply. Line breaks are kept."
            rows={3}
            value={body}
          />
          {files.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {files.map((file, index) => (
                <li className="flex items-center gap-1.5 border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700" key={`${file.name}-${index}`}>
                  <span className="break-all">{file.name}</span>
                  <button
                    aria-label={`Remove ${file.name}`}
                    className="text-slate-400 transition hover:text-rose-600"
                    onClick={() => setFiles((current) => current.filter((_, at) => at !== index))}
                    type="button"
                  >
                    <X aria-hidden className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? <p className="mt-2 text-xs font-bold text-rose-700">{error}</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className={phxButtonPrimaryClassName} disabled={busy || (!body.trim() && files.length === 0)} onClick={send} type="button">
              <Send aria-hidden className="h-4 w-4" />
              {busy ? "Sending…" : "Send"}
            </button>
            <label className={cn(phxButtonGhostClassName, "cursor-pointer")}>
              <ImagePlus aria-hidden className="h-4 w-4" />
              Add pictures
              <input
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                disabled={busy}
                multiple
                onChange={(event) => {
                  const chosen = Array.from(event.target.files ?? []);
                  setFiles((current) => [...current, ...chosen].slice(0, DISPUTE_ATTACHMENT_MAX_FILES));
                }}
                ref={fileInput}
                type="file"
              />
            </label>
            <span className="text-xs text-slate-400">Up to {DISPUTE_ATTACHMENT_MAX_FILES} pictures, 5 MB each.</span>
          </div>
        </div>
      ) : (
        <p className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
          This case is decided. Ask for it to be looked at again to reopen the conversation.
        </p>
      )}
    </section>
  );
}
