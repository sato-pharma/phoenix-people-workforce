"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";

import { AdminCallout, AdminSectionHeader } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AUTO_REPLY_BODY_MAX, autoReplyViolations } from "@/lib/recruitment/inbound/whatsapp-auto-replies";
import { phxTextareaClassName } from "@/components/ui/form-tokens";

/**
 * The messages the WhatsApp bot sends BY ITSELF — the ones around the questions rather than the
 * questions themselves.
 *
 * Sits BELOW the six built-in questions and the extra-question builder on the same screen, because
 * that is the order the page already tells the story in and these are what brackets the
 * conversation: the ask-for-a-CV replies come before a CV exists, the closing summary after the last
 * answer.
 *
 * Each message saves on its own, like each question does. These words reach members of the public in
 * the company's name on the very next applicant, and one "save everything" button would republish
 * five messages the owner never looked at.
 *
 * Every message is shown in full, Arabic block and English block together, exactly as an applicant
 * receives it — no preview pane, no truncation, no ellipsis. Typing the default back in word for
 * word is sent as a blank, which deletes the row: there is never a copy of a default in the
 * database to go stale the day the default is improved.
 */

export type AutoReplyEditorRow = {
  key: string;
  label: string;
  note: string;
  defaultBody: string;
  requiredTokens: readonly string[];
  savedBody: string | null;
};

type Props = { initialReplies: AutoReplyEditorRow[] };

function counterClass(length: number, max: number): string {
  if (length > max) return "text-red-600";
  if (length > max * 0.9) return "text-amber-600";
  return "text-slate-400";
}

/** What the applicant reads right now: the owner's wording if he saved one, else the code default. */
function liveBody(reply: AutoReplyEditorRow): string {
  return reply.savedBody ?? reply.defaultBody;
}

export function WhatsAppAutoRepliesEditor({ initialReplies }: Props) {
  const [replies, setReplies] = React.useState<AutoReplyEditorRow[]>(initialReplies);
  const [drafts, setDrafts] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(initialReplies.map((reply) => [reply.key, liveBody(reply)])),
  );
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  function applyServerReplies(next: AutoReplyEditorRow[]) {
    setReplies(next);
    setDrafts(Object.fromEntries(next.map((reply) => [reply.key, liveBody(reply)])));
  }

  async function post(key: string, bodyText: string, successMessage: string) {
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/whatsapp-auto-replies", {
        body: JSON.stringify({ bodyText, key }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(json.message ?? json.error ?? `HTTP ${response.status}`);
      }
      const json = (await response.json()) as { replies: AutoReplyEditorRow[] };
      applyServerReplies(json.replies ?? []);
      setNotice(successMessage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-4">
      <AdminSectionHeader
        description="These are the messages the bot sends on its own, around the questions above — when somebody writes with no CV, when a photo arrives instead of a file, when the file is too large, and the summary at the end. Every word here reaches a member of the public in the company's name, so say only what is true: never put a salary, a deadline or a requirement in one of these. What you cannot move is when each is sent, and the summary lines of the closing message, which are written from what the applicant actually answered."
        title="The messages the bot sends by itself"
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </AdminCallout>
      ) : null}

      {notice ? (
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </AdminCallout>
      ) : null}

      <div className="space-y-3">
        {replies.map((reply) => {
          const draft = drafts[reply.key] ?? liveBody(reply);
          const dirty = draft.trim() !== liveBody(reply).trim();
          const issues = autoReplyViolations({ bodyText: draft, key: reply.key });
          const emptied = draft.trim().length === 0;
          const busy = busyKey === reply.key;

          return (
            <Card className="p-4" key={reply.key}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">{reply.label}</p>
                  <p className="mt-0.5 text-phx-xs text-slate-500">{reply.note}</p>
                </div>
                <span
                  className={
                    reply.savedBody
                      ? "bg-orange-50 px-2 py-0.5 text-phx-xs font-semibold text-orange-700"
                      : "bg-slate-100 px-2 py-0.5 text-phx-xs font-semibold text-slate-500"
                  }
                >
                  {reply.savedBody ? "Your wording" : "Default"}
                </span>
              </div>

              <label className="mt-3 block text-phx-xs font-medium text-slate-600" htmlFor={`auto-reply-${reply.key}`}>
                What the applicant reads
              </label>
              <textarea
                className={`${phxTextareaClassName} mt-1`}
                dir="auto"
                disabled={busy}
                id={`auto-reply-${reply.key}`}
                onChange={(event) =>
                  setDrafts((prev) => ({ ...prev, [reply.key]: event.target.value }))
                }
                rows={reply.defaultBody.split("\n").length + 2}
                value={draft}
              />

              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <span className="text-phx-xs text-slate-500">
                  Arabic first, then English — the adverts run in Arabic and most applicants write in
                  Arabic. A blank line separates the two blocks, and *stars* make a word bold on
                  WhatsApp.
                </span>
                <span className={`text-phx-xs ${counterClass(draft.trim().length, AUTO_REPLY_BODY_MAX)}`}>
                  {draft.trim().length} / {AUTO_REPLY_BODY_MAX}
                </span>
              </div>

              {reply.requiredTokens.length > 0 ? (
                <p className="mt-1 text-phx-xs text-slate-500">
                  Keep{" "}
                  {reply.requiredTokens.map((token) => (
                    <code className="bg-slate-100 px-1 py-0.5 text-slate-700" key={token}>
                      {token}
                    </code>
                  ))}{" "}
                  in this message — the bot fills in the size limit actually in force, so the sentence
                  stays true if that setting changes.
                </p>
              ) : null}

              {/* Emptying the box is a RESET, not a message of nothing, and the screen says so before
                  the owner presses Save rather than after. Silence is the one outcome none of these
                  messages may produce: an applicant who sent a photo and heard nothing back is the
                  failure the whole feature exists to prevent. */}
              {emptied ? (
                <p className="mt-2 text-phx-xs text-amber-600">
                  Empty means back to the default wording — the bot never sends an empty message.
                </p>
              ) : null}

              {issues.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {issues.map((issue) => (
                    <p className="text-phx-xs text-red-600" key={issue}>
                      {issue}
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  disabled={busy || !dirty || issues.length > 0}
                  onClick={() =>
                    post(
                      reply.key,
                      // Typing the default back in word for word is sent as a blank, so the row is
                      // dropped rather than storing a copy that would go stale the day the default
                      // is improved.
                      draft.trim() === reply.defaultBody.trim() ? "" : draft.trim(),
                      "Saved. The bot uses this on the very next applicant.",
                    )
                  }
                  size="sm"
                >
                  {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  Save this message
                </Button>

                {reply.savedBody ? (
                  <Button
                    disabled={busy}
                    onClick={() => post(reply.key, "", "Back to the default wording.")}
                    size="sm"
                    variant="outline"
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    Reset to default
                  </Button>
                ) : null}

                {dirty ? <span className="text-phx-xs text-amber-600">Not saved yet</span> : null}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
