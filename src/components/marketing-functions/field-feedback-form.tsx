"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { CheckTile, FormBlock, FormError, FormField, RatingScale } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxCheckTileClassName,
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { shortDateLabel } from "@/lib/marketing-functions/months";
import { missingForSignature } from "@/lib/marketing-functions/rules";
import type { FieldFeedback, FieldFeedbackRatings, RepOption, RideAlongDay } from "@/lib/marketing-functions/types";
import {
  CALL_RATING_LABELS,
  CALL_RATINGS,
  CALL_REMARKS,
  FIELD_ACTION_OWNER_LABELS,
  FIELD_ACTION_OWNER_SHORT,
  FIELD_ACTION_OWNERS,
  FIELD_FEEDBACK_LABELS,
  FIELD_VISIT_TYPE_LABEL,
  FIELD_VISIT_TYPE_LABELS,
  type FieldActionOwner,
  type FieldVisitType,
} from "@/lib/marketing-functions/vocabulary";
import { cn } from "@/lib/utils";

// Dr. Rasha's Marketing Field Visit Feedback form. Every label is hers (vocabulary.ts). What the screen
// adds: start from a logged Phoenix CRM ride-along day, keep the AM · PM · Pharmacies counts apart, rate
// with one tap, and say who should act on a finding. Signing locks the form.

type Props = {
  initial: FieldFeedback | null;
  rideAlongDays: RideAlongDay[];
  people: RepOption[];
  basePath: string;
  todayIso: string;
};

const RATING_OPTIONS = CALL_RATINGS.map((rating, index) => ({ label: CALL_RATING_LABELS[rating], title: CALL_RATING_LABELS[rating], value: index }));

function countValue(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 999) : null;
}

export function FieldFeedbackForm({ initial, rideAlongDays, people, basePath, todayIso }: Props) {
  const router = useRouter();
  const [visitType, setVisitType] = useState<FieldVisitType>(initial?.visitType ?? "double");
  const [repHrId, setRepHrId] = useState(initial?.repHrId ?? "");
  const [visitDate, setVisitDate] = useState(initial?.visitDate ?? todayIso);
  const [amClinics, setAmClinics] = useState<number | null>(initial?.amClinics ?? null);
  const [pmClinics, setPmClinics] = useState<number | null>(initial?.pmClinics ?? null);
  const [pharmacies, setPharmacies] = useState<number | null>(initial?.pharmacies ?? null);
  const [objectives, setObjectives] = useState(initial?.objectives ?? "");
  const [ratings, setRatings] = useState<FieldFeedbackRatings>(initial?.ratings ?? {});
  const [comments, setComments] = useState(initial?.comments ?? "");
  const [doctorsComments, setDoctorsComments] = useState(initial?.doctorsComments ?? "");
  const [recommendations, setRecommendations] = useState(initial?.recommendations ?? "");
  const [actionOwners, setActionOwners] = useState<FieldActionOwner[]>(initial?.actionOwners ?? []);
  const [fromCrmDay, setFromCrmDay] = useState(initial?.fromCrmDay ?? false);
  const [chosenDay, setChosenDay] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The person the day names may have left the field list since; keep him choosable for this form.
  const options = useMemo(() => {
    const list = [...people];
    const extra = [...rideAlongDays.map((day) => ({ area: day.repArea, hrId: day.repHrId, jobTitle: day.repJobTitle, line: day.repLine, name: day.repName }))];
    if (initial) extra.push({ area: initial.repArea, hrId: initial.repHrId, jobTitle: initial.repJobTitle, line: initial.repLine, name: initial.repName });
    for (const person of extra) {
      if (!list.some((entry) => entry.hrId.toUpperCase() === person.hrId.toUpperCase())) list.push(person);
    }
    return list;
  }, [people, rideAlongDays, initial]);
  const person = options.find((entry) => entry.hrId.toUpperCase() === repHrId.toUpperCase()) ?? null;

  const dayKey = (day: RideAlongDay) => `${day.visitDate}|${day.repHrId}`;
  function applyDay(key: string) {
    setChosenDay(key);
    const day = rideAlongDays.find((entry) => dayKey(entry) === key);
    if (!day) {
      setFromCrmDay(false);
      return;
    }
    setRepHrId(day.repHrId);
    setVisitDate(day.visitDate);
    setVisitType(day.visitType);
    setAmClinics(day.amClinics);
    setPmClinics(day.pmClinics);
    setPharmacies(day.pharmacies);
    setFromCrmDay(true);
  }

  const missing = missingForSignature({ objectives: objectives.trim() || null, ratings });

  async function save(sign: boolean) {
    setError(null);
    if (!repHrId) {
      setError(`Choose the ${FIELD_FEEDBACK_LABELS.accompaniedPerson.toLowerCase()}.`);
      return;
    }
    if (sign && missing.length > 0) {
      setError(missing.join(" "));
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/marketing-field-feedback", {
        body: JSON.stringify({
          form: {
            actionOwners,
            amClinics,
            comments,
            doctorsComments,
            fromCrmDay,
            id: initial?.id ?? null,
            objectives,
            pharmacies,
            pmClinics,
            ratings,
            recommendations,
            repHrId,
            visitDate,
            visitType,
          },
          sign,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!response.ok || !body.id) {
        setError(body.message ?? "The form did not save. Try again.");
        return;
      }
      router.push(`${basePath}/${body.id}`);
      router.refresh();
    } catch {
      setError("The connection dropped. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {!initial && rideAlongDays.length > 0 ? (
        <FormBlock label={<span className="text-sm font-black text-slate-900">Start from a logged field day</span>}>
          <FormField hint="Your Phoenix CRM days with a rep. Choosing one fills the person, the date and the visit counts." label="Field day">
            <select aria-label="Field day" className={phxSelectClassName} onChange={(event) => applyDay(event.target.value)} value={chosenDay}>
              <option value="">Enter the visit by hand</option>
              {rideAlongDays.map((day) => (
                <option key={dayKey(day)} value={dayKey(day)}>
                  {shortDateLabel(day.visitDate)} · {day.repName} · {FIELD_VISIT_TYPE_LABELS[day.visitType]}
                  {day.alreadyFiled ? " · already has a form" : ""}
                </option>
              ))}
            </select>
          </FormField>
        </FormBlock>
      ) : null}

      <FormBlock label={<span className="text-sm font-black text-slate-900">The visit</span>}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
          <FormField className="md:col-span-2" label={FIELD_VISIT_TYPE_LABEL} required>
            <div className="grid grid-cols-2 gap-2">
              {(["single", "double"] as const).map((type) => (
                <button
                  aria-pressed={visitType === type}
                  className={cn(phxCheckTileClassName(visitType === type), "justify-center")}
                  key={type}
                  onClick={() => setVisitType(type)}
                  type="button"
                >
                  {FIELD_VISIT_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          </FormField>
          <FormField className="md:col-span-2" label={FIELD_FEEDBACK_LABELS.accompaniedPerson} required>
            <SearchableSelect
              aria-label={FIELD_FEEDBACK_LABELS.accompaniedPerson}
              onValueChange={(value) => {
                setRepHrId(value);
                setFromCrmDay(false);
              }}
              placeholder="Choose the person"
              value={repHrId}
              wrapValue
            >
              <option value="">Choose the person</option>
              {options.map((entry) => (
                <option key={entry.hrId} value={entry.hrId}>
                  {entry.name}
                  {entry.area ? ` · ${entry.area}` : ""}
                </option>
              ))}
            </SearchableSelect>
          </FormField>
          <FormField className="md:col-span-2" label={FIELD_FEEDBACK_LABELS.date} required>
            <input className={phxFieldClassName} max={todayIso} onChange={(event) => setVisitDate(event.target.value)} type="date" value={visitDate} />
          </FormField>
          <FormField className="md:col-span-3" label={FIELD_FEEDBACK_LABELS.jobTitle}>
            <p className="flex min-h-10 items-center border border-slate-200 bg-slate-50 px-3 text-sm text-slate-800">{person?.jobTitle ?? "Filled from the person"}</p>
          </FormField>
          <FormField className="md:col-span-3" label={FIELD_FEEDBACK_LABELS.area}>
            <p className="flex min-h-10 items-center border border-slate-200 bg-slate-50 px-3 text-sm text-slate-800">{person?.area ?? "Filled from the person"}</p>
          </FormField>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <FormField label={`${FIELD_FEEDBACK_LABELS.visitedClinics} · AM`}>
            <input className={phxFieldClassName} inputMode="numeric" min={0} onChange={(event) => setAmClinics(countValue(event.target.value))} type="number" value={amClinics ?? ""} />
          </FormField>
          <FormField label={`${FIELD_FEEDBACK_LABELS.visitedClinics} · PM`}>
            <input className={phxFieldClassName} inputMode="numeric" min={0} onChange={(event) => setPmClinics(countValue(event.target.value))} type="number" value={pmClinics ?? ""} />
          </FormField>
          <FormField label={FIELD_FEEDBACK_LABELS.visitedPharmacies}>
            <input className={phxFieldClassName} inputMode="numeric" min={0} onChange={(event) => setPharmacies(countValue(event.target.value))} type="number" value={pharmacies ?? ""} />
          </FormField>
        </div>

        <FormField className="mt-4" label={FIELD_FEEDBACK_LABELS.objectives} required>
          <textarea className={phxTextareaClassName} maxLength={2000} onChange={(event) => setObjectives(event.target.value)} rows={3} value={objectives} />
        </FormField>
      </FormBlock>

      <FormBlock label={<span className="text-sm font-black text-slate-900">{FIELD_FEEDBACK_LABELS.callRemarks}</span>}>
        <ul className="divide-y divide-slate-200">
          {CALL_REMARKS.map((remark) => {
            const rating = ratings[remark.key];
            return (
              <li className="grid grid-cols-1 gap-2 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-center" key={remark.key}>
                <p className="text-sm font-bold text-slate-900">{remark.label}</p>
                <RatingScale
                  ariaLabel={remark.label}
                  className="grid-cols-4"
                  onChange={(next) => {
                    if (next === null) return;
                    setRatings((current) => ({ ...current, [remark.key]: CALL_RATINGS[next] }));
                  }}
                  options={RATING_OPTIONS}
                  value={rating ? CALL_RATINGS.indexOf(rating) : null}
                />
              </li>
            );
          })}
        </ul>
      </FormBlock>

      <FormBlock label={<span className="text-sm font-black text-slate-900">{FIELD_FEEDBACK_LABELS.comments}</span>}>
        <div className="grid grid-cols-1 gap-4">
          <FormField label={FIELD_FEEDBACK_LABELS.comments}>
            <textarea className={phxTextareaClassName} maxLength={2000} onChange={(event) => setComments(event.target.value)} rows={3} value={comments} />
          </FormField>
          <FormField label={FIELD_FEEDBACK_LABELS.doctorsComments}>
            <textarea className={phxTextareaClassName} maxLength={2000} onChange={(event) => setDoctorsComments(event.target.value)} rows={3} value={doctorsComments} />
          </FormField>
          <FormField label={FIELD_FEEDBACK_LABELS.recommendations}>
            <textarea className={phxTextareaClassName} maxLength={2000} onChange={(event) => setRecommendations(event.target.value)} rows={3} value={recommendations} />
          </FormField>
          <FormField hint="Who should act on these recommendations." label="To be worked on by">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {FIELD_ACTION_OWNERS.map((owner) => (
                <CheckTile
                  checked={actionOwners.includes(owner)}
                  key={owner}
                  onChange={(checked) =>
                    setActionOwners((current) => (checked ? FIELD_ACTION_OWNERS.filter((entry) => entry === owner || current.includes(entry)) : current.filter((entry) => entry !== owner)))
                  }
                >
                  <span className="min-w-0">
                    <span className="block font-black">{FIELD_ACTION_OWNER_SHORT[owner]}</span>
                    <span className="block text-xs font-medium text-slate-500">{FIELD_ACTION_OWNER_LABELS[owner]}</span>
                  </span>
                </CheckTile>
              ))}
            </div>
          </FormField>
        </div>
      </FormBlock>

      <FormError>{error}</FormError>

      <div className="flex flex-col gap-3 border-t border-slate-200 pt-4 md:flex-row md:items-center md:justify-between">
        <p className="text-sm text-slate-600">
          {FIELD_FEEDBACK_LABELS.signature}: signing locks the form and shares it with your managers.
          {missing.length > 0 ? ` ${missing.join(" ")}` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <button className={phxButtonGhostClassName} disabled={busy} onClick={() => save(false)} type="button">
            Save draft
          </button>
          <button className={phxButtonAccentClassName} disabled={busy || missing.length > 0} onClick={() => save(true)} type="button">
            Sign
          </button>
        </div>
      </div>
    </div>
  );
}
