"use client";

import { useState, useCallback } from "react";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Plus, ShieldCheck, Trash2 } from "lucide-react";
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

// ─── Premium field primitives (square corners, slate + orange) ───────────────

const fieldClass =
  "h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:cursor-not-allowed disabled:opacity-50";
const selectClass = `${fieldClass} cursor-pointer`;
const textareaClass =
  "w-full resize-y border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20";

const btnGhost =
  "inline-flex items-center gap-1.5 border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40";
const btnDark =
  "inline-flex items-center gap-1.5 border border-slate-900 bg-slate-900 px-5 py-2 text-sm font-bold text-white transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50";
const btnOrange =
  "inline-flex items-center gap-1.5 border border-orange-600 bg-orange-600 px-5 py-2 text-sm font-bold text-white transition hover:bg-orange-700 disabled:pointer-events-none disabled:opacity-50";
const btnAddBlock =
  "flex w-full items-center justify-center gap-1.5 border border-dashed border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:border-orange-500 hover:text-orange-600";

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wide text-slate-500">
      {children}
      {required && <span className="ml-0.5 text-rose-600">*</span>}
    </label>
  );
}

function CheckTile({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={[
        "flex cursor-pointer select-none items-center gap-2.5 border px-3 py-2.5 text-sm font-semibold transition",
        checked
          ? "border-orange-500 bg-orange-50 text-slate-900"
          : "border-slate-200 bg-white text-slate-600 hover:border-slate-400",
      ].join(" ")}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-orange-600"
      />
      {children}
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

// Dark block header used by repeating reaction/medicine cards.
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
    <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5">
      <span className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wide text-slate-700">
        <span aria-hidden className="h-3.5 w-1 bg-orange-500" />
        {label}
      </span>
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="p-1 text-slate-400 transition hover:text-rose-600"
          aria-label={`Remove ${label}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3">
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3">
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
            <p className="mb-2 text-[11px] font-black uppercase tracking-wide text-rose-700">
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3">
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

function ConfirmationScreen({ reportNumber, onReset, onViewReports }: { reportNumber: string; onReset: () => void; onViewReports?: () => void }) {
  return (
    <div className="mx-auto max-w-xl border border-slate-200 bg-white shadow-sm">
      <div className="relative overflow-hidden bg-slate-900 px-6 py-9 text-center">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-12 -top-12 h-48 w-48 rounded-full bg-orange-500/10 blur-2xl"
        />
        <div className="relative">
          <div className="mx-auto flex h-16 w-16 items-center justify-center bg-orange-600">
            <CheckCircle2 className="h-9 w-9 text-white" />
          </div>
          <p className="mt-5 text-[11px] font-black uppercase tracking-[0.25em] text-orange-400">Pharmacovigilance</p>
          <h2 className="mt-1 text-2xl font-black text-white">Report Submitted</h2>
        </div>
      </div>
      <div className="space-y-5 px-6 py-7 text-center">
        <p className="text-sm text-slate-600">
          Your adverse drug reaction report has been submitted to the pharmacovigilance team.
        </p>
        <div className="inline-block border border-slate-900 bg-slate-900 px-7 py-3.5">
          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-orange-300">Report Number</p>
          <p className="mt-1 font-mono text-xl font-black tracking-wide text-white">{reportNumber}</p>
        </div>
        <p className="text-xs font-semibold text-slate-500">
          Please keep this reference number for your records.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {onViewReports && (
            <button type="button" className={btnDark} onClick={onViewReports}>
              View My Reports
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

const STEPS = ["Patient Info", "Reactions", "Medicines", "Additional Info"];
const STEP_TITLES = ["Patient Information", "Reactions / Symptoms", "Medicines", "Additional Information"];
const STEP_DESCRIPTIONS = [
  "Who the report is about",
  "Symptoms and seriousness",
  "Suspected products",
  "Context and comments",
];

// ─── Vertical stepper rail (desktop) ───────────────────────────────────────────

function VerticalStepper({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  return (
    <ol className="relative">
      {STEPS.map((label, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        const clickable = num < step;
        const last = i === STEPS.length - 1;
        return (
          <li key={label} className="relative">
            {!last && (
              <span
                aria-hidden
                className={["absolute left-[15px] top-8 h-[calc(100%-1rem)] w-px", done ? "bg-orange-400" : "bg-slate-200"].join(" ")}
              />
            )}
            <button
              type="button"
              onClick={() => clickable && onJump(num)}
              disabled={!clickable}
              className={[
                "group relative flex w-full items-start gap-3 px-3 py-3 text-left transition",
                active ? "bg-orange-50" : "bg-transparent",
                clickable ? "cursor-pointer hover:bg-slate-50" : "cursor-default",
              ].join(" ")}
            >
              {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-orange-500" />}
              <span
                className={[
                  "z-10 flex h-8 w-8 shrink-0 items-center justify-center text-xs font-black",
                  active
                    ? "bg-orange-600 text-white"
                    : done
                      ? "bg-orange-100 text-orange-700"
                      : "border border-slate-300 bg-white text-slate-400",
                ].join(" ")}
              >
                {done ? <Check className="h-4 w-4" /> : num}
              </span>
              <span className="min-w-0">
                <span
                  className={[
                    "block text-[11px] font-black uppercase tracking-wide",
                    active ? "text-slate-900" : done ? "text-slate-700" : "text-slate-400",
                  ].join(" ")}
                >
                  {label}
                </span>
                <span className="mt-0.5 block text-xs text-slate-400">{STEP_DESCRIPTIONS[i]}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ─── Compact horizontal stepper (mobile) ───────────────────────────────────────

function MobileStepper({ step }: { step: number }) {
  return (
    <div className="flex items-center lg:hidden">
      {STEPS.map((label, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        return (
          <div key={label} className={["flex items-center", i < STEPS.length - 1 ? "flex-1" : ""].join(" ")}>
            <span
              className={[
                "flex h-7 w-7 shrink-0 items-center justify-center text-[11px] font-black",
                active ? "bg-orange-600 text-white" : done ? "bg-orange-100 text-orange-700" : "border border-slate-300 bg-white text-slate-400",
              ].join(" ")}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : num}
            </span>
            {i < STEPS.length - 1 && (
              <span className={["mx-1.5 h-px flex-1", done ? "bg-orange-400" : "bg-slate-200"].join(" ")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ReportItForm({ onSubmitSuccess }: { onSubmitSuccess?: () => void } = {}) {
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

  // Rail navigation: jump back only to an already-completed step (never skip
  // forward past validation).
  const handleJump = useCallback((target: number) => {
    setStep((s) => {
      if (target < s) {
        setError(null);
        return target;
      }
      return s;
    });
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

  const pct = Math.round((step / STEPS.length) * 100);

  return (
    <div className="border border-slate-200 bg-white shadow-sm">
      {/* ── Premium dark hero ── */}
      <div className="relative overflow-hidden bg-slate-900 px-5 py-6 sm:px-8 sm:py-7">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-orange-500/10 blur-2xl"
        />
        <div className="relative flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-black uppercase tracking-[0.25em] text-orange-400">Pharmacovigilance</p>
            <h1 className="mt-1 text-2xl font-black leading-none text-white">Report It</h1>
            <p className="mt-2 max-w-xl text-sm text-slate-300">
              Report an adverse drug reaction in a safe, confidential way. Fields marked
              with <span className="font-bold text-orange-300">*</span> are required.
            </p>
          </div>
          <span className="hidden items-center gap-1.5 self-start border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-slate-200 sm:inline-flex">
            <ShieldCheck className="h-3.5 w-3.5 text-orange-400" />
            Confidential
          </span>
        </div>

        {/* progress */}
        <div className="relative mt-6">
          <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wide text-slate-400">
            <span>Step {step} of {STEPS.length}</span>
            <span className="text-orange-400">{pct}%</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full bg-white/10">
            <div className="h-full bg-orange-500 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      {/* ── Two-column console ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[244px_minmax(0,1fr)]">
        {/* Left rail — vertical stepper (desktop) */}
        <aside className="hidden border-r border-slate-200 bg-slate-50/60 lg:flex lg:flex-col">
          <nav className="p-3">
            <VerticalStepper step={step} onJump={handleJump} />
          </nav>
          <div className="mt-auto border-t border-slate-200 p-4">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
              <p className="text-xs leading-relaxed text-slate-500">
                Reports are routed only to the pharmacovigilance team for safety review.
              </p>
            </div>
          </div>
        </aside>

        {/* Right — step content */}
        <div className="p-4 sm:p-6">
          {/* mobile stepper */}
          <div className="mb-5 lg:hidden">
            <MobileStepper step={step} />
          </div>

          {/* step heading */}
          <div className="mb-5 flex items-center justify-between border-b border-slate-200 pb-4">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.25em] text-orange-600">
                Step {step} of {STEPS.length}
              </p>
              <h2 className="mt-0.5 text-lg font-black text-slate-900">{STEP_TITLES[step - 1]}</h2>
            </div>
            <span className="select-none text-4xl font-black tabular-nums text-slate-200" aria-hidden>
              {String(step).padStart(2, "0")}
            </span>
          </div>

          {step === 1 && <Step1PatientInfo payload={payload} onChange={setPayload} />}
          {step === 2 && <Step2Reactions payload={payload} onChange={setPayload} />}
          {step === 3 && <Step3Medicines payload={payload} onChange={setPayload} />}
          {step === 4 && <Step4Additional payload={payload} onChange={setPayload} />}

          {/* Error */}
          {error && (
            <p className="mt-5 border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">
              {error}
            </p>
          )}

          {/* Navigation */}
          <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-5">
            <button type="button" className={btnGhost} onClick={handleBack} disabled={step === 1}>
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            {step < STEPS.length ? (
              <button type="button" className={btnDark} onClick={handleNext}>
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            ) : (
              <button type="button" className={btnOrange} onClick={handleSubmit} disabled={submitting}>
                {submitting ? "Submitting…" : "Submit Report"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
