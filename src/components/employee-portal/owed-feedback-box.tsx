"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CANDIDATE_COMMENT_MAX_LENGTH } from "@/lib/recruitment/types";

/**
 * The feedback lock's message, WITH the box that clears it.
 *
 * MEASURED ON PRODUCTION, 2026-09-13. Eleven people were locked, and ten of them owed feedback on a
 * CV that had never been sent to them: they opened it from an area folder or a team manager's list.
 * The only way out was "Go to that CV →", an in-page `#candidate-` anchor, and those cards exist in
 * the page only while their folder or manager chip is open, so the link scrolled nowhere. And a CV
 * that has since left the manager's folder has no card anywhere, so a search found nothing either.
 * Samaa Shalabi reported exactly that about Ahmed Abdelgwad, and the others said the same.
 *
 * So the feedback is written HERE, inside the block, for the candidate the block names. The rule is
 * unchanged: he still cannot open another CV until he writes what he found. What changed is that
 * writing it no longer depends on finding a card that may not be on the screen.
 *
 * The anchor stays beside the box for when the card IS on the page, since re-reading the CV before
 * writing about it is still the better order.
 */
export function OwedFeedbackBox({
  candidateId,
  message,
  onFeedbackGiven,
  onLinkFollowed,
}: {
  candidateId: string;
  message: string;
  /**
   * Lifts the block in place. Without it the page is RELOADED, because the lock is read on the
   * server with the page and every other card on it is still holding the old answer.
   */
  onFeedbackGiven?: (candidateId: string) => void;
  onLinkFollowed?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const body = draft.trim();
    if (!body || !candidateId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/hiring-manager/candidates/${candidateId}/comments`, {
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to save your feedback.");
      setDraft("");
      if (onFeedbackGiven) onFeedbackGiven(candidateId);
      else window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save your feedback.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <p className="font-semibold">{message}</p>
      {candidateId ? (
        <>
          <textarea
            className="w-full border border-amber-300 bg-white px-3 py-2 text-sm text-slate-800"
            dir="auto"
            maxLength={CANDIDATE_COMMENT_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write your feedback here: what did you find, and did you call them?"
            rows={2}
            value={draft}
          />
          {error ? <p className="text-rose-700">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy || !draft.trim()} onClick={() => void save()} size="sm">
              {busy ? "Saving…" : "Save feedback"}
            </Button>
            <a
              className="font-semibold text-amber-900 underline underline-offset-2"
              href={`#candidate-${candidateId}`}
              onClick={onLinkFollowed}
            >
              Go to that CV →
            </a>
          </div>
        </>
      ) : null}
    </div>
  );
}
