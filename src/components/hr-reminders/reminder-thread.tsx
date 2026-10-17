"use client";

import { CornerDownRight, Eye, MessageSquare, Pencil, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Overlay } from "@/components/hr-reminders/overlay";
import { SharingBadge } from "@/components/hr-reminders/reminder-card";
import { remindersApi } from "@/components/hr-reminders/reminders-api";
import { COLOR_STYLES, MEDALLION } from "@/components/hr-reminders/reminder-style";
import { FormError } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import {
  describeSharing,
  formatTimeSpan,
  initialsOf,
  relativeDayLabel,
} from "@/lib/hr-reminders/logic";
import {
  REMINDER_COMMENT_MAX,
  type ReminderCommentView,
  type ReminderView,
  type TeamMember,
} from "@/lib/hr-reminders/types";
import { cn } from "@/lib/utils";

const COMMENT_STAMP = stableEnGbFormatter({
  day: "numeric",
  hour: "numeric",
  hour12: true,
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

function stamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : COMMENT_STAMP.format(date);
}

type Props = {
  onClose: () => void;
  onCommented: (reminderId: string) => void;
  onDelete: (reminder: ReminderView) => Promise<void>;
  onEdit: (reminder: ReminderView) => void;
  onToggle: (reminder: ReminderView) => void;
  reminder: ReminderView;
  team: TeamMember[];
  today: string;
};

export function ReminderThread({ onClose, onCommented, onDelete, onEdit, onToggle, reminder, team, today }: Props) {
  const [comments, setComments] = useState<ReminderCommentView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<ReminderCommentView | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await remindersApi<{ comments: ReminderCommentView[] }>("GET", `/api/hr-reminders/${reminder.id}/comments`);
        if (cancelled) return;
        setComments(result.comments);
        setLoadError(null);
      } catch (caught) {
        if (cancelled) return;
        setLoadError(caught instanceof Error ? caught.message : "The conversation could not be loaded.");
      }
    }
    // Deferred out of the synchronous effect body, as react-hooks/set-state-in-effect asks.
    const id = setTimeout(() => void load(), 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [reminder.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [comments?.length]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setSendError(null);
    try {
      const result = await remindersApi<{ comment: ReminderCommentView }>("POST", `/api/hr-reminders/${reminder.id}/comments`, {
        body,
        replyToId: replyTo?.id ?? null,
      });
      setComments((current) => [...(current ?? []), result.comment]);
      setDraft("");
      setReplyTo(null);
      onCommented(reminder.id);
    } catch (caught) {
      setSendError(caught instanceof Error ? caught.message : "The comment could not be sent.");
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await onDelete(reminder);
    } catch (caught) {
      setSendError(caught instanceof Error ? caught.message : "The reminder could not be removed.");
      setRemoving(false);
      setConfirmingRemove(false);
    }
  }

  const style = COLOR_STYLES[reminder.color];
  const done = reminder.status === "done";
  const timeSpan = formatTimeSpan(reminder.startsAt, reminder.endsAt);
  const byId = new Map((comments ?? []).map((comment) => [comment.id, comment]));

  return (
    <Overlay eyebrow={done ? "Reminder · done" : "Reminder"} onClose={onClose} title={reminder.title} wide>
      <div className="flex min-h-full flex-col">
        <section className="relative border-b border-slate-200 bg-slate-50/60 p-5">
          <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", style.bar)} />
          {reminder.body ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{reminder.body}</p>
          ) : (
            <p className="text-sm text-slate-400">No details were added.</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-semibold text-slate-600">
            {reminder.remindOn ? (
              <span className="font-bold text-orange-700">
                {relativeDayLabel(reminder.remindOn, today)}
                {timeSpan ? ` · ${timeSpan}` : ""}
              </span>
            ) : (
              <span className="text-slate-500">A note, no day</span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <span className={MEDALLION}>{initialsOf(reminder.ownerName)}</span>
              {reminder.ownerName}
            </span>
            <SharingBadge reminder={reminder} />
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
            <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            {describeSharing(reminder, team, reminder.ownerName)}
          </p>

          {reminder.canChange ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button className={phxButtonGhostClassName} onClick={() => onToggle(reminder)} type="button">
                {done ? "Mark as not done" : "Mark as done"}
              </button>
              <button className={phxButtonGhostClassName} onClick={() => onEdit(reminder)} type="button">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
              {confirmingRemove ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-700">Remove it for everyone?</span>
                  <button className={phxButtonDangerClassName} disabled={removing} onClick={remove} type="button">
                    Yes, remove
                  </button>
                  <button className={phxButtonGhostClassName} onClick={() => setConfirmingRemove(false)} type="button">
                    Keep it
                  </button>
                </span>
              ) : (
                <button className={phxButtonGhostClassName} onClick={() => setConfirmingRemove(true)} type="button">
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              )}
            </div>
          ) : null}
        </section>

        <section className="flex-1 space-y-3 p-5" aria-label="Conversation">
          <h3 className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wide text-slate-500">
            <MessageSquare className="h-3.5 w-3.5" /> Conversation
          </h3>

          {loadError ? <FormError>{loadError}</FormError> : null}
          {comments === null && !loadError ? <p className="text-sm text-slate-400">Loading the conversation.</p> : null}
          {comments !== null && comments.length === 0 ? (
            <p className="border border-dashed border-slate-300 bg-white px-4 py-5 text-sm text-slate-500">
              Nothing has been said yet. Anyone who can see this reminder can start the conversation.
            </p>
          ) : null}

          {(comments ?? []).map((comment) => {
            const parent = comment.replyToId ? byId.get(comment.replyToId) : undefined;
            return (
              <article
                className={cn(
                  "border bg-white p-3.5",
                  comment.mine ? "border-orange-200 border-l-[3px] border-l-orange-500" : "border-slate-200",
                )}
                key={comment.id}
              >
                <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className={MEDALLION}>{initialsOf(comment.authorName)}</span>
                  <span className="text-sm font-bold text-slate-900">{comment.mine ? "You" : comment.authorName}</span>
                  <time className="text-xs text-slate-400" dateTime={comment.createdAt}>
                    {stamp(comment.createdAt)}
                  </time>
                </header>
                {parent ? (
                  <blockquote className="mt-2 border-l-2 border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
                    <span className="font-bold text-slate-600">{parent.mine ? "You" : parent.authorName}</span>
                    <span className="mt-0.5 block whitespace-pre-wrap break-words">{parent.body}</span>
                  </blockquote>
                ) : null}
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{comment.body}</p>
                <button
                  className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-slate-500 transition hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                  onClick={() => setReplyTo(comment)}
                  type="button"
                >
                  <CornerDownRight className="h-3.5 w-3.5" /> Reply
                </button>
              </article>
            );
          })}
          <div ref={endRef} />
        </section>

        <section className="sticky bottom-0 border-t border-slate-200 bg-white p-4 shadow-[0_-8px_24px_rgba(15,23,42,0.06)]">
          {replyTo ? (
            <div className="mb-2 flex items-start justify-between gap-3 border-l-2 border-orange-500 bg-orange-50 px-3 py-1.5 text-xs text-slate-600">
              <span className="min-w-0">
                Replying to <span className="font-bold text-slate-800">{replyTo.mine ? "yourself" : replyTo.authorName}</span>
                <span className="mt-0.5 block whitespace-pre-wrap break-words text-slate-500">{replyTo.body}</span>
              </span>
              <button className="shrink-0 font-bold text-slate-500 hover:text-orange-600" onClick={() => setReplyTo(null)} type="button">
                Cancel
              </button>
            </div>
          ) : null}
          <label className="sr-only" htmlFor="reminder-comment">
            Write a comment
          </label>
          <textarea
            className={phxTextareaClassName}
            id="reminder-comment"
            maxLength={REMINDER_COMMENT_MAX}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={replyTo ? "Write your reply" : "Write a comment"}
            rows={3}
            value={draft}
          />
          {sendError ? <FormError className="mt-2">{sendError}</FormError> : null}
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">Ctrl + Enter sends. The people in this conversation see a notice.</span>
            <button className={phxButtonAccentClassName} disabled={sending || draft.trim().length === 0} onClick={() => void send()} type="button">
              <Send className="h-3.5 w-3.5" /> {sending ? "Sending" : "Send"}
            </button>
          </div>
        </section>
      </div>
    </Overlay>
  );
}
