"use client";

/**
 * Phoenix CRM — Add a pharmacy, by its name and nothing else.
 *
 * Owner, 2026-10-03: "he can add to his list pharmacies without approval normally … in pharmacy visit
 * … all his pharmacies to be listed and he can also add a pharmacy without any validation or without
 * any approval". So there is no signboard photo, no hours and no request here — a doctor's Add new
 * customer needs all of them and waits for two approvals; a pharmacy is on his list the moment he
 * saves it (pharmacy-call-rules.ts rule 3d). The List opens it from its header; Add visit → Pharmacy
 * visit opens it under the pharmacies, and goes straight on to the visit form on the one he added.
 *
 * 🔴 ITS LOCATION AND ITS RESPONSIBLE PERSON'S PHONE ARE OPTIONAL EXTRAS, AND OPTIONAL IS THE WHOLE
 * POINT (owner, 2026-10-09: "make it optional to add its location by a pin button … optional, if you
 * want to save its location do this, if you want also don't do this, and also make optional to add
 * the responsible person's phone number"). The name alone still saves, in exactly the taps it took
 * yesterday: the two sit under one heading below the name, neither is required, and the pin is a
 * record of where the pharmacy is — never a validation, and never a check on the rep.
 */

import { useState } from "react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import type { CapturedPin } from "@/components/phoenix-crm/capture-location";
import { PharmacyExtras } from "@/components/phoenix-crm/pharmacy-details";
import { CrmBackBar, CrmBlock, CrmButton, CrmField, CrmNote, CrmPanel, crmInputClassName } from "@/components/phoenix-crm/ui";
import { useInsideCrmStepForm } from "@/components/phoenix-crm/step-form";
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";
import { ADDED_PHARMACY_NAME_MAX, addedPharmacyNameProblem } from "@/lib/phoenix-crm/pharmacy-call-rules";

/** What the server answered: the pharmacy on his list, and whether it was added just now. */
export type AddedPharmacy = { customerId: string; customerName: string; created: boolean };

export function AddPharmacyScreen({
  backLabel,
  from,
  onAdded,
  onBack,
  seatId,
  test,
}: {
  backLabel: string;
  /** Where he added it — written on the pharmacy, never shown to him. */
  from: "list" | "visit";
  onAdded: (added: AddedPharmacy) => void;
  onBack: () => void;
  seatId: string;
  test: boolean;
}) {
  const browserNamed = useBrowserNamed();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState<CapturedPin | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Inside Add visit's step form the form's own foot carries Back: one Back, never two.
  const framed = useInsideCrmStepForm();

  async function save() {
    if (saving) return;
    const refusal = addedPharmacyNameProblem(name);
    if (refusal) {
      setProblem(refusal);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const added = await crmPost<AddedPharmacy>(
        "/api/phoenix-crm/list/pharmacy",
        // Both keys are sent only when he filled them in, so an add with neither is the body the
        // route has always received and takes the path it has always taken.
        { seatId, test, name, from, ...(phone.trim() ? { phone } : {}), ...(pin ? { pin } : {}) },
        "result",
      );
      onAdded(added);
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel={backLabel} onBack={onBack} title="Add a pharmacy" />
      <CrmBlock>
        <CrmNote className="mb-3" title="No photo and no approval" tone="info">
          Write the pharmacy&apos;s name. It is on your list the moment you save it, and its visits count in Pharmacies, never in AM or PM.
        </CrmNote>
        {/* The refusal reads in the save block below, where every refusal on this screen reads — the
            name is no longer the only thing that can be refused here. */}
        <CrmField hint="As written on the sign." htmlFor="phoenix-crm-add-pharmacy-name" label="Pharmacy name">
          <input
            autoComplete="off"
            className={crmInputClassName}
            dir="auto"
            disabled={saving}
            id="phoenix-crm-add-pharmacy-name"
            maxLength={ADDED_PHARMACY_NAME_MAX}
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
            value={name}
          />
        </CrmField>
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100" title="Its location and phone — if you want to">
        <PharmacyExtras
          disabled={saving}
          idPrefix="phoenix-crm-add-pharmacy"
          onPhone={(next) => {
            setPhone(next);
            setProblem(null);
          }}
          onPin={(next) => {
            setPin(next);
            setProblem(null);
          }}
          phone={phone}
          pin={pin}
          saved={null}
        />
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100">
        {problem ? (
          <CrmNote className="mb-3" tone="bad">
            {browserNamed(problem)}
          </CrmNote>
        ) : null}
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={saving} onClick={() => void save()} variant="primary">
            {from === "visit" ? "Add it and log the visit" : "Add to your list"}
          </CrmButton>
          {framed ? null : (
            <CrmButton disabled={saving} onClick={onBack}>
              Cancel
            </CrmButton>
          )}
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
