"use client";

import { useState, useCallback } from "react";
import { CheckCircle2, Plus, ShieldCheck, Trash2 } from "lucide-react";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { adminPanelClassName } from "@/components/admin/admin-design-tokens";
// 🔒 THIS FORM IS THE REFERENCE FOR EVERY FORM IN THE SYSTEM (owner, 2026-10-06:
// "sweep the system wide everywhere admin or emp any form or any thing
// applicable make it follow this form design"). Its look no longer lives in this
// file — it lives in `@/components/ui/form-kit`, which every other admin and
// portal form now imports. Restyling a field here changes nothing on its own:
// change the token, and the whole system follows.
import {
  CheckTile,
  FieldLabel,
  FormBlockHeader,
  FormWizard,
  type FormWizardStep,
  phxButtonAccentClassName,
  phxButtonAddBlockClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxFieldGridClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-kit";


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

// ─── Field primitives ─────────────────────────────────────────────────────────
//
// These names are kept as local aliases of the shared tokens so this file reads
// the way it always has, while the STRINGS now come from one place. See the
// import block above for why.

const fieldClass = phxFieldClassName;
const selectClass = phxSelectClassName;
const textareaClass = phxTextareaClassName;

const btnGhost = phxButtonGhostClassName;
const btnDark = phxButtonPrimaryClassName;
const btnOrange = phxButtonAccentClassName;
const btnAddBlock = phxButtonAddBlockClassName;

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
        <input
          placeholder="DD"
          value={value.day}
          onChange={(e) => onChange({ ...value, day: e.target.value })}
          className={`${fieldClass} basis-16 shrink-0`}
          maxLength={2}
        />
        <SearchableSelect
          value={value.month}
          onChange={(e) => onChange({ ...value, month: e.target.value })}
          className={`${selectClass} min-w-0 flex-1`}
        >
          <option value="">Month</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={String(i + 1).padStart(2, "0")}>{m}</option>
          ))}
        </SearchableSelect>
        <input
          placeholder="YYYY"
          value={value.year}
          onChange={(e) => onChange({ ...value, year: e.target.value })}
          className={`${fieldClass} basis-24 shrink-0`}
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
      <input
        placeholder="Duration"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className={`${fieldClass} basis-28 shrink-0`}
      />
      <SearchableSelect
        value={unitValue}
        onChange={(e) => onUnitChange(e.target.value)}
        className={`${selectClass} min-w-0 flex-1`}
      >
        <option value="">Unit</option>
        {DURATION_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
      </SearchableSelect>
    </div>
  );
}

// Block header used by repeating reaction/medicine cards — the shared one, with
// this form's remove button in its action slot.
function BlockHeader({
  label,
  onRemove,
  canRemove,
}: {
  label: string;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <FormBlockHeader
      label={label}
      action={
        canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="p-1 text-slate-400 transition hover:text-rose-600"
            aria-label={`Remove ${label}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ) : undefined
      }
    />
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
      <div className={phxFieldGridClassName}>
        <div>
          <FieldLabel required>Patient Initials</FieldLabel>
          <input
            value={payload.patientInitials}
            onChange={(e) => set({ patientInitials: e.target.value })}
            placeholder="e.g. J.D."
            maxLength={10}
            className={fieldClass}
          />
        </div>
        <div>
          <FieldLabel>Sex</FieldLabel>
          <SearchableSelect
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
          </SearchableSelect>
        </div>
        <div>
          <FieldLabel>Weight (kg)</FieldLabel>
          <input
            value={payload.weight}
            onChange={(e) => set({ weight: e.target.value })}
            placeholder="e.g. 70"
            type="number"
            className={fieldClass}
          />
        </div>
        <div>
          <FieldLabel>Country</FieldLabel>
          <input
            value={payload.country}
            onChange={(e) => set({ country: e.target.value })}
            placeholder="Egypt"
            className={fieldClass}
          />
        </div>
        <DateFields
          label="Date of birth"
          value={payload.dateOfBirth}
          onChange={(v) => set({ dateOfBirth: v })}
        />
        <div>
          <FieldLabel>Age at time of reaction</FieldLabel>
          <div className="flex gap-2">
            <input
              value={payload.ageAtReaction}
              onChange={(e) => set({ ageAtReaction: e.target.value })}
              placeholder="e.g. 45"
              type="number"
              className={`${fieldClass} basis-28 shrink-0`}
            />
            <SearchableSelect
              value={payload.ageUnit}
              onChange={(e) => set({ ageUnit: e.target.value as AgeUnit | "" })}
              className={`${selectClass} min-w-0 flex-1`}
            >
              <option value="">Unit</option>
              {AGE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </SearchableSelect>
          </div>
        </div>
      </div>

      {payload.patientSex === "Female" && (
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          <CheckTile checked={payload.isPregnant} onChange={(v) => set({ isPregnant: v })}>
            Pregnant
          </CheckTile>
          <CheckTile checked={payload.isLactating} onChange={(v) => set({ isLactating: v })}>
            Lactating
          </CheckTile>
        </div>
      )}
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
    <div className="border border-slate-200">
      <BlockHeader label={`Reaction #${index + 1}`} onRemove={onRemove} canRemove={canRemove} />

      <div className="space-y-4 p-4">
        <div>
          <FieldLabel required>Reaction / Symptom</FieldLabel>
          <input
            value={reaction.symptom}
            onChange={(e) => set({ symptom: e.target.value })}
            placeholder="Describe the reaction or symptom"
            className={fieldClass}
          />
        </div>

        <div className={phxFieldGridClassName}>
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
          <div>
            <FieldLabel>Duration</FieldLabel>
            <DurationFields
              value={reaction.duration}
              unitValue={reaction.durationUnit}
              onValueChange={(v) => set({ duration: v })}
              onUnitChange={(v) => set({ durationUnit: v as DurationUnit | "" })}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel>Outcome of reaction</FieldLabel>
            <SearchableSelect
              value={reaction.outcome}
              onChange={(e) => set({ outcome: e.target.value as ReactionOutcome | "" })}
              className={selectClass}
            >
              <option value="">Select outcome</option>
              {REACTION_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
            </SearchableSelect>
          </div>
          <div>
            <FieldLabel>Is this reaction serious?</FieldLabel>
            <SearchableSelect
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
            </SearchableSelect>
          </div>
        </div>

        {reaction.isSerious === "Yes" && (
          <div className="border border-rose-200 bg-rose-50/50 p-3">
            <p className="mb-2 text-phx-xs font-black uppercase tracking-wide text-rose-700">
              Reasons for seriousness
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {SERIOUSNESS_REASONS.map((reason) => (
                <CheckTile
                  key={reason}
                  checked={reaction.seriousnessReasons.includes(reason)}
                  onChange={(checked) => {
                    const next = checked
                      ? [...reaction.seriousnessReasons, reason]
                      : reaction.seriousnessReasons.filter((r) => r !== reason);
                    set({ seriousnessReasons: next as SeriousnessReason[] });
                  }}
                >
                  {reason}
                </CheckTile>
              ))}
            </div>
          </div>
        )}
      </div>
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
    <div className="space-y-4">
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
      <button
        type="button"
        className={btnAddBlock}
        onClick={() => onChange({ ...payload, reactions: [...payload.reactions, emptyReaction()] })}
      >
        <Plus className="h-4 w-4" />
        Add another reaction
      </button>
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
    <div className="border border-slate-200">
      <BlockHeader label={`Medicine #${index + 1}`} onRemove={onRemove} canRemove={canRemove} />

      <div className="space-y-4 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <div>
            <FieldLabel>Medicine name</FieldLabel>
            <input
              value={medicine.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Brand or generic name"
              className={fieldClass}
            />
          </div>
          <div>
            <FieldLabel>Producer / Manufacturer</FieldLabel>
            <input
              value={medicine.producer}
              onChange={(e) => set({ producer: e.target.value })}
              placeholder="Company name"
              className={fieldClass}
            />
          </div>
          <div>
            <FieldLabel>Batch number</FieldLabel>
            <input
              value={medicine.batchNumber}
              onChange={(e) => set({ batchNumber: e.target.value })}
              placeholder="Lot / batch"
              className={fieldClass}
            />
          </div>
          <div>
            <FieldLabel>Dosage</FieldLabel>
            <input
              value={medicine.dosage}
              onChange={(e) => set({ dosage: e.target.value })}
              placeholder="e.g. 500 mg twice daily"
              className={fieldClass}
            />
          </div>
          <div>
            <FieldLabel>Route of administration</FieldLabel>
            <SearchableSelect
              value={medicine.adminRoute}
              onChange={(e) => set({ adminRoute: e.target.value as AdminRoute | "" })}
              className={selectClass}
            >
              <option value="">Select route</option>
              {ADMIN_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
            </SearchableSelect>
          </div>
          <div>
            <FieldLabel>Action taken with medicine</FieldLabel>
            <SearchableSelect
              value={medicine.actionTaken}
              onChange={(e) => set({ actionTaken: e.target.value as MedicineActionTaken | "" })}
              className={selectClass}
            >
              <option value="">Select action</option>
              {MEDICINE_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </SearchableSelect>
          </div>
        </div>

        <div className={phxFieldGridClassName}>
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
          <div>
            <FieldLabel>Duration of use</FieldLabel>
            <DurationFields
              value={medicine.duration}
              unitValue={medicine.durationUnit}
              onValueChange={(v) => set({ duration: v })}
              onUnitChange={(v) => set({ durationUnit: v as DurationUnit | "" })}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel>Reason for taking</FieldLabel>
            <input
              value={medicine.reasonForTaking}
              onChange={(e) => set({ reasonForTaking: e.target.value })}
              placeholder="Indication / diagnosis"
              className={fieldClass}
            />
          </div>
          <div className="flex flex-col justify-end">
            <CheckTile
              checked={medicine.probablyCausingReaction}
              onChange={(v) => set({ probablyCausingReaction: v })}
            >
              Probably causing the reaction
            </CheckTile>
          </div>
        </div>
      </div>
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
    <div className="space-y-4">
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
      <button
        type="button"
        className={btnAddBlock}
        onClick={() => onChange({ ...payload, medicines: [...payload.medicines, emptyMedicine()] })}
      >
        <Plus className="h-4 w-4" />
        Add another medicine
      </button>
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
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div>
        <FieldLabel>Current illnesses / diagnoses</FieldLabel>
        <textarea
          value={payload.currentIllnesses}
          onChange={(e) => set({ currentIllnesses: e.target.value })}
          placeholder="List any known current illnesses or diagnoses"
          rows={5}
          className={textareaClass}
        />
      </div>

      <div>
        <FieldLabel>Additional comments</FieldLabel>
        <textarea
          value={payload.additionalComments}
          onChange={(e) => set({ additionalComments: e.target.value })}
          placeholder="Any additional information relevant to this report"
          rows={5}
          className={textareaClass}
        />
      </div>
    </div>
  );
}

// ─── Confirmation screen ───────────────────────────────────────────────────────

type ReportItFormVariant = "employee" | "admin";

type ReportItFormProps = {
  onSubmitSuccess?: () => void;
  variant?: ReportItFormVariant;
};

function ConfirmationScreen({
  reportNumber,
  onReset,
  onViewReports,
  variant = "employee",
}: {
  reportNumber: string;
  onReset: () => void;
  onViewReports?: () => void;
  variant?: ReportItFormVariant;
}) {
  const isAdmin = variant === "admin";

  return (
    <div className={isAdmin ? `mx-auto max-w-xl overflow-hidden p-0 ${adminPanelClassName}` : "mx-auto max-w-xl border border-slate-200 bg-white shadow-sm"}>
      {isAdmin ? (
        <div className="border-b border-phx-line bg-[#FCFDFE] px-6 py-7 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center border border-emerald-200 bg-emerald-50">
            <CheckCircle2 className="h-9 w-9 text-emerald-600" />
          </div>
          <p className="mt-5 text-phx-xs font-black uppercase tracking-[0.2em] text-orange-600">Pharmacovigilance</p>
          <h2 className="mt-1 text-2xl font-black text-slate-900">Report Submitted</h2>
        </div>
      ) : (
        <div className="relative overflow-hidden bg-slate-900 px-6 py-9 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 h-48 w-48 rounded-full bg-orange-500/10 blur-2xl"
          />
          <div className="relative">
          <div className="mx-auto flex h-16 w-16 items-center justify-center bg-orange-600">
            <CheckCircle2 className="h-9 w-9 text-white" />
          </div>
          <p className="mt-5 text-phx-xs font-black uppercase tracking-[0.25em] text-orange-400">Pharmacovigilance</p>
          <h2 className="mt-1 text-2xl font-black text-white">Report Submitted</h2>
          </div>
        </div>
      )}
      <div className="space-y-5 px-6 py-7 text-center">
        <p className="text-sm text-slate-600">
          Your adverse drug reaction report has been submitted to the pharmacovigilance team.
        </p>
        <div className="inline-block border border-slate-900 bg-slate-900 px-7 py-3.5">
          <p className="text-phx-2xs font-black uppercase tracking-[0.25em] text-orange-300">Report Number</p>
          <p className="mt-1 font-mono text-xl font-black tracking-wide text-white">{reportNumber}</p>
        </div>
        <p className="text-xs font-semibold text-slate-500">
          Please keep this reference number for your records.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {onViewReports && (
            <button type="button" className={isAdmin ? btnOrange : btnDark} onClick={onViewReports}>
              {isAdmin ? "View Reports" : "View My Reports"}
            </button>
          )}
          <button type="button" className={btnGhost} onClick={onReset}>
            <Plus className="h-4 w-4" />
            File another report
          </button>
        </div>
      </div>
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
//
// The shell — the titled header, the progress bar, the numbered rail, the mobile
// stepper, the step heading and the Back/Next/Submit footer — is `FormWizard`
// from the shared kit. It used to be ~150 lines of markup here; it is now the
// one shell every multi-step form in the system renders.

const STEPS: FormWizardStep[] = [
  { label: "Patient Info", description: "Who the report is about", title: "Patient Information" },
  { label: "Reactions", description: "Symptoms and seriousness", title: "Reactions / Symptoms" },
  { label: "Medicines", description: "Suspected products", title: "Medicines" },
  { label: "Additional Info", description: "Context and comments", title: "Additional Information" },
];

export function ReportItForm({ onSubmitSuccess, variant = "employee" }: ReportItFormProps = {}) {
  const [step, setStep] = useState(1);
  const [payload, setPayload] = useState<ReportItPayload>(initialPayload);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportNumber, setReportNumber] = useState<string | null>(null);
  const isAdmin = variant === "admin";

  // Returning false keeps the wizard on this step; the rail only ever jumps
  // BACK, so forward movement always passes through this gate.
  const handleNext = useCallback(() => {
    const err = validateStep(step, payload);
    if (err) {
      setError(err);
      return false;
    }
    setError(null);
    return true;
  }, [step, payload]);

  const handleStepChange = useCallback((next: number) => {
    setError(null);
    setStep(next);
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

  if (reportNumber) {
    return (
      <ConfirmationScreen
        reportNumber={reportNumber}
        variant={variant}
        onReset={() => {
          setPayload(initialPayload());
          setStep(1);
          setError(null);
          setReportNumber(null);
        }}
        onViewReports={onSubmitSuccess}
      />
    );
  }

  const confidentialBadge = isAdmin ? (
    <span className="inline-flex w-fit items-center gap-1.5 border border-orange-200 bg-orange-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-wide text-orange-700">
      <ShieldCheck className="h-3.5 w-3.5" />
      Confidential
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
      <ShieldCheck className="h-3.5 w-3.5 text-orange-500" />
      Confidential
    </span>
  );

  const requiredNote = (
    <>
      Fields marked with <span className="font-bold text-orange-600">*</span> are required.
    </>
  );

  return (
    <FormWizard
      steps={STEPS}
      step={step}
      onStepChange={handleStepChange}
      // 🔴 A SECOND DARK HERO MUST NOT COME BACK ON THE PORTAL PAGE.
      // `EmployeePortalPageShell` already paints the navy command header there —
      // the `Pharmacovigilance` badge, the title `Report It` and the description
      // — so a titled header here repeated all three and the page shipped with
      // TWO stacked dark headers (owner, 2026-09-30, after the same defect was
      // removed from Spotlight). `strip` prints only what the shell does NOT
      // say: the step, the confidentiality, the required-field note. The admin
      // shell prints no title for this form, so it takes the full `panel`.
      header={isAdmin ? "panel" : "strip"}
      className={isAdmin ? adminPanelClassName : undefined}
      eyebrow={isAdmin ? "Admin submission" : undefined}
      title={isAdmin ? "Adverse Drug Reaction Report" : undefined}
      description={
        isAdmin ? <>File a pharmacovigilance report from the admin shell. {requiredNote}</> : requiredNote
      }
      badge={confidentialBadge}
      footnote="Reports are routed only to the pharmacovigilance team for safety review."
      error={error}
      submitting={submitting}
      submitLabel="Submit Report"
      onNext={handleNext}
      onSubmit={handleSubmit}
    >
      {step === 1 && <Step1PatientInfo payload={payload} onChange={setPayload} />}
      {step === 2 && <Step2Reactions payload={payload} onChange={setPayload} />}
      {step === 3 && <Step3Medicines payload={payload} onChange={setPayload} />}
      {step === 4 && <Step4Additional payload={payload} onChange={setPayload} />}
    </FormWizard>
  );
}
