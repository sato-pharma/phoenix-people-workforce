"use client";

// Recruitment / ATS — the two tabs that read the candidate's RECORD rather than their CV.
//
// Both fetch their own data, on open, and neither is on the hot path: the workstation prefetches the
// NEXT candidate's profile while you read the current one, and putting five more queries on that
// request would pay for a history most reviews never look at. So these arrive when the tab does.
//
// TIMELINE FABRICATES NOTHING. Every line comes from a stored timestamp — the arrival, the CV read,
// each status move, each send, each interview, each note. A candidate whose record is thin gets a
// short timeline, not a plausible one, and "nothing has happened yet" is written as an answer.
//
// NOTES ARE THE EXISTING NOTES. `ats_candidate_comments` — the same rows a hiring manager writes on
// their own screen and the same rows the timeline reads. There is no separate recruiter store, so
// nothing already written became invisible when this screen replaced the old one, and a reply from
// a manager and a recruiter's own note sit in one conversation instead of two that cannot see each
// other.

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Send } from "lucide-react";

import { CANDIDATE_COMMENT_MAX_LENGTH, type CandidateComment } from "@/lib/recruitment/types";
import { cairoStamp, EmptyNote } from "@/components/recruitment/workstation/workstation-ui";
import type { CandidateTimelineEvent, CandidateTimelineKind } from "@/lib/recruitment/candidate-timeline";
import { cn } from "@/lib/utils";
import { phxButtonAccentClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { adminControlDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";

/** The dot beside each line. Colour is the only thing carrying the kind, so it stays semantic. */
const kindTone: Record<CandidateTimelineKind, string> = {
  arrival: "bg-phx-info",
  decision: "bg-phx-accent",
  interview: "bg-phx-ok",
  manager: "bg-phx-warn",
  note: "bg-phx-ink-soft",
  read: "bg-phx-ink-faint",
};

export function WorkstationTimelineTab({ candidateId }: { candidateId: string }) {
  // THE CANDIDATE ID IS STORED WITH THE ANSWER, and the reset is derived rather than done in an
  // effect. Clearing the state from `useEffect` paints the PREVIOUS candidate's history for one
  // frame under the new candidate's name — a real misread on a screen where somebody is deciding
  // whether to interview a person — and it is a lint error here for that reason. Keeping the id
  // beside the data means a stale answer is never rendered at all.
  const [loaded, setLoaded] = useState<{ id: string; events: CandidateTimelineEvent[] | null; error: string | null }>(
    { error: null, events: null, id: candidateId },
  );
  const current = loaded.id === candidateId ? loaded : { error: null, events: null, id: candidateId };
  const { error, events } = current;

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/recruitment/candidates/${candidateId}/timeline`);
        const data = (await res.json().catch(() => ({}))) as { events?: CandidateTimelineEvent[]; message?: string };
        if (!res.ok) throw new Error(data.message ?? "Could not load this candidate's history.");
        if (active) setLoaded({ error: null, events: data.events ?? [], id: candidateId });
      } catch (caught) {
        if (active) {
          setLoaded({
            error: caught instanceof Error ? caught.message : "Could not load this candidate's history.",
            events: null,
            id: candidateId,
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [candidateId]);

  if (error) return <p className="px-3 py-4 text-[13px] leading-relaxed text-phx-danger">{error}</p>;
  if (events === null) {
    return (
      <p className="flex items-center gap-2 px-3 py-4 text-[13px] text-phx-ink-soft">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading the history…
      </p>
    );
  }
  if (events.length === 0) {
    return <EmptyNote>Nothing has happened to this candidate yet beyond their CV arriving.</EmptyNote>;
  }

  return (
    <ol className="px-3 py-2">
      {events.map((event) => (
        <li className="relative flex gap-2.5 pb-3 last:pb-0" key={event.id}>
          {/* The rail is drawn with a border on the dot's column rather than as a pseudo-element, so
              the last item simply stops instead of trailing a line into nothing. */}
          <span className="relative flex w-2 shrink-0 justify-center">
            <span aria-hidden className={cn("mt-1 h-2 w-2 shrink-0", kindTone[event.kind])} />
            <span aria-hidden className="absolute left-1/2 top-3.5 h-[calc(100%-0.5rem)] w-px -translate-x-1/2 bg-phx-line" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block break-words text-[13px] font-semibold leading-tight text-phx-ink">{event.title}</span>
            {event.detail ? (
              <span className="mt-0.5 block break-words text-[12px] leading-tight text-phx-ink-soft">{event.detail}</span>
            ) : null}
            <span className="mt-0.5 block text-[11px] text-phx-ink-faint">{cairoStamp(event.at)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function WorkstationNotesTab({
  canWrite,
  candidateId,
  onCountChange,
}: {
  canWrite: boolean;
  candidateId: string;
  /** So the tab strip's badge tracks a note added here without refetching the whole workspace. */
  onCountChange?: (count: number) => void;
}) {
  // Same shape as the timeline above, and for the same reason — plus one that matters more here:
  // an UNSENT DRAFT must never survive onto the next candidate. Clearing it in an effect leaves one
  // rendered frame in which a note written about one applicant sits in the box under another's
  // name, one keystroke away from being saved to the wrong record.
  const [loaded, setLoaded] = useState<{ id: string; notes: CandidateComment[] | null; error: string | null }>(
    { error: null, id: candidateId, notes: null },
  );
  const [typed, setTyped] = useState<{ id: string; text: string }>({ id: candidateId, text: "" });
  const [saving, setSaving] = useState(false);

  const current = loaded.id === candidateId ? loaded : { error: null, id: candidateId, notes: null };
  const { error, notes } = current;
  const draft = typed.id === candidateId ? typed.text : "";

  const report = useCallback(
    (list: CandidateComment[]) => {
      setLoaded({ error: null, id: candidateId, notes: list });
      onCountChange?.(list.length);
    },
    [candidateId, onCountChange],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/recruitment/candidates/${candidateId}/notes`);
        const data = (await res.json().catch(() => ({}))) as { notes?: CandidateComment[]; message?: string };
        if (!res.ok) throw new Error(data.message ?? "Could not load the notes on this candidate.");
        if (active) setLoaded({ error: null, id: candidateId, notes: data.notes ?? [] });
      } catch (caught) {
        if (active) {
          setLoaded({
            error: caught instanceof Error ? caught.message : "Could not load the notes on this candidate.",
            id: candidateId,
            notes: null,
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [candidateId]);

  const save = async () => {
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    setLoaded({ error: null, id: candidateId, notes });
    try {
      const res = await fetch(`/api/recruitment/candidates/${candidateId}/notes`, {
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as { note?: CandidateComment; message?: string; error?: string };
      if (!res.ok || !data.note) throw new Error(data.message ?? data.error ?? "Could not save the note.");
      // Newest first, matching what the route returns on a reload — a note that jumps position the
      // next time the tab opens reads as a second note.
      report([data.note, ...(notes ?? [])]);
      setTyped({ id: candidateId, text: "" });
    } catch (caught) {
      setLoaded({
        error: caught instanceof Error ? caught.message : "Could not save the note.",
        id: candidateId,
        notes,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      {canWrite ? (
        // The note box sits in a recessed well at the head of the tab; the field itself is the one
        // form design's textarea, and the save is the form kit's terminal commit at the pane's size.
        <div className={cn("shrink-0 border-b border-phx-line bg-phx-paper p-2", adminRecessedDepthClassName)}>
          <textarea
            aria-label="Add a note"
            className={`${phxTextareaClassName} leading-relaxed`}
            maxLength={CANDIDATE_COMMENT_MAX_LENGTH}
            onChange={(event) => setTyped({ id: candidateId, text: event.target.value })}
            /* Said in the placeholder because it is true and people assume otherwise: a note on a
               candidate is part of their record, and anyone who can open the candidate can read it. */
            placeholder="Add a note. Anyone who can open this candidate can read it."
            rows={2}
            value={draft}
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              className={cn(
                phxButtonAccentClassName,
                "px-2.5 py-1 text-[12px] disabled:opacity-45",
                adminControlDepthClassName,
                "disabled:shadow-none",
              )}
              disabled={saving || draft.trim().length === 0}
              onClick={() => void save()}
              type="button"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Save note
            </button>
            <span className="text-[11px] tabular-nums text-phx-ink-faint">
              {draft.length} / {CANDIDATE_COMMENT_MAX_LENGTH}
            </span>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="shrink-0 border-b border-phx-danger-line bg-phx-danger-bg px-3 py-1.5 text-[12px] font-semibold text-phx-danger">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1">
        {notes === null ? (
          <p className="flex items-center gap-2 px-3 py-4 text-[13px] text-phx-ink-soft">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Reading the notes…
          </p>
        ) : notes.length === 0 ? (
          <EmptyNote>
            {canWrite
              ? "Nobody has written a note on this candidate yet."
              : "Nobody has written a note on this candidate yet, and you do not have permission to add one."}
          </EmptyNote>
        ) : (
          <ul>
            {notes.map((note) => (
              <li className="border-b border-phx-line px-3 py-2 last:border-b-0" key={note.id}>
                <p className="flex flex-wrap items-baseline gap-x-2 text-[12px] font-bold text-phx-ink">
                  <MessageSquare aria-hidden className="h-3 w-3 text-phx-ink-faint" />
                  {/* The name and title were stamped when the note was WRITTEN, never joined on
                      render: HR_IDs are reused when a seat is refilled, so a late join would
                      eventually put one recruiter's words in their successor's mouth. */}
                  {note.authorName ?? "Unnamed author"}
                  {note.authorJobTitle ? (
                    <span className="font-normal text-phx-ink-soft">{note.authorJobTitle}</span>
                  ) : null}
                  <span className="ml-auto font-normal text-phx-ink-faint">{cairoStamp(note.createdAt)}</span>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-phx-ink">
                  {note.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
