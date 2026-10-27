"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { crmPost, crmUrl, useCrmAction, useCrmGet } from "@/components/phoenix-crm/api";
import { CompanyPicker } from "@/components/phoenix-crm/visit-company-picker";
import { CrmButton, CrmCheck, CrmChoice, CrmField, CrmLoadError, CrmLoading, CrmNote, CrmSaveError, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { VISIT_COMMENT_MAX, VISIT_PRODUCTS_MAX } from "@/lib/phoenix-crm/entry-rules";
import { COMPANY_MOST, companyToStorage, type VisitCompanyChoice } from "@/lib/phoenix-crm/visit-company";
import type { SavedVisitEdit, VisitEditForm } from "@/lib/phoenix-crm/view-types";

/**
 * Phoenix CRM — the Super Admin corrects a visit a rep submitted, on that visit's own card on the day page.
 *
 * Owner, 2026-10-06: "make the admin able to edit a visit submitted by an employee. Example, if he chooses
 * a wrong double visit, make me able to enter and edit it."
 *
 * What it changes is only what a rep's own tap or typing decides and can get wrong: WHO WAS ON THE VISIT,
 * the PRODUCTS, the COMMENT. The customer, the day, the time, the location and the voice note are not on
 * it, by design (visit-edit-rules.ts). Who was on the visit uses the very same list the rep's own form
 * offers, one person for a double and two for a chain (visit-company-picker.tsx), and is left alone unless
 * he opens it — so a comment can be corrected without re-checking anybody.
 *
 * The rep is told nothing (Golden Rule #1) and the database keeps what the visit said before, which is the
 * sentence on the saved note. The server decided who may see this button (`editsVisits`) and asserts the
 * same gate again on every read and every save; nothing here decides who may correct.
 */

function EditForm({
  form,
  isTest,
  onCancel,
  onSaved,
  seatId,
}: {
  form: VisitEditForm;
  isTest: boolean;
  onCancel: () => void;
  onSaved: (saved: SavedVisitEdit) => void;
  seatId: string;
}) {
  const action = useCrmAction();
  const [changeWho, setChangeWho] = useState(false);
  const [choice, setChoice] = useState<VisitCompanyChoice>(form.current.choice);
  const [picked, setPicked] = useState<string[]>(form.current.picked);
  const [products, setProducts] = useState<string[]>(form.chosenProducts);
  const [comment, setComment] = useState(form.comment);
  const busy = action.busy !== null;

  const managers = form.people.filter((person) => person.role === "manager");
  const company = changeWho ? companyToStorage({ choice, offers: form.people, picked }) : null;
  const commentLength = comment.trim().length;
  const ready = products.length > 0 && commentLength > 0 && commentLength <= VISIT_COMMENT_MAX && (company === null || company.ok);

  function toggleProduct(product: string, on: boolean) {
    setProducts((current) => (on ? (current.includes(product) ? current : [...current, product]) : current.filter((entry) => entry !== product)));
  }

  async function save() {
    const body = {
      seatId,
      test: isTest,
      visitId: form.visitId,
      who: changeWho ? { choice, picked } : null,
      products,
      comment,
    };
    await action.run(
      "save",
      () => crmPost<SavedVisitEdit>("/api/phoenix-crm/visit-edit", body, "saved"),
      (saved) => onSaved(saved),
    );
  }

  return (
    <div className="grid w-full min-w-0 gap-4 border border-slate-200 bg-slate-50/60 p-3">
      <p className="break-words text-xs font-semibold leading-5 text-slate-600">
        {`Correct what was recorded on the visit to ${form.customerName}. The customer, the day, the time and the location stay as they were. The rep is not told, and a copy of what it said before is kept.`}
      </p>

      <div className="grid min-w-0 gap-2">
        <p className="break-words text-sm font-black text-slate-900">Who was on the visit</p>
        <p className="break-words text-xs font-semibold leading-5 text-slate-600" dir="auto">
          {form.onTheVisit.map((person) => (person.title ? `${person.name} (${person.title})` : person.name)).join(", ") || "No one is recorded."}
        </p>
        {!form.whoEditable ? (
          <CrmNote tone="info">{form.whoBlockedReason}</CrmNote>
        ) : !changeWho ? (
          <div>
            <CrmButton disabled={busy} onClick={() => setChangeWho(true)} size="sm">
              Change who was on the visit
            </CrmButton>
          </div>
        ) : (
          <div className="grid min-w-0 gap-3">
            <CrmChoice<VisitCompanyChoice>
              columns={3}
              label="Who was on the visit"
              onChange={(next) => {
                setChoice(next);
                // Fewer places than he had ticked: keep the first ones, so changing his mind costs no re-tap.
                setPicked((current) => current.slice(0, COMPANY_MOST[next]));
              }}
              options={[
                { value: "single", label: "Single visit", note: "On their own" },
                {
                  value: "double",
                  label: "Double visit",
                  note: form.people.length > 0 ? "With one person from the list" : "No one is offered for this territory",
                  disabled: form.people.length === 0 || busy,
                },
                {
                  value: "chain",
                  label: "Chain visit",
                  note: managers.length > 0 && form.people.length > 1 ? "With two people from the list" : "Needs a manager and one more person",
                  disabled: managers.length === 0 || form.people.length < 2 || busy,
                },
              ]}
              value={choice}
            />
            {choice === "double" || choice === "chain" ? (
              <CompanyPicker choice={choice} disabled={busy} onChange={setPicked} people={form.people} picked={picked} />
            ) : null}
            {company && !company.ok ? <p className="text-xs font-semibold text-rose-700">{company.error}</p> : null}
            <div>
              <CrmButton
                disabled={busy}
                onClick={() => {
                  setChangeWho(false);
                  setChoice(form.current.choice);
                  setPicked(form.current.picked);
                }}
                size="sm"
              >
                Keep who was on the visit as recorded
              </CrmButton>
            </div>
          </div>
        )}
      </div>

      <CrmField hint={`${products.length} chosen · at most ${VISIT_PRODUCTS_MAX}`} label="Products discussed">
        <div className="grid min-w-0 gap-1.5 sm:grid-cols-2">
          {form.products.map((product) => (
            <CrmCheck
              checked={products.includes(product)}
              disabled={busy || (!products.includes(product) && products.length >= VISIT_PRODUCTS_MAX)}
              key={product}
              onChange={(on) => toggleProduct(product, on)}
            >
              {product}
            </CrmCheck>
          ))}
        </div>
      </CrmField>

      <CrmField
        error={commentLength > VISIT_COMMENT_MAX ? `Keep the comment under ${VISIT_COMMENT_MAX} characters.` : null}
        hint={`Required · ${commentLength} of ${VISIT_COMMENT_MAX} characters`}
        htmlFor={`phoenix-crm-visit-edit-comment-${form.visitId}`}
        label="What happened on the visit"
      >
        <textarea
          className={crmTextareaClassName}
          dir="auto"
          disabled={busy}
          id={`phoenix-crm-visit-edit-comment-${form.visitId}`}
          onChange={(event) => setComment(event.target.value)}
          rows={4}
          value={comment}
        />
      </CrmField>

      {action.error ? <CrmSaveError message={action.error} onRetry={action.retry} /> : null}
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <CrmButton busy={busy} disabled={!ready} onClick={() => void save()} variant="primary">
          Save the correction
        </CrmButton>
        <CrmButton disabled={busy} onClick={onCancel}>
          Cancel
        </CrmButton>
      </div>
    </div>
  );
}

export function EditVisit({ isTest, seatId, visitId }: { isTest: boolean; seatId: string; visitId: string }) {
  const router = useRouter();
  const [opened, setOpened] = useState(false);
  const [saved, setSaved] = useState<SavedVisitEdit | null>(null);
  // Read when he opens it, so the form starts from the visit as it stands now.
  const form = useCrmGet<VisitEditForm>(opened ? crmUrl("/api/phoenix-crm/visit-edit", { seatId, test: isTest, visitId }) : null, "form");

  if (!opened) {
    return (
      <div className="grid min-w-0 gap-2">
        {saved ? (
          <CrmNote tone="good">
            {saved.changed ? "Saved. A copy of what it said before is kept." : "Nothing was different, so nothing was changed."}
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
            Correct this visit
          </CrmButton>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0">
      {form.error ? <CrmLoadError message={form.error} onRetry={form.reload} /> : null}
      {!form.data && !form.error ? <CrmLoading label="Reading the visit" /> : null}
      {form.data ? (
        <EditForm
          form={form.data}
          isTest={isTest}
          key={form.data.visitId}
          onCancel={() => setOpened(false)}
          onSaved={(result) => {
            setSaved(result);
            setOpened(false);
            // The day above is the server's page: re-read it so the visit reads as corrected.
            router.refresh();
          }}
          seatId={seatId}
        />
      ) : null}
    </div>
  );
}
