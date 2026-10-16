"use client";

import { useState } from "react";

import { crmPost, crmUrl, useCrmAction, useCrmGet } from "@/components/phoenix-crm/api";
import { cairoStamp } from "@/components/phoenix-crm/format";
import {
  CrmButton,
  CrmChoice,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  crmInputClassName,
  crmTextareaClassName,
} from "@/components/phoenix-crm/ui";
import { PHARMACY_NAME_MAX, type ProductAvailability } from "@/lib/phoenix-crm/entry-rules";
import { SAMPLE_MATERIALS, type SamplesGiven } from "@/lib/phoenix-crm/samples";
import {
  VISIT_DETAIL_COMMENT_MAX,
  VISIT_DETAIL_EDIT_AGAIN,
  VISIT_DETAIL_EDIT_PROMPT,
  visitDetailEditedLine,
} from "@/lib/phoenix-crm/visit-detail-edit-rules";
import {
  isFollowUp,
  isVisitNextStep,
  isVisitObjection,
  OBJECTION_NOTE_MAX,
  VISIT_NEXT_STEPS,
  VISIT_OBJECTIONS,
  type VisitNextStep,
  type VisitObjection,
} from "@/lib/phoenix-crm/visit-outcome";
import type { SavedVisitDetail, VisitDetailForm } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — the REP comes back to his own saved visit and writes up its detail.
 *
 * Owner, 2026-10-15: *"they're working from doctor to doctor and they may not have suitable time to do
 * the full report needed by the company in between the visits … I want them to be able to log as fast
 * as it could be. The most important thing for me is capture location while they log the visit and the
 * time … they can go to the visit, press on it, have those things editable and another is non-editable.
 * But anything edited, it should appear that this is edited in the date and time."*
 *
 * So logging stays one tap, and everything soft is written here afterwards — AT ANY TIME, which is his
 * own answer when asked: there is no deadline and this panel reads no day.
 *
 * 🔴 WHAT IT DOES NOT OFFER IS THE POINT. The customer, the day, the time, the location, the photo and
 * the voice note are the evidence every figure reads. AM/PM comes from the customer's own list.
 * Single/double/chain, who was on it and the products discussed are the Super Admin's to correct
 * (`visit-edit-panel.tsx`) — he named those three himself. And the comment he wrote at the door is read
 * back above the box, unchanged and not editable: *"leave it and make them able to add another detailed
 * comment."*
 *
 * 🔴 THE DETAILED COMMENT IS TYPED, NOT SPOKEN — deliberately. `CrmSpeak` does two things at once: it
 * writes the words AND keeps the recording as the visit's voice note, and the voice note is frozen
 * evidence here. A second recorder on this panel would either overwrite that or upload audio nothing
 * ever points at. The door's own comment keeps its dictation, which is where the speed matters.
 *
 * The pharmacy name is ADD-ONLY (his answer, asked directly): a name files a real visit to that
 * pharmacy, so changing one would delete a logged visit. The server says so in a sentence rather than
 * dropping the field, and this panel reads that sentence back.
 */

/** One product's shelf answer, the same two-chip row the visit form uses. */
function StockRow({
  answer,
  disabled,
  onSet,
  product,
}: {
  answer: ProductAvailability | undefined;
  disabled: boolean;
  onSet: (product: string, answer: ProductAvailability) => void;
  product: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border border-slate-200 bg-white px-3 py-2">
      <span className="min-w-0 flex-1 break-words text-sm font-black text-slate-700">{product}</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <button
          aria-pressed={answer === "has"}
          className={cn(
            "min-h-11 min-w-0 break-words rounded-none border px-3 py-1 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
            answer === "has" ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-emerald-300",
          )}
          disabled={disabled}
          onClick={() => onSet(product, "has")}
          type="button"
        >
          Has
        </button>
        <button
          aria-pressed={answer === "missing"}
          className={cn(
            "min-h-11 min-w-0 break-words rounded-none border px-3 py-1 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
            answer === "missing" ? "border-rose-600 bg-rose-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-rose-300",
          )}
          disabled={disabled}
          onClick={() => onSet(product, "missing")}
          type="button"
        >
          Doesn&apos;t have
        </button>
      </div>
    </div>
  );
}

function DetailForm({
  form,
  isTest,
  onCancel,
  onSaved,
  seatId,
}: {
  form: VisitDetailForm;
  isTest: boolean;
  onCancel: () => void;
  onSaved: (saved: SavedVisitDetail) => void;
  seatId: string;
}) {
  const action = useCrmAction();
  const [detailComment, setDetailComment] = useState(form.detailComment);
  // Read through the guards, never cast: a value the build in his hand does not know is simply
  // unanswered on the screen, the same drop-never-refuse rule the save follows.
  const [objection, setObjection] = useState<VisitObjection | null>(isVisitObjection(form.objection) ? form.objection : null);
  const [objectionNote, setObjectionNote] = useState(form.objectionNote ?? "");
  const [nextStep, setNextStep] = useState<VisitNextStep | null>(isVisitNextStep(form.nextStep) ? form.nextStep : null);
  const [nextStepOn, setNextStepOn] = useState(form.nextStepOn ?? "");
  const [samples, setSamples] = useState<SamplesGiven>(form.samples);
  const [availability, setAvailability] = useState<Record<string, ProductAvailability>>(form.availability);
  const [pharmacyName, setPharmacyName] = useState("");
  const busy = action.busy !== null;
  const commentLength = detailComment.trim().length;
  const tooLong = commentLength > VISIT_DETAIL_COMMENT_MAX;

  // Every product of his line, in family order — the samples grid names materials too.
  const lineProducts = form.productFamilies.flatMap((family) => family.products);
  const leftItems = [...lineProducts.map((product) => ({ key: product, label: product })), ...SAMPLE_MATERIALS];

  function setStock(product: string, answer: ProductAvailability) {
    setAvailability((current) => ({ ...current, [product]: answer }));
  }

  /** One tap adds one; past the cap it goes back to none, so a mistake costs one tap, not a reload. */
  function bumpSample(key: string) {
    setSamples((current) => {
      const next = { ...current };
      const count = (next[key] ?? 0) + 1;
      if (count > 99) delete next[key];
      else next[key] = count;
      return next;
    });
  }

  async function save() {
    const saved = await action.run("save", () =>
      crmPost<SavedVisitDetail>(
        "/api/phoenix-crm/visit-detail",
        {
          seatId,
          test: isTest,
          visitId: form.visitId,
          detailComment,
          objection,
          objectionNote: objection && objection !== "none" ? objectionNote.trim() || null : null,
          nextStep,
          nextStepOn: nextStep && nextStep !== "none" ? nextStepOn || null : null,
          samplesGiven: samples,
          productAvailability: availability,
          pharmacyName: form.pharmacyAddable ? pharmacyName.trim() || null : null,
        },
        "saved",
      ),
    );
    if (saved === undefined) return;
    onSaved(saved);
  }

  return (
    <div className="grid w-full min-w-0 gap-4 border border-slate-200 bg-slate-50/60 p-3">
      <p className="break-words text-xs font-semibold leading-5 text-slate-600">
        {`Write up your visit to ${form.customerName}. The time, the place, who was on it and the products stay as you logged them.`}
      </p>

      {form.doorComment ? (
        <div className="min-w-0 border border-slate-200 bg-white px-3 py-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">What you wrote at the door</p>
          <p className="mt-1 whitespace-pre-line break-words text-sm font-semibold text-slate-700" dir="auto">
            {form.doorComment}
          </p>
        </div>
      ) : null}

      <CrmField
        error={tooLong ? `Keep the detailed comment under ${VISIT_DETAIL_COMMENT_MAX} characters.` : null}
        hint={`Optional · ${commentLength} of ${VISIT_DETAIL_COMMENT_MAX} characters`}
        htmlFor={`phoenix-crm-visit-detail-comment-${form.visitId}`}
        label="The visit in full"
      >
        <textarea
          className={crmTextareaClassName}
          dir="auto"
          disabled={busy}
          id={`phoenix-crm-visit-detail-comment-${form.visitId}`}
          onChange={(event) => setDetailComment(event.target.value)}
          rows={6}
          value={detailComment}
        />
      </CrmField>

      <div className="grid min-w-0 gap-2">
        <p className="break-words text-sm font-black text-slate-800">Did the customer push back on anything?</p>
        <CrmChoice<VisitObjection>
          label="What the customer pushed back on"
          onChange={(next) => {
            setObjection(next);
            if (next === "none") setObjectionNote("");
          }}
          options={VISIT_OBJECTIONS.map((entry) => ({ value: entry.key, label: entry.label, disabled: busy }))}
          value={objection}
        />
        {objection && objection !== "none" ? (
          <CrmField
            hint={`Optional · ${objectionNote.trim().length} of ${OBJECTION_NOTE_MAX} characters`}
            htmlFor={`phoenix-crm-visit-detail-objection-${form.visitId}`}
            label="In the customer's own words"
          >
            <input
              className={crmInputClassName}
              dir="auto"
              disabled={busy}
              id={`phoenix-crm-visit-detail-objection-${form.visitId}`}
              maxLength={OBJECTION_NOTE_MAX}
              onChange={(event) => setObjectionNote(event.target.value)}
              value={objectionNote}
            />
          </CrmField>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-2">
        <p className="break-words text-sm font-black text-slate-800">What will you do next?</p>
        <CrmChoice<VisitNextStep>
          label="What you will do next"
          onChange={(next) => {
            setNextStep(next);
            if (next === "none") setNextStepOn("");
          }}
          options={VISIT_NEXT_STEPS.map((entry) => ({ value: entry.key, label: entry.label, disabled: busy }))}
          value={nextStep}
        />
        {/* 🔴 THE DAY IS ASKED HERE AND NOWHERE ELSE. The door form always sends `null`, so every live
            next step sits in the commitments panel's "no day" bucket. He has time at this screen; at a
            door he does not, so the one-tap form is not growing a date picker. */}
        {nextStep && nextStep !== "none" ? (
          <CrmField
            hint="Optional · the day you mean to do it"
            htmlFor={`phoenix-crm-visit-detail-next-on-${form.visitId}`}
            label="By when"
          >
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={busy}
              id={`phoenix-crm-visit-detail-next-on-${form.visitId}`}
              onChange={(event) => setNextStepOn(event.target.value)}
              type="date"
              value={nextStepOn}
            />
          </CrmField>
        ) : null}
        {isFollowUp(nextStep) ? <p className="text-xs font-semibold text-slate-500">It comes back to you at this customer&apos;s door next time.</p> : null}
      </div>

      <div className="grid min-w-0 gap-2">
        <p className="break-words text-sm font-black text-slate-800">What you left</p>
        <p className="break-words text-xs font-semibold text-slate-500">Tap once for each one you left.</p>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {leftItems.map((item) => {
            const count = samples[item.key] ?? 0;
            return (
              <button
                aria-label={`${item.label}: ${count}`}
                className={cn(
                  "flex min-h-11 min-w-0 items-center justify-between gap-2 rounded-none border px-3 py-2 text-left text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
                  count > 0 ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                )}
                disabled={busy}
                key={item.key}
                onClick={() => bumpSample(item.key)}
                type="button"
              >
                <span className="min-w-0 break-words">{item.label}</span>
                {count > 0 ? <span className="shrink-0 text-xs font-black">× {count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid min-w-0 gap-2">
        <p className="break-words text-sm font-black text-slate-800">The pharmacy</p>
        {form.pharmacyName ? (
          <p className="break-words text-xs font-semibold leading-5 text-slate-600" dir="auto">
            {form.pharmacyName}
          </p>
        ) : null}
        {form.pharmacyAddable ? (
          <CrmField
            hint="Optional · one box can name several, separated by a comma"
            htmlFor={`phoenix-crm-visit-detail-pharmacy-${form.visitId}`}
            label="A pharmacy you took feedback from"
          >
            <input
              className={crmInputClassName}
              dir="auto"
              disabled={busy}
              id={`phoenix-crm-visit-detail-pharmacy-${form.visitId}`}
              list={`phoenix-crm-detail-pharmacies-${form.visitId}`}
              maxLength={PHARMACY_NAME_MAX}
              onChange={(event) => setPharmacyName(event.target.value)}
              value={pharmacyName}
            />
          </CrmField>
        ) : (
          <CrmNote tone="info">{form.pharmacyBlockedReason}</CrmNote>
        )}
        {form.pharmacies.length > 0 ? (
          <datalist id={`phoenix-crm-detail-pharmacies-${form.visitId}`}>
            {form.pharmacies.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        ) : null}
        <p className="break-words text-sm font-black text-slate-800">Does this pharmacy have these products?</p>
        <p className="break-words text-xs font-semibold text-slate-500">Answer the ones you checked — leave the rest blank.</p>
        <div className="grid min-w-0 gap-1.5">
          {lineProducts.map((product) => (
            <StockRow answer={availability[product]} disabled={busy} key={product} onSet={setStock} product={product} />
          ))}
        </div>
      </div>

      {action.error ? (
        <CrmNote title="Not saved" tone="bad">
          {action.error}
        </CrmNote>
      ) : null}
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <CrmButton busy={busy} disabled={tooLong} onClick={() => void save()} variant="primary">
          Save the detail
        </CrmButton>
        <CrmButton disabled={busy} onClick={onCancel}>
          Cancel
        </CrmButton>
      </div>
    </div>
  );
}

/**
 * The press on his own visit, and the panel it opens.
 *
 * The form is READ ON OPEN, so it starts from the visit as it stands — a rep who wrote the detail up on
 * one phone and opens it on another is editing what is there, never overwriting it with a stale copy.
 */
export function VisitDetailEdit({
  hasDetail,
  isTest,
  onWrittenUp,
  seatId,
  visitId,
}: {
  hasDetail: boolean;
  isTest: boolean;
  /** Re-reads the day the visit sits in, so its card reads as written up. */
  onWrittenUp: () => void;
  seatId: string;
  visitId: string;
}) {
  const [opened, setOpened] = useState(false);
  const [saved, setSaved] = useState<SavedVisitDetail | null>(null);
  const form = useCrmGet<VisitDetailForm>(opened ? crmUrl("/api/phoenix-crm/visit-detail", { seatId, test: isTest, visitId }) : null, "form");

  if (!opened) {
    return (
      <div className="grid min-w-0 gap-2">
        {saved ? (
          <CrmNote tone="good">
            <span className="block">{saved.changed ? "Saved." : "Nothing was different, so nothing was changed."}</span>
            {saved.pharmacyNote ? (
              <span className="mt-1 block break-words" dir="auto">
                {saved.pharmacyNote}
              </span>
            ) : null}
          </CrmNote>
        ) : null}
        <div>
          <CrmButton
            onClick={() => {
              setSaved(null);
              setOpened(true);
            }}
            size="sm"
          >
            {hasDetail ? VISIT_DETAIL_EDIT_AGAIN : VISIT_DETAIL_EDIT_PROMPT}
          </CrmButton>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0">
      {form.error ? <CrmLoadError message={form.error} onRetry={form.reload} /> : null}
      {!form.data && !form.error ? <CrmLoading label="Reading the visit" /> : null}
      {form.data && !form.data.editable ? <CrmNote tone="info">{form.data.blockedReason}</CrmNote> : null}
      {form.data && form.data.editable ? (
        <DetailForm
          form={form.data}
          isTest={isTest}
          key={form.data.visitId}
          onCancel={() => setOpened(false)}
          onSaved={(result) => {
            setSaved(result);
            setOpened(false);
            // The day above is the Visits tab's own read, held in the browser, so `router.refresh()` never
            // reached it: it re-rendered the whole page on the server and left the card as it was. Re-read
            // that day instead, so the visit reads as written up (performance audit, 2026-10-16).
            onWrittenUp();
          }}
          seatId={seatId}
        />
      ) : null}
    </div>
  );
}

/** The detailed comment and the "Edited · <Cairo date and time>" marker, for a card or a table cell. */
export function visitDetailEditedText(editedAt: string | null): string | null {
  return visitDetailEditedLine(editedAt, cairoStamp);
}
