"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { personLabel, UNNAMED_AUTHOR_LABEL } from "@/lib/recruitment/person-labels";
import { CANDIDATE_COMMENT_MAX_LENGTH, type CandidateComment } from "@/lib/recruitment/types";
import { phxTextareaClassName } from "@/components/ui/form-tokens";

/**
 * What the managers above a CV have said about it.
 *
 * The owner, 2026-08-30, asking for a National Sales Manager to be able to read the CVs sitting with
 * his district managers: *"and can also give a comment on him. On the CV itself, I mean."*
 *
 * Shown on the manager's OWN cards too, not only on the team view. A comment from the NSM is written
 * for the district manager holding the CV, so the one place it must appear is the card that manager
 * actually opens — a thread only its author can find is a thread nobody reads.
 *
 * Loaded on demand rather than server-rendered with the card. Most CVs have no comments at all, and
 * the alternative is one extra query per candidate on a page that already renders every CV a manager
 * holds.
 */
export function CandidateCommentThread({
  candidateId,
  composerActions,
  viewerHrId,
}: {
  candidateId: string;
  /**
   * The card's own answer buttons, rendered BESIDE Add comment and sharing this one text box.
   *
   * ONE FIELD, NOT TWO. The owner, 2026-09-09: *"I have two fields for your answer and your comments
   * — merge them into one field, no need two fields."* There is only one thing to type on a CV,
   * which is what he found. So the answer buttons come DOWN here to
   * the comment box rather than the box being duplicated above them, and Skip sends whatever is in
   * it as its required reason.
   *
   * It receives the live draft and a way to clear it, because the button that consumes the text is
   * not the one that owns it.
   */
  composerActions?: (draft: string, clearDraft: () => void) => ReactNode;
  /** Used only to decide whose comments offer a Delete — the server re-checks it on every delete. */
  viewerHrId: string | null;
}) {
  const [comments, setComments] = useState<CandidateComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/recruitment/hiring-manager/candidates/${candidateId}/comments`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(base);
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (cancelled) return;
        // A failure here leaves the thread empty rather than breaking the card. The CV and the
        // manager's own answer are the point of the screen; comments are an addition to it.
        setComments(res.ok && Array.isArray(data.comments) ? (data.comments as CandidateComment[]) : []);
      } catch {
        if (!cancelled) setComments([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  const post = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(base, {
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to save your comment.");
      setComments((prev) => [data.comment as CandidateComment, ...(prev ?? [])]);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save your comment.");
    } finally {
      setBusy(false);
    }
  };

  const retract = async (comment: CandidateComment) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/${comment.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(typeof data.message === "string" ? data.message : "Failed to delete that comment.");
      }
      setComments((prev) => (prev ?? []).filter((row) => row.id !== comment.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to delete that comment.");
    } finally {
      setBusy(false);
    }
  };

  const mine = (comment: CandidateComment) =>
    Boolean(viewerHrId) &&
    String(comment.authorHrId ?? "").trim().toLowerCase() === String(viewerHrId).trim().toLowerCase();

  return (
    <div className="space-y-3 border-t border-slate-100 pt-3">
      <p className="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-slate-500">
        {composerActions ? "Your feedback" : "Comments"}
      </p>

      {comments === null ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-slate-400">No comments yet.</p>
      ) : (
        <ul className="space-y-2">
          {comments.map((comment) => (
            <li className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2" key={comment.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                {/* The name AS AT the moment of writing, never re-resolved — HR_IDs are reused when a
                    seat is refilled, so a join here would eventually credit a successor.
                    When no name was snapshotted, this said the HR_ID. That kept the important
                    property — never claiming "System" said it, which would be a claim about who
                    spoke — but paid for it with a raw code, which the owner's rule forbids and which
                    no reader can act on anyway. "Unnamed author" keeps the property and drops the
                    code: it is the same wording the workstation's history strip already uses for an
                    unattributed note. */}
                <span className="whitespace-nowrap text-xs font-semibold text-slate-700">
                  {personLabel(comment.authorName, UNNAMED_AUTHOR_LABEL)}
                  {comment.authorJobTitle ? ` · ${comment.authorJobTitle}` : ""}
                </span>
                <span className="whitespace-nowrap text-phx-xs text-slate-400">{cairoDateTime(comment.createdAt)}</span>
              </div>
              {/* dir="auto" per line: this is single-language free text, which is the case where
                  block-level auto is correct and is already house style here. */}
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700" dir="auto">
                {comment.body}
              </p>
              {mine(comment) ? (
                <button
                  className="mt-1 whitespace-nowrap text-phx-xs font-semibold text-rose-600 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void retract(comment)}
                  type="button"
                >
                  Delete
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {error ? <p className="text-xs text-rose-600">{error}</p> : null}

      <div className="space-y-2">
        <textarea
          className={phxTextareaClassName}
          dir="auto"
          maxLength={CANDIDATE_COMMENT_MAX_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={composerActions ? "What did you find? Say whether you called them." : "Add a comment on this CV"}
          rows={2}
          value={draft}
        />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !draft.trim()} onClick={() => void post()} size="sm" variant="outline">
            Add comment
          </Button>
          {composerActions?.(draft, () => setDraft(""))}
        </div>
      </div>
    </div>
  );
}
