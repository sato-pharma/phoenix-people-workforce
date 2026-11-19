"use client";

/**
 * Phoenix CRM — the one step before a visit to a customer who still owes his type, or a clinic its
 * speciality (owner, 2026-11-19: *"The rep, from his list"* — the customer shows "Speciality missing",
 * and his next Edit or visit asks him for it first). The rep picks from the same two lists every form
 * uses; the save sends only the type and the speciality (`kindOnly` on the rename route), and Add visit
 * then goes straight on to the form.
 *
 * Only the territory's own rep meets it: a manager logging on a rep's seat is never asked.
 */

import { useState, type ReactNode } from "react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CrmCustomerKindField } from "@/components/phoenix-crm/speciality-field";
import { CrmBlock, CrmButton, CrmNote, CrmPanel, CrmSaveError } from "@/components/phoenix-crm/ui";
import { bidiIsolate } from "@/emails/bidi";
import { customerKindProblem, defaultCustomerType } from "@/lib/phoenix-crm/speciality-list";
import type { VisitCustomerOption } from "@/lib/phoenix-crm/view-types";

export const KIND_FIRST_SENTENCE = "Pick the type and the speciality first. It is asked once.";

export function VisitKindGate({
  back,
  customer,
  onSaved,
  seatId,
  test,
}: {
  back: ReactNode;
  customer: Pick<VisitCustomerOption, "customerId" | "name" | "listType" | "customerType" | "speciality">;
  onSaved: () => void;
  seatId: string;
  test: boolean;
}) {
  const [customerType, setCustomerType] = useState(customer.customerType ?? defaultCustomerType(customer.listType));
  const [speciality, setSpeciality] = useState(customer.speciality ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    const gap = customerKindProblem({ customerType, speciality, listType: customer.listType });
    if (gap) {
      setProblem(gap);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/list/rename",
        { seatId, test, customerId: customer.customerId, kindOnly: true, customerType: customerType.trim() || null, speciality: speciality.trim() || null },
        "result",
      );
      onSaved();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  };

  return (
    <CrmPanel>
      {back}
      <CrmBlock>
        <CrmNote title={bidiIsolate(customer.name)} tone="warn">
          {KIND_FIRST_SENTENCE}
        </CrmNote>
        <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
          <CrmCustomerKindField
            customerType={customerType}
            disabled={saving}
            idPrefix={`visit-kind-${customer.customerId}`}
            kind={customer.listType}
            onSpecialityChange={setSpeciality}
            onTypeChange={setCustomerType}
            speciality={speciality}
          />
        </div>
        {problem ? (
          <div className="mt-3">
            <CrmSaveError message={problem} />
          </div>
        ) : null}
        <div className="mt-3">
          <CrmButton busy={saving} disabled={saving} onClick={() => void save()} variant="primary">
            Save and go on
          </CrmButton>
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
