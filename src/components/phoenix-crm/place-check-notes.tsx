"use client";

/**
 * Phoenix CRM — the comment and the recommendation written on one place check.
 *
 * Owner, 13 October 2026: a district manager reads his own team's Place checks and can comment on a
 * row; when he comments he chooses whether the rep sees it; and he can recommend validating it or not
 * validating it.
 *
 * He described the control himself, and this is it exactly: ONE `Comment` button, and pressing it
 * opens the box with TWO buttons under it — `Visible to medical rep` and `Not visible to medical rep`.
 * Either one saves. There is no pre-chosen side and no third "Save": a comment cannot be written
 * without saying which it is, so a note typed in a hurry can never reach the field by default.
 *
 * 🔴 NOTHING ON THIS COMPONENT SAYS WHO DECIDES. The decision is the Super Admin's alone, and the
 * owner's instruction the same day was "don't show this on the screen" — so there is no "recommendation
 * only", no "waiting for approval", no "sent to the administrator", and no name or role of anybody
 * above the reader anywhere in `mode="team"`. The two buttons carry his own words for them.
 *
 * It renders on BOTH boards. The Super Admin's board draws it beside the decision controls he already
 * has, so he reads what the manager wrote and recommended, and can write a comment of his own; the
 * manager's board draws it in place of those controls, which are simply not rendered for him.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CrmButton, CrmNote, CrmPill, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import {
  placeRecommendationLabel,
  placeRecommendationMadeLabel,
  PLACE_NOTE_MAX_LENGTH,
  type PlaceCheckIntegrityView,
  type PlaceNoteSubjectKind,
  type PlaceRecommendation,
} from "@/lib/phoenix-crm/place-note-rules";
import type { PlaceNoteView, PlaceRecommendationView } from "@/lib/phoenix-crm/view-types";

/** Which board this is drawn on — see the header for what each one renders. */
export type PlaceCheckNotesMode = "team" | "company";

export function PlaceCheckNotes({
  integrity,
  mode,
  notes,
  recommendations,
  subjectId,
  subjectKind,
}: {
  integrity: PlaceCheckIntegrityView[];
  mode: PlaceCheckNotesMode;
  notes: PlaceNoteView[];
  recommendations: PlaceRecommendationView[];
  subjectId: string;
  subjectKind: PlaceNoteSubjectKind;
}) {
  return (
    <div className="min-w-0 space-y-2 border-t border-slate-100 pt-2">
      <Evidence cases={integrity} />
      <Recommendations mode={mode} recommendations={recommendations} subjectId={subjectId} subjectKind={subjectKind} />
      <Notes notes={notes} />
      <CommentBox subjectId={subjectId} subjectKind={subjectKind} />
    </div>
  );
}

/**
 * The device evidence the system holds on this place — the same cases the integrity board reads.
 *
 * 🔴 IT IS DRAWN IN BOTH MODES, WITH NO `mode` BRANCH AT ALL, by the owner's own word on 2026-10-13:
 * "system and device evidence the dm can see". A branch here would be a second statement of who may
 * read it, and the audience is already decided once, on the server, by `placeChecksSeatScope` — a
 * manager who may not read this board never gets a case in his index to draw.
 *
 * 🔴 AND IT FORMATS NOTHING. Every sentence arrives already in words from the server, because this
 * file sits in the rep's own bundle directory and a silent word in a literal here is exactly what
 * `tests/phoenix-crm-blind-half.test.ts` refuses. The words live beside the evidence, where the
 * audience is checked.
 *
 * It is a reason to look, never a verdict: it says what the system noticed and whether the Super Admin
 * has already closed it, it accuses nobody, and the REP has no screen that reaches any of it.
 */
function Evidence({ cases }: { cases: PlaceCheckIntegrityView[] }) {
  if (cases.length === 0) return null;
  return (
    <ul className="min-w-0 space-y-2">
      {cases.map((row) => (
        <li key={row.caseId} className="min-w-0 border-l-2 border-amber-300 pl-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <CrmPill tone={row.settledText ? "neutral" : row.strong ? "bad" : "warn"}>{row.sourceLabel}</CrmPill>
            {row.deviceText ? <CrmPill tone="bad">{row.deviceText}</CrmPill> : null}
          </div>
          {row.reasons.map((reason) => (
            <p key={reason} className="break-words text-sm text-slate-800">
              {reason}
            </p>
          ))}
          <p className="mt-0.5 break-words text-xs text-slate-500">{row.noticedText}</p>
          {row.settledText ? <p className="break-words text-xs font-semibold text-slate-600">{row.settledText}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The recommendation. On a manager's board it is the two buttons; on the Super Admin's it is what the
 * managers have said, read-only — he has his own Approve and Reject above.
 */
function Recommendations({
  mode,
  recommendations,
  subjectId,
  subjectKind,
}: {
  mode: PlaceCheckNotesMode;
  recommendations: PlaceRecommendationView[];
  subjectId: string;
  subjectKind: PlaceNoteSubjectKind;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState<PlaceRecommendation | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // On a manager's own board every row here is his own, because the board shows his team alone — so
  // the first one is "what I said last", and it highlights the button he pressed.
  const mine = recommendations[0] ?? null;

  async function recommend(recommendation: PlaceRecommendation) {
    if (saving) return;
    setSaving(recommendation);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/place-notes/recommendation", { recommendation, subjectId, subjectKind }, "recommended");
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(null);
    }
  }

  if (mode === "company") {
    if (recommendations.length === 0) return null;
    return (
      <div className="min-w-0 space-y-1">
        {recommendations.map((row) => (
          <p key={`${row.managerName}-${row.decidedAtText}`} className="break-words text-xs text-slate-600">
            <span className="font-black text-slate-800">{row.managerName}</span> {placeRecommendationMadeLabel(row.recommendation).toLowerCase()} ·{" "}
            {row.decidedAtText}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
        <CrmButton
          busy={saving === "validate"}
          disabled={saving !== null}
          onClick={() => void recommend("validate")}
          variant={mine?.recommendation === "validate" ? "success" : "secondary"}
        >
          {placeRecommendationLabel("validate")}
        </CrmButton>
        <CrmButton
          busy={saving === "reject"}
          disabled={saving !== null}
          onClick={() => void recommend("reject")}
          variant={mine?.recommendation === "reject" ? "danger" : "secondary"}
        >
          {placeRecommendationLabel("reject")}
        </CrmButton>
      </div>
      {mine ? <p className="break-words text-xs text-slate-500">{placeRecommendationMadeLabel(mine.recommendation)} · {mine.decidedAtText}</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * The comments already written on this row, newest first.
 *
 * Every one says whether the rep can read it, on both boards — a writer who cannot see which of his
 * own comments the field has read would have no way to tell them apart afterwards, and that is the one
 * thing about a comment that cannot be undone.
 */
function Notes({ notes }: { notes: PlaceNoteView[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="min-w-0 space-y-2">
      {notes.map((note) => (
        <li key={note.noteId} className="min-w-0 border-l-2 border-slate-200 pl-2">
          <p className="break-words text-sm text-slate-800" dir="auto">
            {note.body}
          </p>
          <p className="mt-0.5 break-words text-xs text-slate-500">
            {note.authorLabel} · {note.writtenAtText}
          </p>
          <CrmPill tone={note.repVisible ? "warn" : "neutral"}>{note.repVisible ? "The rep can read this" : "Not shown to the rep"}</CrmPill>
        </li>
      ))}
    </ul>
  );
}

/** The `Comment` button, and the two buttons that are the only way to save what it opens. */
function CommentBox({ subjectId, subjectKind }: { subjectId: string; subjectKind: PlaceNoteSubjectKind }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState<"visible" | "hidden" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const fieldId = `place-note-${subjectKind}-${subjectId}`;

  async function save(repVisible: boolean) {
    if (saving) return;
    setSaving(repVisible ? "visible" : "hidden");
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/place-notes", { body, repVisible, subjectId, subjectKind }, "note");
      setBody("");
      setOpen(false);
      setSaving(null);
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(null);
    }
  }

  if (!open) {
    return (
      <CrmButton onClick={() => setOpen(true)} size="sm">
        Comment
      </CrmButton>
    );
  }

  const empty = body.trim().length === 0;
  return (
    <div className="min-w-0 space-y-2">
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={fieldId}>
        Comment
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving !== null}
        id={fieldId}
        maxLength={PLACE_NOTE_MAX_LENGTH}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        value={body}
      />
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
        <CrmButton busy={saving === "visible"} disabled={saving !== null || empty} onClick={() => void save(true)} variant="primary">
          Visible to medical rep
        </CrmButton>
        <CrmButton busy={saving === "hidden"} disabled={saving !== null || empty} onClick={() => void save(false)} variant="secondary">
          Not visible to medical rep
        </CrmButton>
      </div>
      <CrmButton disabled={saving !== null} onClick={() => setOpen(false)} size="sm" variant="ghost">
        Cancel
      </CrmButton>
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}
