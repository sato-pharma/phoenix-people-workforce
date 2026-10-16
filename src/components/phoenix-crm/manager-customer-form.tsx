"use client";

/**
 * Phoenix CRM — "Add a customer" to a district manager's own list (owner, 2026-10-16).
 *
 * Name, speciality, phone or contact, the grade AND the potential grade, the area of his district, a
 * comment, and an optional Capture location — the server resolves the address, the area and the brick.
 * No photo and NO validation step: "there will not be validation because they are managers".
 *
 * 🔴 A NAME ALREADY ON A LIST IS OFFERED FIRST, never refused. As he types, the customers of his reps'
 * lists and of his own list under that name are shown, and he picks the one he means. Namesakes are real,
 * so "a different customer with the same name" is always his to choose — he carries on and adds him.
 *
 * Manager's own list is HIS: it is never merged into a rep's list, and a rep never sees it.
 */

import { useEffect, useId, useRef, useState } from "react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CaptureLocation, type CapturedPin } from "@/components/phoenix-crm/capture-location";
import { CrmButton, CrmCard, CrmChoice, CrmField, CrmNote, CrmPill, CrmSelect, crmInputClassName, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { MANAGER_CUSTOMER_GRADES, MANAGER_CUSTOMER_POTENTIAL_GRADES, MANAGER_PLAN_NOTE_MAX } from "@/lib/phoenix-crm/manager-plan-rules";
import type { CustomerMatch, ManagerCustomerView } from "@/lib/phoenix-crm/view-types";

/** How long after his last keystroke the name is looked up. */
const MATCH_DELAY_MS = 500;
/** A name shorter than this is not looked up — two letters match half the district. */
const MATCH_FROM = 3;

export function ManagerCustomerForm({
  areas,
  defaultAreaSeatId,
  onAdded,
  onCancel,
  onPickExisting,
  test,
}: {
  areas: ReadonlyArray<{ seatId: string; areaName: string }>;
  defaultAreaSeatId?: string | null;
  onAdded: (customer: ManagerCustomerView) => void;
  onCancel: () => void;
  /** Where a match can be chosen instead (a single visit's customers). Absent, a match is only shown. */
  onPickExisting?: (match: CustomerMatch) => void;
  test: boolean;
}) {
  const idPrefix = useId();
  const [name, setName] = useState("");
  const [speciality, setSpeciality] = useState("");
  const [phone, setPhone] = useState("");
  const [contactNote, setContactNote] = useState("");
  const [grade, setGrade] = useState<string | null>(null);
  const [potentialGrade, setPotentialGrade] = useState<string | null>(null);
  const [areaSeatId, setAreaSeatId] = useState(defaultAreaSeatId ?? areas[0]?.seatId ?? "");
  const [comment, setComment] = useState("");
  const [pin, setPin] = useState<CapturedPin | null>(null);
  const [matches, setMatches] = useState<CustomerMatch[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);

  useEffect(() => {
    const typed = name.trim();
    const ask = ++asked.current;
    if (typed.length < MATCH_FROM) return;
    const timer = window.setTimeout(() => {
      crmPost<CustomerMatch[]>("/api/phoenix-crm/manager-plans/customers/match", { name: typed, test }, "matches").then(
        (found) => {
          if (ask === asked.current) setMatches(found);
        },
        () => {
          // A failed lookup offers nothing; the add itself is never held up by it.
          if (ask === asked.current) setMatches([]);
        },
      );
    }, MATCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [name, test]);

  const shownMatches = name.trim().length >= MATCH_FROM ? matches : [];
  const missing = !name.trim() ? "Write the customer's name." : !grade ? "Choose the grade." : !potentialGrade ? "Choose the potential grade." : !areaSeatId ? "Choose the area." : null;

  async function add() {
    if (missing) {
      setError(missing);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const added = await crmPost<ManagerCustomerView>(
        "/api/phoenix-crm/manager-plans/customers",
        {
          name: name.trim(),
          speciality: speciality.trim() || null,
          phone: phone.trim() || null,
          contactNote: contactNote.trim() || null,
          grade,
          potentialGrade,
          areaSeatId,
          comment: comment.trim() || null,
          ...(pin ? { pin: { lat: pin.lat, lon: pin.lon, accuracyMeters: pin.accuracyMeters } } : {}),
          test,
        },
        "customer",
      );
      onAdded(added);
    } catch (failure) {
      setError(messageOf(failure));
      setSaving(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-4 border border-slate-200 bg-slate-50/60 p-4">
      <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Add a customer to Manager&apos;s own list</p>
      <CrmField htmlFor={`${idPrefix}-name`} label="Name *">
        <input
          autoComplete="off"
          className={crmInputClassName}
          dir="auto"
          id={`${idPrefix}-name`}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </CrmField>

      {shownMatches.length > 0 ? (
        <CrmNote title="Already on a list under this name" tone="info">
          <p>Is it one of these? Choose that one rather than adding the same customer twice. A different customer with the same name? Carry on and add the new one.</p>
          <div className="mt-2 grid gap-2">
            {shownMatches.map((match) => (
              <CrmCard
                accent={match.source === "own" ? "border-l-orange-400" : "border-l-sky-400"}
                actions={
                  onPickExisting ? (
                    <CrmButton onClick={() => onPickExisting(match)} size="sm" variant="primary">
                      Choose this one
                    </CrmButton>
                  ) : undefined
                }
                key={`${match.source}:${match.id}`}
                meta={<span className="break-words">{match.detail}</span>}
                status={<CrmPill tone={match.source === "own" ? "orange" : "info"}>{match.source === "own" ? "Manager's own list" : "A rep's list"}</CrmPill>}
                title={
                  <span className="break-words" dir="auto">
                    {match.name}
                  </span>
                }
              />
            ))}
          </div>
        </CrmNote>
      ) : null}

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <CrmField htmlFor={`${idPrefix}-speciality`} label="Speciality">
          <input className={crmInputClassName} id={`${idPrefix}-speciality`} maxLength={120} onChange={(event) => setSpeciality(event.target.value)} value={speciality} />
        </CrmField>
        <CrmField htmlFor={`${idPrefix}-phone`} label="Phone">
          <input className={crmInputClassName} id={`${idPrefix}-phone`} inputMode="tel" maxLength={30} onChange={(event) => setPhone(event.target.value)} type="tel" value={phone} />
        </CrmField>
      </div>
      <CrmField hint="Who to ask for, or how to reach the customer." htmlFor={`${idPrefix}-contact`} label="Contact">
        <input className={crmInputClassName} id={`${idPrefix}-contact`} maxLength={300} onChange={(event) => setContactNote(event.target.value)} value={contactNote} />
      </CrmField>
      <CrmField label="Grade *">
        <CrmChoice columns={3} label="Grade" onChange={setGrade} options={MANAGER_CUSTOMER_GRADES.map((value) => ({ value, label: value }))} value={grade} />
      </CrmField>
      <CrmField label="Potential grade *">
        <CrmChoice
          columns={3}
          label="Potential grade"
          onChange={setPotentialGrade}
          options={MANAGER_CUSTOMER_POTENTIAL_GRADES.map((value) => ({ value, label: value }))}
          value={potentialGrade}
        />
      </CrmField>
      {areas.length > 1 ? (
        <CrmField htmlFor={`${idPrefix}-area`} label="Area *">
          <CrmSelect id={`${idPrefix}-area`} onChange={(event) => setAreaSeatId(event.target.value)} value={areaSeatId}>
            {areas.map((area) => (
              <option key={area.seatId} value={area.seatId}>
                {area.areaName}
              </option>
            ))}
          </CrmSelect>
        </CrmField>
      ) : null}
      <CrmField htmlFor={`${idPrefix}-comment`} label="Comment">
        <textarea
          className={crmTextareaClassName}
          dir="auto"
          id={`${idPrefix}-comment`}
          maxLength={MANAGER_PLAN_NOTE_MAX}
          onChange={(event) => setComment(event.target.value)}
          value={comment}
        />
      </CrmField>
      <CrmField hint="Optional. Stand at the clinic and press it; the address, area and brick are filled in for you." label="Location">
        <CaptureLocation disabled={saving} onChange={setPin} value={pin} />
      </CrmField>

      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
      <div className="flex flex-wrap gap-2">
        <CrmButton busy={saving} onClick={() => void add()} variant="primary">
          Add to my list
        </CrmButton>
        <CrmButton disabled={saving} onClick={onCancel} variant="ghost">
          Cancel
        </CrmButton>
      </div>
    </div>
  );
}
