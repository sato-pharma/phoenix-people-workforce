"use client";

// WhatsApp Inbox — the box at the foot of a chat: a written reply, a photo or file, or a template.
//
// WhatsApp decides what may be sent, not this screen. A written reply or a file is allowed only
// within 24 hours of the person's own last message; after that only an approved template is. So the
// composer reads the thread's `canSend` and window close time and offers only what will actually go,
// rather than letting a paragraph be typed and then refused by Meta.
//
// Nothing retries. A send that fails says so and leaves the text in the box: a duplicate message on
// someone's phone is worse than a failure the sender can see and repeat.

import { useRef, useState } from "react";
import { FileText, Paperclip, X } from "lucide-react";

import { Action, Band, BandSays } from "@/components/recruitment/workstation/workstation-look";
import { postJson } from "@/components/recruitment/recruitment-fetch";
import { INBOX_UPLOAD_MAX_BYTES, mediaLimitProblem, outboundMediaTypeFor } from "@/lib/whatsapp-inbox/graph";

import { formatByteSize, formatWindowLeft } from "./inbox-format";
import { InboxTemplateForm, type TemplateSendInput } from "./inbox-template-form";

/** Meta's ceilings, repeated here only so the box refuses before the upload rather than after. */
const TEXT_MAX_LENGTH = 4096;
const CAPTION_MAX_LENGTH = 1024;

type Mode = "text" | "template";

async function postForm(url: string, form: FormData): Promise<Record<string, unknown>> {
  const res = await fetch(url, { body: form, method: "POST" });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "The file was not sent.");
  return data;
}

/** Why a chosen file cannot go, in a sentence — or null when it can. */
export function outboundFileProblem(file: { size: number; type: string }): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > INBOX_UPLOAD_MAX_BYTES) return "Files over 25 MB cannot be sent from the inbox.";
  const type = outboundMediaTypeFor(file.type || "application/octet-stream");
  return mediaLimitProblem(type, file.size);
}

export function InboxComposer({
  canSend,
  cannotSendReason,
  conversationId,
  lineId,
  onSent,
  windowClosesAt,
}: {
  canSend: boolean;
  cannotSendReason: string | null;
  conversationId: string;
  lineId: string;
  onSent: () => Promise<void> | void;
  windowClosesAt: string | null;
}) {
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Read at render: the window keeps running from THEIR last message, and a chat left open for an
  // hour must not claim the time it had when it was opened.
  const windowLeft = formatWindowLeft(windowClosesAt);
  const windowOpen = windowLeft !== null;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onSent();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The message was not sent.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendText() {
    const body = text.trim();
    if (!body || busy) return;
    const ok = await run(() => postJson(`/api/whatsapp-inbox/conversations/${conversationId}/messages`, { kind: "text", text: body }));
    if (ok) setText("");
  }

  async function sendFile() {
    if (!file || busy) return;
    const form = new FormData();
    form.set("file", file);
    if (text.trim()) form.set("caption", text.trim().slice(0, CAPTION_MAX_LENGTH));
    const ok = await run(() => postForm(`/api/whatsapp-inbox/conversations/${conversationId}/messages`, form));
    if (ok) {
      setFile(null);
      setText("");
    }
  }

  async function sendTemplate(input: TemplateSendInput) {
    const ok = await run(() => postJson(`/api/whatsapp-inbox/conversations/${conversationId}/messages`, { kind: "template", ...input }));
    if (ok) setMode("text");
  }

  // `canSend` is whether Phoenix can write to this person AT ALL (a username-only contact cannot be
  // messaged by a business); the 24-hour window is a separate, later question.
  if (!canSend) {
    return (
      <Band tone="warn">
        <BandSays>{cannotSendReason ?? "Phoenix cannot send to this chat."}</BandSays>
      </Band>
    );
  }

  const fileProblem = file ? outboundFileProblem(file) : null;

  return (
    <div className="shrink-0 border-t border-phx-line bg-white px-3 py-2 sm:px-4">
      {mode === "template" ? (
        <InboxTemplateForm
          busy={busy}
          key={lineId}
          line={lineId}
          onCancel={() => setMode("text")}
          onSend={(input) => void sendTemplate(input)}
          submitLabel="Send template"
        />
      ) : windowOpen ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] leading-snug text-phx-ink-soft">
            {windowLeft} to reply in your own words. After that, WhatsApp only allows an approved template.
          </p>
          {file ? (
            <div className="flex flex-wrap items-center gap-2 border border-phx-line bg-phx-surface-2 px-2 py-1.5 text-[12px]">
              <FileText aria-hidden className="h-4 w-4 shrink-0 text-phx-ink-soft" />
              <span className="min-w-0 flex-1 break-words font-semibold text-phx-ink" dir="auto">
                {file.name}
              </span>
              <span className="text-phx-ink-soft">{formatByteSize(file.size)}</span>
              <Action disabled={busy} onClick={() => setFile(null)} title="Remove this file" tone="ghost">
                <X aria-hidden className="h-3.5 w-3.5" />
                Remove
              </Action>
            </div>
          ) : null}
          {fileProblem ? <p className="text-[12px] leading-snug text-phx-danger">{fileProblem}</p> : null}
          <textarea
            className="w-full resize-y border border-phx-line bg-white p-2 text-[13px] leading-relaxed text-phx-ink outline-none focus:border-phx-accent"
            dir="auto"
            disabled={busy}
            maxLength={file ? CAPTION_MAX_LENGTH : TEXT_MAX_LENGTH}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void (file ? sendFile() : sendText());
              }
            }}
            placeholder={file ? "Add a caption (optional)…" : "Write a reply…  (Ctrl+Enter sends)"}
            rows={2}
            value={text}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {file ? (
              <Action disabled={busy || Boolean(fileProblem)} onClick={() => void sendFile()} tone="primary">
                {busy ? "Sending…" : "Send file"}
              </Action>
            ) : (
              <Action disabled={busy || text.trim().length === 0} onClick={() => void sendText()} tone="primary">
                {busy ? "Sending…" : "Send"}
              </Action>
            )}
            <input
              className="hidden"
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                event.target.value = "";
                setError(null);
                setFile(chosen);
              }}
              ref={fileInput}
              type="file"
            />
            <Action disabled={busy} onClick={() => fileInput.current?.click()} title="Send a photo, video, voice note or document" tone="quiet">
              <Paperclip aria-hidden className="h-3.5 w-3.5" />
              Attach
            </Action>
            <Action disabled={busy} onClick={() => setMode("template")} tone="ghost">
              Use a template
            </Action>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[12px] leading-snug text-phx-ink-soft">
            {windowClosesAt
              ? "It has been more than 24 hours since their last message, so WhatsApp only allows an approved template until they write again."
              : "They have not written to this number, so WhatsApp only allows an approved template until they do."}
          </p>
          <div>
            <Action disabled={busy} onClick={() => setMode("template")} tone="primary">
              Send a template
            </Action>
          </div>
        </div>
      )}
      {error ? <p className="mt-2 text-[12px] leading-snug text-phx-danger">{error}</p> : null}
    </div>
  );
}
