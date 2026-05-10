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
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import type {
  OfferDashboardData,
  OfferLifecycleRow,
  OfferLookupData,
  OfferStatus,
} from "@/lib/offers/service";
import { offerTemplates } from "@/lib/offers/templates";
type Props = {
  initialData?: OfferDashboardData | null;
  initialError?: string | null;
  lookups?: OfferLookupData | null;
};

const panelClassName =
  "rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

function OffersShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-[#D8E0EA] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_32%),linear-gradient(135deg,#FFF9F3_0%,#FFFFFF_44%,#F7FAFC_100%)] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[#F97316]/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/4 h-64 w-64 rounded-full bg-[#0F172A]/6 blur-3xl"
      />
      <div className="relative z-10 space-y-6">{children}</div>
    </div>
  );
}

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
        className="h-11 rounded-2xl border-[#DDE6F1] bg-white/95 shadow-sm"
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
        className="h-11 w-full rounded-2xl border border-[#DDE6F1] bg-white/95 px-3 text-sm text-text shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:bg-slate-50 disabled:text-slate-400"
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
    <tr className="border-b border-[#E2E8F0] transition-colors last:border-0 hover:bg-[#FFF7ED]/65">
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
          <Button className="h-8 gap-2 rounded-xl px-3 text-xs" disabled={approving} onClick={() => onApprove(offer)}>
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
  const medicalRepVacancies = React.useMemo(
    () => lookups?.medicalRepVacancies ?? [],
    [lookups?.medicalRepVacancies],
  );
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
    <OffersShell>
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <div className="flex flex-wrap gap-2">
            <Button className="gap-2 rounded-2xl bg-[#0F172A] px-3 py-2 text-xs text-white shadow-[0_14px_30px_rgba(15,23,42,0.18)] hover:bg-[#111827]" onClick={() => setIsModalOpen(true)}>
              <Send className="h-4 w-4" />
              Create offer
            </Button>
            <Button className="gap-2 rounded-2xl px-3 py-2 text-xs shadow-sm" disabled={isLoading} onClick={loadOffers} variant="secondary">
              {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        }
        badges={
          <div className="flex flex-wrap gap-2 text-xs">
            <AdminInsightChip>{`Total offers: ${String(data?.summary.totalOffers ?? 0)}`}</AdminInsightChip>
            <AdminInsightChip tone="orange">{`Pending: ${String(data?.summary.pendingOffers ?? 0)}`}</AdminInsightChip>
            <AdminInsightChip tone="slate">{`Acceptance rate: ${formatPercent(data?.summary.acceptanceRate ?? 0)}`}</AdminInsightChip>
          </div>
        }
        description="Create secure offer links, capture candidate decisions, trigger notifications, and move accepted candidates into onboarding."
        eyebrow="Digital Offer Lifecycle"
        icon={<Mail className="h-3.5 w-3.5" />}
        title="Offers Dashboard"
      />

      {error && (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </AdminCallout>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <AdminStatCard
          description="Offers created in the selected time window."
          icon={<Mail className="h-4 w-4" />}
          label="Total Offers"
          value={String(data?.summary.totalOffers ?? 0)}
        />
        <AdminStatCard
          description="Offers marked as accepted."
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Accepted"
          value={String(data?.summary.acceptedOffers ?? 0)}
        />
        <AdminStatCard
          description="Offers waiting for candidate response."
          icon={<Clock3 className="h-4 w-4" />}
          label="Pending"
          value={String(data?.summary.pendingOffers ?? 0)}
        />
        <AdminStatCard
          description="Offers declined or withdrawn."
          icon={<XCircle className="h-4 w-4" />}
          label="Rejected"
          value={String(data?.summary.rejectedOffers ?? 0)}
        />
        <AdminStatCard
          description="Ratio of accepted offers vs. total."
          icon={<BarChart3 className="h-4 w-4" />}
          label="Acceptance rate"
          value={formatPercent(data?.summary.acceptanceRate ?? 0)}
        />
      </div>

      <AdminTableShell
        description="Accepted offers move to the hired pipeline and initialize onboarding."
        title="Offer Pipeline"
      >
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
      </AdminTableShell>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0F172A]/60 px-3 py-6 backdrop-blur-md">
          <div className={`max-h-[92vh] max-w-4xl w-full overflow-hidden ${panelClassName}`}>
            <div className="relative overflow-hidden border-b border-[#1F2937] bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.24),transparent_34%),linear-gradient(135deg,#080B10_0%,#111827_58%,#24150D_100%)] px-5 py-5 text-white sm:px-6">
              <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-[#F97316]/20 blur-3xl" />
              <div className="relative z-10 flex items-start justify-between gap-4">
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
            </div>

            <form className="grid max-h-[calc(92vh-88px)] gap-0 overflow-y-auto lg:grid-cols-[1fr_330px]" onSubmit={submitOffer}>
              <div className="space-y-4 p-5 sm:p-6">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-text-secondary">Position template</span>
              <select
                className="h-11 w-full rounded-2xl border border-[#DDE6F1] bg-white/95 px-3 text-sm text-text shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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

              <aside className="border-t border-[#E2E8F0] bg-[#F8FAFC]/85 p-5 lg:border-l lg:border-t-0 sm:p-6">
                <div className="rounded-2xl border border-orange-100 bg-white p-4 shadow-sm">
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

                <div className="mt-4 rounded-2xl border border-[#E2E8F0] bg-white p-4 text-sm text-[#64748B] shadow-sm">
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
                  <Button className="flex-1 gap-2 rounded-2xl" disabled={isSubmitting} type="submit">
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
        <div className="fixed bottom-4 right-4 z-40 w-[min(92vw,380px)] rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 shadow-xl">
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
    </OffersShell>
  );
}
