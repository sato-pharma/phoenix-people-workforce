"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import {
  MONTHS,
  REACTION_OUTCOMES,
  SERIOUSNESS_REASONS,
  ADMIN_ROUTES,
  MEDICINE_ACTIONS,
  AGE_UNITS,
  DURATION_UNITS,
  type ReportItPayload,
  type ReactionBlock,
  type MedicineBlock,
  type ReactionOutcome,
  type SeriousnessReason,
  type AdminRoute,
  type MedicineActionTaken,
  type AgeUnit,
  type DurationUnit,
} from "@/lib/report-it/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2);
}

function emptyReaction(): ReactionBlock {
  return {
    id: uid(),
    symptom: "",
    startDate: { day: "", month: "", year: "" },
    endDate: { day: "", month: "", year: "" },
    duration: "",
    durationUnit: "",
    outcome: "",
    isSerious: "",
    seriousnessReasons: [],
  };
}

function emptyMedicine(): MedicineBlock {
  return {
    id: uid(),
    name: "",
    probablyCausingReaction: false,
    producer: "",
    batchNumber: "",
    dosage: "",
    adminRoute: "",
    startDate: { day: "", month: "", year: "" },
    endDate: { day: "", month: "", year: "" },
    duration: "",
    durationUnit: "",
    reasonForTaking: "",
    actionTaken: "",
  };
}

function initialPayload(): ReportItPayload {
  return {
    patientInitials: "",
    patientSex: "",
    isPregnant: false,
    isLactating: false,
    weight: "",
    dateOfBirth: { day: "", month: "", year: "" },
    ageAtReaction: "",
    ageUnit: "",
    country: "Egypt",
    reactions: [emptyReaction()],
    medicines: [emptyMedicine()],
    currentIllnesses: "",
    additionalComments: "",
  };
}

// ─── Reusable field primitives ────────────────────────────────────────────────

const fieldClass = "w-full rounded border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50";
const selectClass = `${fieldClass} cursor-pointer`;
const labelClass = "mb-1 block text-sm font-medium text-text";

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className={labelClass}>
      {children}
      {required && <span className="text-danger ml-0.5">*</span>}
    </label>
  );
}

function DateFields({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: { day: string; month: string; year: string };
  onChange: (v: { day: string; month: string; year: string }) => void;
  required?: boolean;
}) {
  return (
    <div>
      <FieldLabel required={required}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          placeholder="DD"
          value={value.day}
          onChange={(e) => onChange({ ...value, day: e.target.value })}
          className="w-16"
          maxLength={2}
        />
        <select
          value={value.month}
          onChange={(e) => onChange({ ...value, month: e.target.value })}
          className={`${selectClass} w-36`}
        >
          <option value="">Month</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={String(i + 1).padStart(2, "0")}>{m}</option>
          ))}
        </select>
        <Input
          placeholder="YYYY"
          value={value.year}
          onChange={(e) => onChange({ ...value, year: e.target.value })}
          className="w-24"
          maxLength={4}
        />
      </div>
    </div>
  );
}

function DurationFields({
  value,
  unitValue,
  onValueChange,
  onUnitChange,
}: {
  value: string;
  unitValue: string;
  onValueChange: (v: string) => void;
  onUnitChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <Input
        placeholder="Duration"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className="w-28"
      />
      <select
        value={unitValue}
        onChange={(e) => onUnitChange(e.target.value)}
        className={`${selectClass} w-32`}
      >
        <option value="">Unit</option>
        {DURATION_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
    </div>
  );
}

// ─── Step 1: Patient Info ──────────────────────────────────────────────────────

function Step1PatientInfo({
  payload,
  onChange,
}: {
  payload: ReportItPayload;
  onChange: (p: ReportItPayload) => void;
}) {
  const set = (patch: Partial<ReportItPayload>) => onChange({ ...payload, ...patch });

  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold border-b pb-2">Step 1 — Patient Information</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <FieldLabel required>Patient Initials</FieldLabel>
          <Input
            value={payload.patientInitials}
            onChange={(e) => set({ patientInitials: e.target.value })}
            placeholder="e.g. J.D."
            maxLength={10}
          />
        </div>
        <div>
          <FieldLabel>Sex</FieldLabel>
          <select
            value={payload.patientSex}
            onChange={(e) => {
              const v = e.target.value as "Male" | "Female" | "Unknown" | "";
              set({
                patientSex: v,
                isPregnant: v !== "Female" ? false : payload.isPregnant,
                isLactating: v !== "Female" ? false : payload.isLactating,
              });
            }}
            className={selectClass}
          >
            <option value="">Select sex</option>
            {["Male", "Female", "Unknown"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {payload.patientSex === "Female" && (
        <div className="flex gap-6">
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={payload.isPregnant}
              onChange={(e) => set({ isPregnant: e.target.checked })}
              className="h-4 w-4 accent-primary"
            />
            Pregnant
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={payload.isLactating}
              onChange={(e) => set({ isLactating: e.target.checked })}
              className="h-4 w-4 accent-primary"
            />
            Lactating
          </label>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <FieldLabel>Weight (kg)</FieldLabel>
          <Input
            value={payload.weight}
            onChange={(e) => set({ weight: e.target.value })}
            placeholder="e.g. 70"
            type="number"
          />
        </div>
        <div>
          <FieldLabel>Country</FieldLabel>
          <Input
            value={payload.country}
            onChange={(e) => set({ country: e.target.value })}
            placeholder="Egypt"
          />
        </div>
      </div>

      <DateFields
        label="Date of birth"
        value={payload.dateOfBirth}
        onChange={(v) => set({ dateOfBirth: v })}
      />

      <div className="flex items-end gap-3">
        <div>
          <FieldLabel>Age at time of reaction</FieldLabel>
          <Input
            value={payload.ageAtReaction}
            onChange={(e) => set({ ageAtReaction: e.target.value })}
            placeholder="e.g. 45"
            type="number"
            className="w-28"
          />
        </div>
        <select
          value={payload.ageUnit}
          onChange={(e) => set({ ageUnit: e.target.value as AgeUnit | "" })}
          className={`${selectClass} w-32`}
        >
          <option value="">Unit</option>
          {AGE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
    </div>
  );
}

// ─── Step 2: Reactions ────────────────────────────────────────────────────────

function ReactionBlockCard({
  reaction,
  index,
  onUpdate,
  onRemove,
  canRemove,
}: {
  reaction: ReactionBlock;
  index: number;
  onUpdate: (r: ReactionBlock) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const set = (patch: Partial<ReactionBlock>) => onUpdate({ ...reaction, ...patch });

  return (
    <div className="border rounded p-4 space-y-4 bg-bg-muted/30">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">Reaction #{index + 1}</span>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="p-1 text-danger hover:bg-danger/10 rounded"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <div>
        <FieldLabel required>Reaction / Symptom</FieldLabel>
        <Input
          value={reaction.symptom}
          onChange={(e) => set({ symptom: e.target.value })}
          placeholder="Describe the reaction or symptom"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <DateFields
          label="Start date"
          value={reaction.startDate}
          onChange={(v) => set({ startDate: v })}
          required
        />
        <DateFields
          label="End date"
          value={reaction.endDate}
          onChange={(v) => set({ endDate: v })}
        />
      </div>

      <div>
        <FieldLabel>Duration</FieldLabel>
        <DurationFields
          value={reaction.duration}
          unitValue={reaction.durationUnit}
          onValueChange={(v) => set({ duration: v })}
          onUnitChange={(v) => set({ durationUnit: v as DurationUnit | "" })}
        />
      </div>

      <div>
        <FieldLabel>Outcome of reaction</FieldLabel>
        <select
          value={reaction.outcome}
          onChange={(e) => set({ outcome: e.target.value as ReactionOutcome | "" })}
          className={selectClass}
        >
          <option value="">Select outcome</option>
          {REACTION_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>

      <div>
        <FieldLabel>Is this reaction serious?</FieldLabel>
        <select
          value={reaction.isSerious}
          onChange={(e) => {
            const v = e.target.value as "Yes" | "No" | "";
            set({
              isSerious: v,
              seriousnessReasons: v !== "Yes" ? [] : reaction.seriousnessReasons,
            });
          }}
          className={selectClass}
        >
          <option value="">Select</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      </div>

      {reaction.isSerious === "Yes" && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Reasons for seriousness</p>
          <div className="grid grid-cols-1 gap-2">
            {SERIOUSNESS_REASONS.map((reason) => (
              <label key={reason} className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={reaction.seriousnessReasons.includes(reason)}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    const next = checked
                      ? [...reaction.seriousnessReasons, reason]
                      : reaction.seriousnessReasons.filter((r) => r !== reason);
                    set({ seriousnessReasons: next as SeriousnessReason[] });
                  }}
                  className="h-4 w-4 accent-primary"
                />
                {reason}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Step2Reactions({
  payload,
  onChange,
}: {
  payload: ReportItPayload;
  onChange: (p: ReportItPayload) => void;
}) {
  const updateReaction = (i: number, r: ReactionBlock) => {
    const next = [...payload.reactions];
    next[i] = r;
    onChange({ ...payload, reactions: next });
  };

  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold border-b pb-2">Step 2 — Reactions / Symptoms</h2>
      {payload.reactions.map((r, i) => (
        <ReactionBlockCard
          key={r.id}
          reaction={r}
          index={i}
          onUpdate={(updated) => updateReaction(i, updated)}
          onRemove={() => onChange({ ...payload, reactions: payload.reactions.filter((_, idx) => idx !== i) })}
          canRemove={payload.reactions.length > 1}
        />
      ))}
      <Button
        type="button"
        variant="secondary"
        onClick={() => onChange({ ...payload, reactions: [...payload.reactions, emptyReaction()] })}
      >
        <Plus className="h-4 w-4 mr-1" />
        Add another reaction
      </Button>
    </div>
  );
}

// ─── Step 3: Medicines ─────────────────────────────────────────────────────────

function MedicineBlockCard({
  medicine,
  index,
  onUpdate,
  onRemove,
  canRemove,
}: {
  medicine: MedicineBlock;
  index: number;
  onUpdate: (m: MedicineBlock) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const set = (patch: Partial<MedicineBlock>) => onUpdate({ ...medicine, ...patch });

  return (
    <div className="border rounded p-4 space-y-4 bg-bg-muted/30">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">Medicine #{index + 1}</span>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="p-1 text-danger hover:bg-danger/10 rounded"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <FieldLabel>Medicine name</FieldLabel>
          <Input
            value={medicine.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Brand or generic name"
          />
        </div>
        <div>
          <FieldLabel>Producer / Manufacturer</FieldLabel>
          <Input
            value={medicine.producer}
            onChange={(e) => set({ producer: e.target.value })}
            placeholder="Company name"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <FieldLabel>Batch number</FieldLabel>
          <Input
            value={medicine.batchNumber}
            onChange={(e) => set({ batchNumber: e.target.value })}
            placeholder="Lot / batch"
          />
        </div>
        <div>
          <FieldLabel>Dosage</FieldLabel>
          <Input
            value={medicine.dosage}
            onChange={(e) => set({ dosage: e.target.value })}
            placeholder="e.g. 500 mg twice daily"
          />
        </div>
      </div>

      <div>
        <FieldLabel>Route of administration</FieldLabel>
        <select
          value={medicine.adminRoute}
          onChange={(e) => set({ adminRoute: e.target.value as AdminRoute | "" })}
          className={selectClass}
        >
          <option value="">Select route</option>
          {ADMIN_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <DateFields
          label="Start date"
          value={medicine.startDate}
          onChange={(v) => set({ startDate: v })}
        />
        <DateFields
          label="End date"
          value={medicine.endDate}
          onChange={(v) => set({ endDate: v })}
        />
      </div>

      <div>
        <FieldLabel>Duration of use</FieldLabel>
        <DurationFields
          value={medicine.duration}
          unitValue={medicine.durationUnit}
          onValueChange={(v) => set({ duration: v })}
          onUnitChange={(v) => set({ durationUnit: v as DurationUnit | "" })}
        />
      </div>

      <div>
        <FieldLabel>Reason for taking</FieldLabel>
        <Input
          value={medicine.reasonForTaking}
          onChange={(e) => set({ reasonForTaking: e.target.value })}
          placeholder="Indication / diagnosis"
        />
      </div>

      <div>
        <FieldLabel>Action taken with medicine</FieldLabel>
        <select
          value={medicine.actionTaken}
          onChange={(e) => set({ actionTaken: e.target.value as MedicineActionTaken | "" })}
          className={selectClass}
        >
          <option value="">Select action</option>
          {MEDICINE_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      <label className="flex items-center gap-2 cursor-pointer text-sm font-medium">
        <input
          type="checkbox"
          checked={medicine.probablyCausingReaction}
          onChange={(e) => set({ probablyCausingReaction: e.target.checked })}
          className="h-4 w-4 accent-primary"
        />
        Probably causing the reaction
      </label>
    </div>
  );
}

function Step3Medicines({
  payload,
  onChange,
}: {
  payload: ReportItPayload;
  onChange: (p: ReportItPayload) => void;
}) {
  const updateMedicine = (i: number, m: MedicineBlock) => {
    const next = [...payload.medicines];
    next[i] = m;
    onChange({ ...payload, medicines: next });
  };

  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold border-b pb-2">Step 3 — Medicines</h2>
      {payload.medicines.map((m, i) => (
        <MedicineBlockCard
          key={m.id}
          medicine={m}
          index={i}
          onUpdate={(updated) => updateMedicine(i, updated)}
          onRemove={() => onChange({ ...payload, medicines: payload.medicines.filter((_, idx) => idx !== i) })}
          canRemove={payload.medicines.length > 1}
        />
      ))}
      <Button
        type="button"
        variant="secondary"
        onClick={() => onChange({ ...payload, medicines: [...payload.medicines, emptyMedicine()] })}
      >
        <Plus className="h-4 w-4 mr-1" />
        Add another medicine
      </Button>
    </div>
  );
}

// ─── Step 4: Additional Info ───────────────────────────────────────────────────

function Step4Additional({
  payload,
  onChange,
}: {
  payload: ReportItPayload;
  onChange: (p: ReportItPayload) => void;
}) {
  const set = (patch: Partial<ReportItPayload>) => onChange({ ...payload, ...patch });

  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold border-b pb-2">Step 4 — Additional Information</h2>

      <div>
        <FieldLabel>Current illnesses / diagnoses</FieldLabel>
        <textarea
          value={payload.currentIllnesses}
          onChange={(e) => set({ currentIllnesses: e.target.value })}
          placeholder="List any known current illnesses or diagnoses"
          rows={3}
          className={`${fieldClass} resize-y`}
        />
      </div>

      <div>
        <FieldLabel>Additional comments</FieldLabel>
        <textarea
          value={payload.additionalComments}
          onChange={(e) => set({ additionalComments: e.target.value })}
          placeholder="Any additional information relevant to this report"
          rows={4}
          className={`${fieldClass} resize-y`}
        />
      </div>
    </div>
  );
}

// ─── Confirmation screen ───────────────────────────────────────────────────────

function ConfirmationScreen({ reportNumber }: { reportNumber: string }) {
  return (
    <div className="text-center py-10 space-y-4">
      <CheckCircle2 className="mx-auto h-14 w-14 text-success" />
      <h2 className="text-xl font-semibold">Report Submitted</h2>
      <p className="text-text-secondary">Your adverse drug reaction report has been submitted successfully.</p>
      <div className="inline-block bg-bg-muted rounded px-4 py-2">
        <span className="text-sm text-text-secondary mr-2">Report Number:</span>
        <span className="font-mono font-semibold">{reportNumber}</span>
      </div>
      <p className="text-sm text-text-secondary">Please keep this reference number for your records.</p>
    </div>
  );
}

// ─── Validation ────────────────────────────────────────────────────────────────

function validateStep(step: number, payload: ReportItPayload): string | null {
  if (step === 1) {
    if (!payload.patientInitials.trim()) return "Patient initials are required.";
  }
  if (step === 2) {
    for (const r of payload.reactions) {
      if (!r.symptom.trim()) return "Each reaction must have a symptom description.";
      if (!r.startDate.month && !r.startDate.year) return "Each reaction must have a start date.";
    }
  }
  return null;
}

// ─── Main form ─────────────────────────────────────────────────────────────────

const STEPS = ["Patient Info", "Reactions", "Medicines", "Additional Info"];

export function ReportItForm() {
  const [step, setStep] = useState(1);
  const [payload, setPayload] = useState<ReportItPayload>(initialPayload);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportNumber, setReportNumber] = useState<string | null>(null);

  const handleNext = useCallback(() => {
    const err = validateStep(step, payload);
    if (err) { setError(err); return; }
    setError(null);
    setStep((s) => s + 1);
  }, [step, payload]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep((s) => s - 1);
  }, []);

  const handleSubmit = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/report-it/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      });
      const data = (await res.json()) as { reportNumber?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Submission failed.");
      setReportNumber(data.reportNumber ?? "—");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [payload]);

  if (reportNumber) return <ConfirmationScreen reportNumber={reportNumber} />;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Progress */}
      <div className="flex items-center gap-1">
        {STEPS.map((label, i) => {
          const num = i + 1;
          const active = num === step;
          const done = num < step;
          return (
            <div key={label} className="flex items-center gap-1 flex-1">
              <div
                className={[
                  "flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold border shrink-0",
                  active ? "bg-primary text-white border-primary" : "",
                  done ? "bg-success text-white border-success" : "",
                  !active && !done ? "border-text-secondary text-text-secondary" : "",
                ].join(" ")}
              >
                {done ? "✓" : num}
              </div>
              <span className={["text-xs hidden sm:block truncate", active ? "font-medium" : "text-text-secondary"].join(" ")}>
                {label}
              </span>
              {i < STEPS.length - 1 && <div className="flex-1 h-px bg-border mx-1" />}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div className="border rounded p-5 bg-card">
        {step === 1 && <Step1PatientInfo payload={payload} onChange={setPayload} />}
        {step === 2 && <Step2Reactions payload={payload} onChange={setPayload} />}
        {step === 3 && <Step3Medicines payload={payload} onChange={setPayload} />}
        {step === 4 && <Step4Additional payload={payload} onChange={setPayload} />}
      </div>

      {/* Error */}
      {error && (
        <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded px-3 py-2">
          {error}
        </p>
      )}

      {/* Navigation */}
      <div className="flex justify-between items-center">
        <Button type="button" variant="secondary" onClick={handleBack} disabled={step === 1}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        {step < STEPS.length ? (
          <Button type="button" onClick={handleNext}>
            Next
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        ) : (
          <Button type="button" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Submitting…" : "Submit Report"}
          </Button>
        )}
      </div>
    </div>
  );
}
