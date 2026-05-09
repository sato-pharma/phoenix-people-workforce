"use client";

import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Copy,
  Mail,
  RefreshCw,
  Send,
  UserCheck,
  XCircle,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  OfferDashboardData,
  OfferLifecycleRow,
  OfferLookupData,
  OfferStatus,
} from "@/lib/offers/service";
import { offerTemplates } from "@/lib/offers/templates";
import { cn } from "@/lib/utils";

type Props = {
  initialData?: OfferDashboardData | null;
  initialError?: string | null;
  lookups?: OfferLookupData | null;
};

type OfferForm = {
  candidateEmail: string;
  candidateName: string;
  candidatePhone: string;
  areaScope: string;
  areaId: string;
  departmentId: string;
  expiresInDays: string;
  lineId: string;
  managerHrId: string;
  positionId: string;
  startDate: string;
  templateKey: string;
};

const emptyForm: OfferForm = {
  areaId: "",
  areaScope: "",
  candidateEmail: "",
  candidateName: "",
  candidatePhone: "",
  departmentId: "",
  expiresInDays: "7",
  lineId: "",
  managerHrId: "",
  positionId: "",
  startDate: "",
  templateKey: "medical_sales_representative",
};

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatMoney(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

function formatPercent(value: number) {
  return `${Math.round((Number.isFinite(value) ? value : 0) * 100)}%`;
}

function statusVariant(status: OfferStatus) {
  if (status === "accepted") return "success" as const;
  if (status === "sent") return "warning" as const;
  if (status === "rejected" || status === "expired") return "danger" as const;
  return "neutral" as const;
}

function statusLabel(status: OfferStatus) {
  return status.replace(/_/g, " ");
}

function SummaryCard({
  icon,
  label,
  tone,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "blue" | "emerald" | "orange" | "rose";
  value: string;
}) {
  const tones = {
    blue: "bg-sky-50 text-sky-800 border-sky-100",
    emerald: "bg-emerald-50 text-emerald-800 border-emerald-100",
    orange: "bg-orange-50 text-orange-800 border-orange-100",
    rose: "bg-rose-50 text-rose-800 border-rose-100",
  };

  return (
    <div className={cn("rounded-xl border p-4", tones[tone])}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] opacity-70">{label}</p>
        <span className="shrink-0">{icon}</span>
      </div>
      <p className="mt-2 font-mono text-2xl font-black">{value}</p>
    </div>
  );
}

function Field({
  label,
  onChange,
  placeholder,
  required,
  type = "text",
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: string;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">{label}</span>
      <Input
        className="bg-white"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        type={type}
        value={value}
      />
    </label>
  );
}

function SelectField({
  disabled,
  label,
  onChange,
  options,
  placeholder,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-text-secondary">{label}</span>
      <select
        className="h-10 w-full rounded-lg border border-border bg-white px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:bg-slate-50 disabled:text-slate-400"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">{placeholder ?? `Select ${label.toLowerCase()}`}</option>
        {options.map((option) => (
          <option key={`${option.value}-${option.label}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function OfferRow({
  approving,
  offer,
  onApprove,
}: {
  approving: boolean;
  offer: OfferLifecycleRow;
  onApprove: (offer: OfferLifecycleRow) => void;
}) {
  const canApprove = offer.status === "accepted" && offer.onboardingStatus !== "approved_hired";

  return (
    <tr className="border-b border-[#E2E8F0] last:border-0">
      <td className="px-4 py-3">
        <div className="font-semibold text-text">{offer.candidateName}</div>
        <div className="mt-1 text-xs text-text-secondary">{offer.candidateEmail}</div>
      </td>
      <td className="px-4 py-3">
        <div className="font-medium text-text">{offer.jobTitle}</div>
        <div className="mt-1 text-xs text-text-secondary">{offer.departmentName ?? offer.lineName ?? "Unassigned"}</div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={statusVariant(offer.status)}>{statusLabel(offer.status)}</Badge>
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary">{formatMoney(offer.salaryAmount)}</td>
      <td className="px-4 py-3 text-sm text-text-secondary">{formatDate(offer.expiresAt)}</td>
      <td className="px-4 py-3 text-sm text-text-secondary">
        {offer.status === "accepted" ? "Hired pipeline" : offer.onboardingStatus.replace(/_/g, " ")}
      </td>
      <td className="px-4 py-3">
        {canApprove ? (
          <Button className="h-8 gap-2 px-3 text-xs" disabled={approving} onClick={() => onApprove(offer)}>
            {approving ? <LoadingSpinner /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Approve hire
          </Button>
        ) : (
          <span className="text-xs font-medium text-text-secondary">
            {offer.onboardingStatus === "approved_hired" ? "Approved" : "-"}
          </span>
        )}
      </td>
    </tr>
  );
}

export function OfferLifecycleDashboard({
  initialData = null,
  initialError = null,
  lookups: initialLookups = null,
}: Props) {
  const [data, setData] = React.useState<OfferDashboardData | null>(initialData);
  const [error, setError] = React.useState<string | null>(initialError);
  const [form, setForm] = React.useState<OfferForm>(emptyForm);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isModalOpen, setIsModalOpen] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [approvingId, setApprovingId] = React.useState<string | null>(null);
  const [createdLinks, setCreatedLinks] = React.useState<{ acceptUrl: string; rejectUrl: string } | null>(null);
  const [emailStatus, setEmailStatus] = React.useState<string | null>(null);

  const rows = data?.rows ?? [];
  const lookups = data?.lookups ?? initialLookups;
  const selectedTemplate = offerTemplates.find((template) => template.value === form.templateKey) ?? null;

  // Derived values for Medical Rep vacancies
  const medicalRepVacancies = lookups?.medicalRepVacancies ?? [];
  const isMedicalRep =
    form.templateKey === "medical_sales_representative" ||
    (selectedTemplate?.label ?? "").includes("Medical Representative");

  const vacantLines = React.useMemo(() => {
    const linesMap = new Map<string, string>();
    medicalRepVacancies.forEach((v) => {
      if (v.lineId && v.lineName) {
        linesMap.set(String(v.lineId), v.lineName);
      }
    });
    return Array.from(linesMap.entries())
      .map(([value, label]) => ({ label, value }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [medicalRepVacancies]);

  const filteredVacantAreas = React.useMemo(() => {
    return medicalRepVacancies.filter(
      (vacancy) => String(vacancy.lineId) === String(form.lineId),
    );
  }, [medicalRepVacancies, form.lineId]);

  // Debugging in development
   React.useEffect(() => {
     if (process.env.NODE_ENV === "development") {
       console.log("medicalRepVacancies", medicalRepVacancies);
       console.log("selectedLineId", form.lineId);
       console.log("filteredVacantAreas", filteredVacantAreas);
       console.log("OFFER_UI_LOOKUPS", {
         medicalRepVacancies: lookups?.medicalRepVacancies?.length,
         formLineId: form.lineId,
         vacantLines,
         filteredVacantAreas,
       });
     }
   }, [medicalRepVacancies, form.lineId, filteredVacantAreas, vacantLines, lookups]);

  async function loadOffers() {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/offers", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "Offer dashboard failed to load.");
      setData(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Offer dashboard failed to load.");
    } finally {
      setIsLoading(false);
    }
  }

  async function submitOffer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setCreatedLinks(null);
    setEmailStatus(null);

    try {
      const response = await fetch("/api/offers", {
        body: JSON.stringify({
          ...form,
          areaId: form.areaId ? Number(form.areaId) : null,
          departmentId: form.departmentId ? Number(form.departmentId) : null,
          expiresInDays: Number(form.expiresInDays),
          lineId: form.lineId ? Number(form.lineId) : null,
          positionId: form.positionId ? Number(form.positionId) : null,
          jobTitle: selectedTemplate?.label ?? "Job Offer",
          salaryAmount: selectedTemplate?.monthlyPackage ?? null,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "Offer could not be created.");
      setData(payload.dashboard);
      setCreatedLinks({ acceptUrl: payload.acceptUrl, rejectUrl: payload.rejectUrl });
      setEmailStatus(
        payload.email?.skipped
          ? `Email not sent: ${payload.email.reason ?? "notification skipped"}`
          : `Email sent${payload.email?.id ? `: ${payload.email.id}` : ""}`,
      );
      setForm(emptyForm);
      setIsModalOpen(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Offer could not be created.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copyLink(value: string) {
    await navigator.clipboard?.writeText(value);
  }

  async function approveOffer(offer: OfferLifecycleRow) {
    setApprovingId(offer.id);
    setError(null);

    try {
      const response = await fetch(`/api/offers/${offer.id}/approve`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "Offer approval failed.");
      setData(payload.dashboard);
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : "Offer approval failed.");
    } finally {
      setApprovingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#F97316]">
            Digital Offer Lifecycle
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-text">Closed-loop Offer Management</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">
            Create secure offer links, capture candidate decisions, trigger notifications, and move accepted candidates into onboarding.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="gap-2" onClick={() => setIsModalOpen(true)}>
            <Send className="h-4 w-4" />
            Create offer
          </Button>
          <Button className="gap-2" disabled={isLoading} onClick={loadOffers} variant="secondary">
            {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <SummaryCard icon={<Mail className="h-4 w-4" />} label="Total offers" tone="blue" value={String(data?.summary.totalOffers ?? 0)} />
        <SummaryCard icon={<CheckCircle2 className="h-4 w-4" />} label="Accepted" tone="emerald" value={String(data?.summary.acceptedOffers ?? 0)} />
        <SummaryCard icon={<Clock3 className="h-4 w-4" />} label="Pending" tone="orange" value={String(data?.summary.pendingOffers ?? 0)} />
        <SummaryCard icon={<XCircle className="h-4 w-4" />} label="Rejected" tone="rose" value={String(data?.summary.rejectedOffers ?? 0)} />
        <SummaryCard icon={<BarChart3 className="h-4 w-4" />} label="Acceptance rate" tone="emerald" value={formatPercent(data?.summary.acceptanceRate ?? 0)} />
      </div>

      <div className="grid gap-6">
        <Card className="overflow-hidden rounded-xl bg-white p-0">
          <div className="border-b border-[#E2E8F0] p-5">
            <h2 className="text-lg font-bold text-text">Offer pipeline</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Accepted offers move to the hired pipeline and initialize onboarding.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
                <tr>
                  <th className="px-4 py-3">Candidate</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Salary</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">Next step</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-10 text-center text-sm text-text-secondary" colSpan={7}>
                      No offers yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((offer) => (
                    <OfferRow
                      approving={approvingId === offer.id}
                      key={offer.id}
                      offer={offer}
                      onApprove={approveOffer}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0F172A]/55 px-3 py-6 backdrop-blur-sm">
          <div className="max-h-[92vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-white/20 bg-white shadow-[0_34px_90px_rgba(15,23,42,0.34)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#E2E8F0] bg-[#0F172A] px-5 py-4 text-white sm:px-6">
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-orange-300">Phoenix Workforce</p>
                <h2 className="mt-2 text-xl font-black tracking-tight">New job offer</h2>
                <p className="mt-1 text-sm text-white/58">Enter candidate details, area, start date, and package.</p>
              </div>
              <button
                aria-label="Close offer popup"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/8 text-white/75 transition hover:bg-white/14 hover:text-white"
                onClick={() => setIsModalOpen(false)}
                type="button"
              >
                <XCircle className="h-5 w-5" />
              </button>
            </div>

            <form className="grid max-h-[calc(92vh-88px)] gap-0 overflow-y-auto lg:grid-cols-[1fr_330px]" onSubmit={submitOffer}>
              <div className="space-y-4 p-5 sm:p-6">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-secondary">Position template</span>
              <select
                className="h-10 w-full rounded-lg border border-border bg-white px-3 text-sm text-text transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                onChange={(event) => {
                  setForm((prev) => ({
                    ...prev,
                    templateKey: event.target.value,
                  }));
                }}
                value={form.templateKey}
              >
                {offerTemplates.map((template) => (
                  <option key={template.value} value={template.value}>
                    {template.label}
                  </option>
                ))}
              </select>
            </label>
            <Field label="Candidate name" onChange={(value) => setForm((prev) => ({ ...prev, candidateName: value }))} required value={form.candidateName} />
            <Field label="Candidate email" onChange={(value) => setForm((prev) => ({ ...prev, candidateEmail: value }))} required type="email" value={form.candidateEmail} />
            <Field label="Phone" onChange={(value) => setForm((prev) => ({ ...prev, candidatePhone: value }))} value={form.candidatePhone} />
            <Field label="Assigned territory" onChange={(value) => setForm((prev) => ({ ...prev, areaScope: value }))} placeholder="Example: Haram - Faisal" required value={form.areaScope} />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Line"
                onChange={(value) => {
                  setForm((prev) => ({
                    ...prev,
                    lineId: value,
                    areaId: "", // Reset area when line changes
                  }));
                }}
                options={isMedicalRep ? vacantLines : lookups?.lines ?? []}
                value={form.lineId}
              />
              <SelectField
                disabled={!form.lineId}
                label="Internal area"
                onChange={(value) => {
                  if (value === "empty") return;
                  if (isMedicalRep) {
                    const vacancy = filteredVacantAreas.find(
                      (v) =>
                        String(v.areaId) === value && String(v.lineId) === String(form.lineId),
                    );
                    if (vacancy) {
                      setForm((prev) => ({
                        ...prev,
                        areaId: String(vacancy.areaId),
                        areaScope: vacancy.areaName ?? "",
                        departmentId: vacancy.departmentId ? String(vacancy.departmentId) : "",
                        lineId: String(vacancy.lineId),
                        managerHrId: vacancy.managerHrId ?? "",
                        positionId: vacancy.positionId ? String(vacancy.positionId) : "",
                      }));
                    } else {
                      setForm((prev) => ({ ...prev, areaId: value }));
                    }
                  } else {
                    const selectedArea = (lookups?.areas ?? []).find((a) => a.value === value);
                    if (selectedArea) {
                      setForm((prev) => ({
                        ...prev,
                        areaId: value,
                        lineId: String(selectedArea.lineId ?? prev.lineId),
                        managerHrId: selectedArea.managerHrId ?? prev.managerHrId,
                        positionId: String(selectedArea.positionId ?? prev.positionId),
                      }));
                    } else {
                      setForm((prev) => ({ ...prev, areaId: value }));
                    }
                  }
                }}
                options={
                  isMedicalRep
                    ? filteredVacantAreas.length > 0
                      ? filteredVacantAreas.map((v) => ({
                          label: v.managerName
                            ? `${v.areaName} — ${v.positionTitle} — Manager: ${v.managerName}`
                            : `${v.areaName} — ${v.positionTitle}`,
                          value: String(v.areaId),
                        }))
                      : form.lineId
                        ? [{ label: "No open vacancies for this line", value: "empty" }]
                        : []
                    : (lookups?.areas ?? []).filter(
                        (a) => !form.lineId || String(a.lineId) === String(form.lineId),
                      )
                }
                placeholder={!form.lineId ? "Select line first" : undefined}
                value={form.areaId}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Department" onChange={(value) => setForm((prev) => ({ ...prev, departmentId: value }))} options={lookups?.departments ?? []} value={form.departmentId} />
              <SelectField label="Position" onChange={(value) => setForm((prev) => ({ ...prev, positionId: value }))} options={lookups?.positions ?? []} value={form.positionId} />
            </div>
            <SelectField label="Manager" onChange={(value) => setForm((prev) => ({ ...prev, managerHrId: value }))} options={lookups?.managers ?? []} value={form.managerHrId} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start date" onChange={(value) => setForm((prev) => ({ ...prev, startDate: value }))} type="date" value={form.startDate} />
              <Field label="Expiry days" onChange={(value) => setForm((prev) => ({ ...prev, expiresInDays: value }))} required type="number" value={form.expiresInDays} />
            </div>
              </div>

              <aside className="border-t border-[#E2E8F0] bg-[#F8FAFC] p-5 lg:border-l lg:border-t-0 sm:p-6">
                <div className="rounded-xl border border-orange-100 bg-white p-4 shadow-sm">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-orange-600">Compensation</p>
                  <h3 className="mt-2 text-base font-black text-[#0F172A]">{selectedTemplate?.label ?? "Selected position"}</h3>
                  {selectedTemplate && (
                    <div className="mt-4 space-y-3 text-sm text-[#0F172A]">
                      <div className="flex items-center justify-between gap-3">
                        <span>Basic salary</span>
                        <span className="font-bold">{formatMoney(selectedTemplate.basicSalary)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>{selectedTemplate.internalTransportationAllowance ? "Internal transportation" : "Transportation"}</span>
                        <span className="font-bold">
                          {formatMoney(selectedTemplate.internalTransportationAllowance ?? selectedTemplate.transportationAllowance ?? null)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Cost of living</span>
                        <span className="font-bold">{formatMoney(selectedTemplate.costOfLivingAllowance)}</span>
                      </div>
                      {selectedTemplate.regionalTravelExpenses ? (
                        <div className="flex items-center justify-between gap-3">
                          <span>Regional travel</span>
                          <span className="font-bold">{formatMoney(selectedTemplate.regionalTravelExpenses)}</span>
                        </div>
                      ) : null}
                      <div className="border-t border-[#E2E8F0] pt-3">
                        <div className="flex items-center justify-between gap-3 text-[#0F172A]">
                          <span className="font-black">Monthly package</span>
                          <span className="font-black">{formatMoney(selectedTemplate.monthlyPackage)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-4 rounded-xl border border-[#E2E8F0] bg-white p-4 text-sm text-[#64748B]">
                  <div className="font-bold text-[#0F172A]">Offer preview</div>
                  <p className="mt-2 leading-6">
                    {form.candidateName || "Candidate"} - {selectedTemplate?.label ?? "Position"}
                    {form.areaScope ? ` - ${form.areaScope}` : ""}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-[#64748B]">
                    Secure accept/reject links will be generated and the candidate response will update the pipeline automatically.
                  </p>
                </div>

                <div className="mt-5 flex gap-2">
                  <Button className="flex-1 gap-2" disabled={isSubmitting} type="submit">
                    {isSubmitting ? <LoadingSpinner /> : <UserCheck className="h-4 w-4" />}
                    Send offer
                  </Button>
                  <Button onClick={() => setIsModalOpen(false)} type="button" variant="secondary">
                    Cancel
                  </Button>
                </div>
              </aside>
            </form>
          </div>
        </div>
      )}

      {createdLinks && (
        <div className="fixed bottom-4 right-4 z-40 w-[min(92vw,380px)] rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 shadow-xl">
          <div className="font-bold">Offer created</div>
          {emailStatus && (
            <div className="mt-1 text-xs font-semibold text-emerald-800">{emailStatus}</div>
          )}
          <button className="mt-3 flex w-full items-center justify-between gap-2 text-left" onClick={() => copyLink(createdLinks.acceptUrl)} type="button">
            <span className="truncate">Accept link</span>
            <Copy className="h-4 w-4 shrink-0" />
          </button>
          <button className="mt-2 flex w-full items-center justify-between gap-2 text-left" onClick={() => copyLink(createdLinks.rejectUrl)} type="button">
            <span className="truncate">Reject link</span>
            <Copy className="h-4 w-4 shrink-0" />
          </button>
        </div>
      )}
    </div>
  );
}
