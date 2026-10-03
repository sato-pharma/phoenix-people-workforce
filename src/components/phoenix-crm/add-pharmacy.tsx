"use client";

/**
 * Phoenix CRM — Add a pharmacy, by its name and nothing else.
 *
 * Owner, 2026-10-03: "he can add to his list pharmacies without approval normally … in pharmacy visit
 * … all his pharmacies to be listed and he can also add a pharmacy without any validation or without
 * any approval". So there is no signboard photo, no location, no hours and no request here — a doctor's
 * Add new customer needs all four and waits for two approvals; a pharmacy is on his list the moment he
 * saves it (pharmacy-call-rules.ts rule 3d). The List opens it from its header; Add visit → Pharmacy
 * visit opens it under the pharmacies, and goes straight on to the visit form on the one he added.
 */

import { useState } from "react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CrmBackBar, CrmBlock, CrmButton, CrmField, CrmNote, CrmPanel, crmInputClassName } from "@/components/phoenix-crm/ui";
import { useInsideCrmStepForm } from "@/components/phoenix-crm/step-form";
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
  const [name, setName] = useState("");
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
      const added = await crmPost<AddedPharmacy>("/api/phoenix-crm/list/pharmacy", { seatId, test, name, from }, "result");
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
        <CrmField error={problem} hint="As written on the sign." htmlFor="phoenix-crm-add-pharmacy-name" label="Pharmacy name">
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
        <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
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
