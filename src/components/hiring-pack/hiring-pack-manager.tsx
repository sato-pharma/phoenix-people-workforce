"use client";

// The fill screen for the hiring pack — the one place HR types what the contract and Form 1 ask
// for, and then prints them ready to sign.
//
// WHAT THIS SCREEN DELIBERATELY WILL NOT LET YOU EDIT. Everything Phoenix already knows — Arabic
// name, national ID, insurance number, salary, hire date — is shown read-only, because those values
// belong to the employee record. A second editable copy here would start disagreeing with it within
// a week, and then nobody would know which one the contract was printed from. A wrong name is fixed
// on the employee, and the next print picks the fix up.
//
// The design identity is taken from the hiring documents tracker next door — same rounded shell,
// same field labels, same button sizes. The two screens are one workflow seen from two ends: this
// one produces the paper, that one tracks the paper coming back.

import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  FileSignature,
  FileText,
  Loader2,
  Printer,
  Save,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { systemContractDefaults } from "@/config/system-settings";
import type {
  HiringPackCandidate,
  HiringPackData,
  HiringPackDocument,
  HiringPackGap,
  HiringPackProfileInput,
} from "@/lib/hiring-pack/types";
import { cn } from "@/lib/utils";

const inputClassName =
  "h-10 rounded-xl border-phx-line bg-white/95 text-sm shadow-sm focus:border-phx-accent-line focus:ring-phx-accent/15";
const labelClassName =
  "mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";
const factLabelClassName =
  "text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint";

type FieldKind = "text" | "code" | "number" | "date";

type FieldDef = {
  key: keyof HiringPackProfileInput;
  labelEn: string;
  labelAr: string;
  kind: FieldKind;
  /** Sits under the input. Used where typing the wrong KIND of value is the likely mistake. */
  hint?: string;
  maxLength?: number;
};

/** Values both documents ask for. */
const IDENTITY_FIELDS: readonly FieldDef[] = [
  { key: "nationality", labelEn: "Nationality", labelAr: "الجنسية", kind: "text" },
  { key: "qualification", labelEn: "Qualification", labelAr: "المؤهل", kind: "text" },
  { key: "birthPlace", labelEn: "Place of birth", labelAr: "محل الميلاد", kind: "text" },
  { key: "jobTitleAr", labelEn: "Job title (Arabic)", labelAr: "المسمى الوظيفي", kind: "text" },
];

/**
 * Form 1 only. Four of these are BOXED CODE FIELDS on the government form — two or three printed
 * cells that hold a number, not a name — so they are labelled as codes and length-capped here. The
 * form has no room for "القاهرة" and will not grow one.
 */
const FORM1_FIELDS: readonly FieldDef[] = [
  {
    key: "insuranceOffice",
    labelEn: "Insurance office",
    labelAr: "مكتب التأمينات",
    kind: "text",
    hint: "The NOSI branch office holding the file.",
  },
  {
    key: "occupationCode",
    labelEn: "Occupation code",
    labelAr: "كود المهنة",
    kind: "code",
    hint: "Six digits, printed across two groups of three.",
    maxLength: 6,
  },
  {
    key: "addressBuilding",
    labelEn: "Building no.",
    labelAr: "عقار رقم",
    kind: "code",
    maxLength: 4,
  },
  { key: "addressStreet", labelEn: "Street", labelAr: "شارع / حارة", kind: "text" },
  {
    key: "addressDistrict",
    labelEn: "Sheyakha / village code",
    labelAr: "شياخة / قرية",
    kind: "code",
    hint: "Two digits — the form prints boxes, not a name.",
    maxLength: 2,
  },
  {
    key: "addressMarkaz",
    labelEn: "Qism / markaz code",
    labelAr: "قسم / مركز",
    kind: "code",
    hint: "Two digits — a different grid from شياخة / قرية above.",
    maxLength: 2,
  },
  {
    key: "addressGovernorate",
    labelEn: "Governorate code",
    labelAr: "محافظة",
    kind: "code",
    hint: "Two digits — the form prints boxes, not a name.",
    maxLength: 2,
  },
];

/**
 * Contract terms. Every one of these already has a company default in `systemContractDefaults`, so
 * they are left blank unless this particular hire differs — an empty box means "the standard term",
 * which is what the printed contract will then say.
 */
const TERM_FIELDS: readonly FieldDef[] = [
  {
    key: "contractStartDate",
    labelEn: "Contract start",
    labelAr: "تاريخ بدء العقد",
    kind: "date",
    hint: "Blank uses the hire date.",
  },
  {
    key: "contractEndDate",
    labelEn: "Contract end",
    labelAr: "تاريخ انتهاء العقد",
    kind: "date",
    hint: "Blank is calculated from the duration.",
  },
  {
    key: "contractDurationMonths",
    labelEn: "Duration (months)",
    labelAr: "مدة العقد بالشهور",
    kind: "number",
  },
  {
    key: "underperformanceThresholdPct",
    labelEn: "Underperformance %",
    labelAr: "نسبة الإنجاز",
    kind: "number",
  },
  {
    key: "underperformanceMonths",
    labelEn: "Underperformance months",
    labelAr: "عدد الشهور",
    kind: "number",
  },
  {
    key: "trainingBondMonths",
    labelEn: "Training bond (months)",
    labelAr: "مدة الالتزام بعد التدريب",
    kind: "number",
  },
];

const NUMBER_KEYS = new Set<keyof HiringPackProfileInput>([
  "contractDurationMonths",
  "underperformanceThresholdPct",
  "underperformanceMonths",
  "trainingBondMonths",
]);

const ALL_FIELDS: readonly FieldDef[] = [...IDENTITY_FIELDS, ...FORM1_FIELDS, ...TERM_FIELDS];

type FormState = Record<string, string>;

function emptyForm(): FormState {
  const state: FormState = { notes: "" };
  for (const field of ALL_FIELDS) state[field.key] = "";
  return state;
}

function formFromPack(pack: HiringPackData): FormState {
  const state = emptyForm();
  for (const field of ALL_FIELDS) {
    const value = pack.profile[field.key];
    state[field.key] = value === null || value === undefined ? "" : String(value);
  }
  state.notes = pack.profile.notes ?? "";
  return state;
}

function payloadFromForm(state: FormState): HiringPackProfileInput {
  const payload: Record<string, string | number | null> = {};
  for (const field of ALL_FIELDS) {
    const raw = (state[field.key] ?? "").trim();
    if (!raw) {
      payload[field.key] = null;
      continue;
    }
    if (NUMBER_KEYS.has(field.key)) {
      const parsed = Number(raw);
      // A number field holding something unparseable is stored as nothing rather than as NaN, which
      // would otherwise reach the contract as the literal text "NaN months".
      payload[field.key] = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    payload[field.key] = raw;
  }
  payload.notes = state.notes.trim() ? state.notes.trim() : null;
  return payload as HiringPackProfileInput;
}

/** A stored date, shown the way the owner reads dates. */
function formatDate(iso: string | null): string {
  if (!iso) return "Not recorded";
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
}

/** A stored timestamp, in Cairo local time — never raw UTC. */
function formatStamp(iso: string | null): string {
  if (!iso) return "Not printed yet";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

/**
 * Today, in Cairo.
 *
 * Computed on demand rather than at render, so the server and the browser never disagree about what
 * day it is during hydration — and read in Cairo rather than off the machine's clock, because a
 * signature recorded at 1am from a laptop left on UTC would otherwise be dated to yesterday.
 */
function todayInCairo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
}

function candidateLabel(candidate: HiringPackCandidate): string {
  const parts = [candidate.hrId, candidate.fullName];
  if (candidate.nameAr) parts.push(candidate.nameAr);
  if (candidate.jobTitle) parts.push(candidate.jobTitle);
  return parts.join(" · ");
}

function gapsFor(gaps: HiringPackGap[], document: HiringPackDocument): HiringPackGap[] {
  return gaps.filter((gap) => gap.document === document || gap.document === "both");
}

type Props = {
  canManage: boolean;
  candidates: HiringPackCandidate[];
  initialError: string | null;
  initialPack: HiringPackData | null;
};

export function HiringPackManager({ canManage, candidates, initialError, initialPack }: Props) {
  const [pack, setPack] = useState<HiringPackData | null>(initialPack);
  const [selectedHrId, setSelectedHrId] = useState(initialPack?.employee.hrId ?? "");
  const [form, setForm] = useState<FormState>(initialPack ? formFromPack(initialPack) : emptyForm());
  const [contractCopies, setContractCopies] = useState(
    String(systemContractDefaults.contractCopies),
  );
  const [form1Copies, setForm1Copies] = useState(String(systemContractDefaults.form1Copies));
  const [signDates, setSignDates] = useState<Record<HiringPackDocument, string>>({
    contract: initialPack?.profile.contractSignedDate ?? "",
    form1: initialPack?.profile.form1SignedDate ?? "",
  });
  const [busy, setBusy] = useState<"" | "load" | "save" | "sign-contract" | "sign-form1">("");
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);

  const blockingGaps = useMemo(() => (pack?.gaps ?? []).filter((gap) => gap.blocking), [pack]);
  const advisoryGaps = useMemo(() => (pack?.gaps ?? []).filter((gap) => !gap.blocking), [pack]);

  const applyPack = useCallback((next: HiringPackData) => {
    setPack(next);
    setForm(formFromPack(next));
    setSignDates({
      contract: next.profile.contractSignedDate ?? "",
      form1: next.profile.form1SignedDate ?? "",
    });
  }, []);

  const readError = useCallback(async (response: Response) => {
    try {
      const body = (await response.json()) as { message?: string };
      return body.message ?? `Request failed (${response.status}).`;
    } catch {
      return `Request failed (${response.status}).`;
    }
  }, []);

  const selectEmployee = useCallback(
    async (hrId: string) => {
      setSelectedHrId(hrId);
      setNotice(null);
      setError(null);
      if (!hrId) {
        setPack(null);
        setForm(emptyForm());
        return;
      }
      setBusy("load");
      try {
        const response = await fetch(`/api/hiring-pack/${encodeURIComponent(hrId)}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          setPack(null);
          setError(await readError(response));
          return;
        }
        applyPack((await response.json()) as HiringPackData);
      } catch (cause) {
        setPack(null);
        setError(cause instanceof Error ? cause.message : "Could not load this employee.");
      } finally {
        setBusy("");
      }
    },
    [applyPack, readError],
  );

  const save = useCallback(async () => {
    if (!pack) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/hiring-pack/${encodeURIComponent(pack.employee.hrId)}`, {
        body: JSON.stringify(payloadFromForm(form)),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      applyPack((await response.json()) as HiringPackData);
      setNotice("Saved. The documents will print with these values.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy("");
    }
  }, [applyPack, form, pack, readError]);

  const recordSignature = useCallback(
    async (document: HiringPackDocument) => {
      if (!pack) return;
      const signedDate = signDates[document];
      if (!signedDate) {
        setError("Enter the date written on the signed paper first.");
        return;
      }
      setBusy(document === "contract" ? "sign-contract" : "sign-form1");
      setError(null);
      setNotice(null);
      try {
        const response = await fetch(
          `/api/hiring-pack/${encodeURIComponent(pack.employee.hrId)}/sign`,
          {
            body: JSON.stringify({ document, signedDate }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        if (!response.ok) {
          setError(await readError(response));
          return;
        }
        applyPack((await response.json()) as HiringPackData);
        setNotice(
          document === "contract"
            ? `Contract recorded as signed on ${formatDate(signedDate)}.`
            : `Form 1 recorded as signed on ${formatDate(signedDate)}.`,
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not record the signature.");
      } finally {
        setBusy("");
      }
    },
    [applyPack, pack, readError, signDates],
  );

  /**
   * Printing opens the rendered document in its own tab, where the browser's own print dialog does
   * the rest. That is on purpose: the browser is the only thing in the stack that lays Arabic out
   * correctly, and "Print → Save as PDF" from that tab produces a real PDF with selectable text.
   */
  const openPrint = useCallback(
    (document: HiringPackDocument, copies: string) => {
      if (!pack) return;
      const requested = Number.parseInt(copies, 10);
      const fallback =
        document === "contract"
          ? systemContractDefaults.contractCopies
          : systemContractDefaults.form1Copies;
      const count =
        Number.isFinite(requested) && requested >= 1 ? Math.min(requested, 20) : fallback;
      const url = `/api/hiring-pack/${encodeURIComponent(pack.employee.hrId)}/print?document=${document}&copies=${count}`;
      window.open(url, "_blank", "noopener,noreferrer");
    },
    [pack],
  );

  const employee = pack?.employee ?? null;
  const facts: { label: string; value: string }[] = employee
    ? [
        { label: "HR ID", value: employee.hrId },
        { label: "Name", value: employee.fullName },
        { label: "الاسم بالعربية", value: employee.nameAr ?? "Missing" },
        { label: "National ID", value: employee.nationalId ?? "Missing" },
        { label: "Insurance no.", value: employee.socialInsuranceNumber ?? "Missing" },
        { label: "Date of birth", value: formatDate(employee.birthDate) },
        { label: "Hire date", value: formatDate(employee.hireDate) },
        { label: "Job title", value: employee.jobTitle ?? "Missing" },
        { label: "Department", value: employee.departmentAr ?? "Missing" },
        {
          label: "Gross salary",
          value:
            employee.grossSalary === null
              ? "Missing"
              : `${employee.grossSalary.toLocaleString("en-US")} EGP`,
        },
        {
          label: "Insurance wage",
          value:
            employee.socialInsuranceWage === null
              ? "Missing"
              : `${employee.socialInsuranceWage.toLocaleString("en-US")} EGP`,
        },
        { label: "Mobile", value: employee.mobileNumber ?? "Missing" },
        { label: "Work email", value: employee.workEmail ?? "Missing" },
        { label: "Address", value: employee.residenceAddress ?? "Missing" },
      ]
    : [];

  return (
    <div className="relative overflow-hidden rounded-[34px] border border-phx-line bg-phx-paper p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div className="flex flex-col gap-5">
        <AdminPageHero
          badges={
            <>
              <AdminInsightChip tone="orange">{candidates.length} employees</AdminInsightChip>
              <AdminInsightChip>
                Contract · {systemContractDefaults.contractCopies} copies
              </AdminInsightChip>
              <AdminInsightChip>
                Form 1 · {systemContractDefaults.form1Copies} copies, duplex
              </AdminInsightChip>
            </>
          }
          description="Fill the employment contract and social-insurance Form 1 from the employee record, print them ready to sign, and record the date they were signed."
          eyebrow="Onboarding"
          icon={<FileSignature className="h-5 w-5" />}
          title="Contract & Form 1"
        />

        {error ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </AdminCallout>
        ) : null}
        {notice ? (
          <AdminCallout tone="success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{notice}</span>
          </AdminCallout>
        ) : null}

        <AdminTableShell
          description="Newest hires first. Resigned staff are not listed."
          title="Choose the employee"
        >
          <div className="px-5 py-5 sm:px-6">
            <label className={labelClassName} htmlFor="hiring-pack-employee">
              Employee
            </label>
            <SearchableSelect
              className={cn(inputClassName, "w-full max-w-2xl")}
              disabled={busy === "load"}
              id="hiring-pack-employee"
              onValueChange={(value) => void selectEmployee(value)}
              placeholder="Search by HR ID, name, or job title"
              value={selectedHrId}
            >
              <option value="">Select an employee</option>
              {candidates.map((candidate) => (
                <option key={candidate.hrId} value={candidate.hrId}>
                  {candidateLabel(candidate)}
                </option>
              ))}
            </SearchableSelect>
            {busy === "load" ? (
              <p className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-phx-ink-soft">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading the pack…
              </p>
            ) : null}
          </div>
        </AdminTableShell>

        {pack && employee ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <AdminStatCard
                description={
                  pack.profile.contractSignedDate
                    ? formatDate(pack.profile.contractSignedDate)
                    : "Not signed yet"
                }
                icon={<FileText className="h-5 w-5" />}
                label="Contract"
                tone={pack.profile.contractSignedDate ? "emerald" : "orange"}
                value={pack.profile.contractSignedDate ? "Signed" : "Pending"}
              />
              <AdminStatCard
                description={
                  pack.profile.form1SignedDate
                    ? formatDate(pack.profile.form1SignedDate)
                    : "Not signed yet"
                }
                icon={<ShieldCheck className="h-5 w-5" />}
                label="Form 1"
                tone={pack.profile.form1SignedDate ? "emerald" : "orange"}
                value={pack.profile.form1SignedDate ? "Signed" : "Pending"}
              />
              <AdminStatCard
                description="Values the document cannot be handed over without."
                icon={<AlertTriangle className="h-5 w-5" />}
                label="Blocking gaps"
                tone={blockingGaps.length > 0 ? "rose" : "emerald"}
                value={blockingGaps.length}
              />
              <AdminStatCard
                description="Prints without them, but they are still missing."
                icon={<CalendarCheck className="h-5 w-5" />}
                label="To fill later"
                tone="blue"
                value={advisoryGaps.length}
              />
            </div>

            {blockingGaps.length > 0 ? (
              <AdminCallout tone="warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="flex flex-col gap-2">
                  <p className="font-bold">
                    {blockingGaps.length} value{blockingGaps.length === 1 ? "" : "s"} the documents
                    ask for are still missing. Both will still print — the blanks stay blank rather
                    than being guessed.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {blockingGaps.map((gap) => (
                      <Badge key={gap.field} variant="danger">
                        {gap.labelEn} · {gap.labelAr}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs font-semibold text-amber-800">
                    Employee-record gaps are fixed on the employee. Company-settings gaps are the
                    company&apos;s own registration numbers, and are missing for every employee
                    until they are supplied once.
                  </p>
                </div>
              </AdminCallout>
            ) : null}

            <AdminTableShell
              description="From the employee record. Change these on the employee, not here — the next print picks the change up."
              title={`What Phoenix already knows · ${employee.fullName}`}
            >
              <div className="grid gap-3 px-5 py-5 sm:grid-cols-2 sm:px-6 xl:grid-cols-3">
                {facts.map((fact) => (
                  <div
                    className="rounded-xl border border-phx-line bg-white/95 px-3.5 py-2.5 shadow-sm"
                    key={fact.label}
                  >
                    <span className={factLabelClassName}>{fact.label}</span>
                    <p
                      className={cn(
                        "mt-1 text-sm font-bold",
                        fact.value === "Missing" ? "text-rose-600" : "text-phx-ink",
                      )}
                      dir="auto"
                    >
                      {fact.value}
                    </p>
                  </div>
                ))}
              </div>
            </AdminTableShell>

            <AdminTableShell
              action={
                canManage ? (
                  <Button
                    className="h-11 gap-2 rounded-2xl"
                    disabled={busy === "save"}
                    onClick={() => void save()}
                  >
                    {busy === "save" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Save
                  </Button>
                ) : undefined
              }
              description="Everything the two documents ask for that the employee record cannot answer."
              title="What you fill in"
            >
              <div className="flex flex-col gap-6 px-5 py-5 sm:px-6">
                <FieldGroup
                  disabled={!canManage}
                  fields={IDENTITY_FIELDS}
                  form={form}
                  onChange={setForm}
                  subtitle="Printed on both documents."
                  title="Identity and job"
                />
                <FieldGroup
                  disabled={!canManage}
                  fields={FORM1_FIELDS}
                  form={form}
                  onChange={setForm}
                  subtitle="Printed on Form 1 only. The code fields are boxes on the government form and hold numbers."
                  title="Form 1 details"
                />
                <FieldGroup
                  disabled={!canManage}
                  fields={TERM_FIELDS}
                  form={form}
                  onChange={setForm}
                  subtitle={`Blank uses the standard term — ${pack.terms.durationMonths} months, ${pack.terms.probationMonths}-month probation, ${pack.terms.underperformanceThresholdPct}% over ${pack.terms.underperformanceMonths} months, ${pack.terms.trainingBondMonths}-month training bond.`}
                  title="Contract terms"
                />
                <div>
                  <label className={labelClassName} htmlFor="hiring-pack-notes">
                    Notes <span className="text-phx-ink-faint">ملاحظات</span>
                  </label>
                  <textarea
                    className={cn(inputClassName, "h-24 w-full resize-y px-3 py-2 leading-relaxed")}
                    disabled={!canManage}
                    id="hiring-pack-notes"
                    onChange={(event) =>
                      setForm((current) => ({ ...current, notes: event.target.value }))
                    }
                    placeholder="Internal only. Never printed on either document."
                    value={form.notes}
                  />
                </div>
              </div>
            </AdminTableShell>

            <div className="grid gap-3 lg:grid-cols-2">
              <DocumentCard
                busy={busy === "sign-contract"}
                canManage={canManage}
                copies={contractCopies}
                gaps={gapsFor(pack.gaps, "contract")}
                onCopiesChange={setContractCopies}
                onPrint={() => openPrint("contract", contractCopies)}
                onSign={() => void recordSignature("contract")}
                onSignDateChange={(value) =>
                  setSignDates((current) => ({ ...current, contract: value }))
                }
                printedAt={pack.profile.contractPrintedAt}
                printingNote="One page per sheet — single-sided. Five pages per copy, on A4."
                signDate={signDates.contract}
                signedDate={pack.profile.contractSignedDate}
                subtitle="عقد عمل محدد المدة"
                title="Employment contract"
              />
              <DocumentCard
                busy={busy === "sign-form1"}
                canManage={canManage}
                copies={form1Copies}
                gaps={gapsFor(pack.gaps, "form1")}
                onCopiesChange={setForm1Copies}
                onPrint={() => openPrint("form1", form1Copies)}
                onSign={() => void recordSignature("form1")}
                onSignDateChange={(value) =>
                  setSignDates((current) => ({ ...current, form1: value }))
                }
                printedAt={pack.profile.form1PrintedAt}
                printingNote="MUST be printed double-sided. Set the printer to two-sided, flip on the long edge, US Legal paper."
                signDate={signDates.form1}
                signedDate={pack.profile.form1SignedDate}
                subtitle="نموذج ١ — طلب اشتراك مؤمن عليه"
                title="Social insurance Form 1"
              />
            </div>
          </>
        ) : (
          <AdminCallout>
            <UserRound className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Choose an employee above to fill and print the hiring pack.</span>
          </AdminCallout>
        )}
      </div>
    </div>
  );
}

function FieldGroup({
  disabled,
  fields,
  form,
  onChange,
  subtitle,
  title,
}: {
  disabled: boolean;
  fields: readonly FieldDef[];
  form: FormState;
  onChange: (updater: (current: FormState) => FormState) => void;
  subtitle: string;
  title: string;
}) {
  return (
    <div>
      <div className="mb-3">
        <h3 className="text-sm font-black uppercase tracking-[0.1em] text-phx-ink">{title}</h3>
        <p className="mt-0.5 text-xs font-semibold text-phx-ink-soft">{subtitle}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {fields.map((field) => (
          <div key={field.key}>
            <label className={labelClassName} htmlFor={`hiring-pack-${field.key}`}>
              {field.labelEn} <span className="text-phx-ink-faint">{field.labelAr}</span>
            </label>
            <Input
              className={inputClassName}
              disabled={disabled}
              id={`hiring-pack-${field.key}`}
              inputMode={field.kind === "code" || field.kind === "number" ? "numeric" : undefined}
              maxLength={field.maxLength}
              onChange={(event) =>
                onChange((current) => ({ ...current, [field.key]: event.target.value }))
              }
              type={field.kind === "date" ? "date" : field.kind === "number" ? "number" : "text"}
              value={form[field.key] ?? ""}
            />
            {field.hint ? (
              <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">{field.hint}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function DocumentCard({
  busy,
  canManage,
  copies,
  gaps,
  onCopiesChange,
  onPrint,
  onSign,
  onSignDateChange,
  printedAt,
  printingNote,
  signDate,
  signedDate,
  subtitle,
  title,
}: {
  busy: boolean;
  canManage: boolean;
  copies: string;
  gaps: HiringPackGap[];
  onCopiesChange: (value: string) => void;
  onPrint: () => void;
  onSign: () => void;
  onSignDateChange: (value: string) => void;
  printedAt: string | null;
  printingNote: string;
  signDate: string;
  signedDate: string | null;
  subtitle: string;
  title: string;
}) {
  const blocking = gaps.filter((gap) => gap.blocking).length;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-");

  return (
    <AdminTableShell description={subtitle} title={title}>
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {signedDate ? (
            <Badge variant="success">Signed {formatDate(signedDate)}</Badge>
          ) : (
            <Badge variant="warning">Not signed</Badge>
          )}
          {blocking > 0 ? (
            <Badge variant="danger">{blocking} missing</Badge>
          ) : (
            <Badge variant="success">Complete</Badge>
          )}
          <span className="text-xs font-semibold text-phx-ink-soft">
            Last printed: {formatStamp(printedAt)}
          </span>
        </div>

        <p className="rounded-xl border border-phx-line bg-phx-paper px-3.5 py-2.5 text-xs font-bold text-phx-ink-2">
          {printingNote}
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelClassName} htmlFor={`hiring-pack-copies-${slug}`}>
              Copies
            </label>
            <Input
              className={cn(inputClassName, "w-24")}
              id={`hiring-pack-copies-${slug}`}
              inputMode="numeric"
              max={20}
              min={1}
              onChange={(event) => onCopiesChange(event.target.value)}
              type="number"
              value={copies}
            />
          </div>
          <Button className="h-11 gap-2 rounded-2xl" onClick={onPrint}>
            <Printer className="h-4 w-4" />
            Print
          </Button>
        </div>

        {canManage ? (
          <div className="flex flex-wrap items-end gap-3 border-t border-phx-line pt-4">
            <div>
              <label className={labelClassName} htmlFor={`hiring-pack-signed-${slug}`}>
                Date signed
              </label>
              <Input
                className={cn(inputClassName, "w-44")}
                id={`hiring-pack-signed-${slug}`}
                onChange={(event) => onSignDateChange(event.target.value)}
                type="date"
                value={signDate}
              />
            </div>
            <Button
              className="h-10 rounded-xl"
              onClick={() => onSignDateChange(todayInCairo())}
              type="button"
              variant="outline"
            >
              Today
            </Button>
            <Button className="h-11 gap-2 rounded-2xl" disabled={busy} onClick={onSign}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileSignature className="h-4 w-4" />
              )}
              {signedDate ? "Update signature date" : "Record signature"}
            </Button>
          </div>
        ) : null}
      </div>
    </AdminTableShell>
  );
}
