"use client";

import { ReceiptText, Search, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { AdminCallout, AdminPageHero, AdminTableShell, adminPanelClassName } from "@/components/admin/admin-design-system";
import { ApprovalRecommendationBadge } from "@/components/outstation/approval-recommendation-badge";
import { FraudFlagsPanel } from "@/components/outstation/fraud-flags-panel";
import { OutstationReviewMap } from "@/components/outstation/outstation-review-map";
import { TerritoryValidationPanel } from "@/components/outstation/territory-validation-panel";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleDateString();
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "eligible") return "bg-[#ECFDF5] text-[#047857] ring-[#A7F3D0]";
  if (normalized === "not_eligible") return "bg-[#FEF2F2] text-[#B91C1C] ring-[#FECACA]";
  return "bg-[#FFF7ED] text-[#C2410C] ring-[#FED7AA]";
}

function recommendationTone(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "auto_approve") return "text-[#047857]";
  if (normalized === "finance_review") return "text-[#1D4ED8]";
  if (normalized === "reject") return "text-[#B91C1C]";
  return "text-[#C2410C]";
}

const panelClassName = adminPanelClassName;
const adminTableHeaderClassName = "px-4 py-3 text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]";

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Card className={`${panelClassName} p-4`}>
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">{label}</p>
      <p className="mt-2 truncate text-lg font-black text-[#0F172A]">{value}</p>
    </Card>
  );
}

function Info({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[14px] border border-[#E2E8F0] bg-[#F8FAFC] p-4">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">{label}</p>
      <p className="mt-2 text-sm font-semibold text-[#0F172A]">{value}</p>
    </div>
  );
}

export function OutstationRequestsAdmin({
  requests,
}: {
  requests: OutstationExpenseRequest[];
}) {
  const [search, setSearch] = useState("");
  const [eligibility, setEligibility] = useState("");
  const [role, setRole] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(requests[0]?.id ?? null);

  const roles = useMemo(
    () => [...new Set(requests.map((request) => request.employeeRole).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [requests],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return requests.filter((request) => {
      const matchesSearch =
        !term ||
        request.employeeName.toLowerCase().includes(term) ||
        request.employeeHrId.toLowerCase().includes(term) ||
        (request.residenceCity ?? "").toLowerCase().includes(term) ||
        (request.residenceArea ?? "").toLowerCase().includes(term);

      return (
        matchesSearch &&
        (!eligibility || request.eligibilityStatus === eligibility) &&
        (!role || request.employeeRole === role)
      );
    });
  }, [eligibility, requests, role, search]);

  const selectedRequest =
    filtered.find((request) => request.id === selectedId) ??
    requests.find((request) => request.id === selectedId) ??
    filtered[0] ??
    null;

  const totals = useMemo(() => {
    return filtered.reduce(
      (accumulator, request) => {
        accumulator.claimed += request.claimedTotalAmount;
        accumulator.expected += request.expectedTotalAmount;
        accumulator.highRisk += request.approvalRecommendation === "reject" ? 1 : 0;
        accumulator.variance += request.varianceAmount;
        return accumulator;
      },
      { claimed: 0, expected: 0, highRisk: 0, variance: 0 },
    );
  }, [filtered]);

  function clearFilters() {
    setSearch("");
    setEligibility("");
    setRole("");
  }

  const hasActiveFilters = Boolean(search || eligibility || role);

  if (requests.length === 0) {
    return (
      <div className="space-y-5">
        <AdminPageHero
          description="No residence-validated outstation request data is currently available."
          eyebrow="Outstation requests"
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          title="Residence-validated expense review"
        />
        <AdminCallout tone="neutral">
          <ShieldAlert className="mt-0.5 h-5 w-5 text-[#EA580C]" />
          <p className="font-semibold text-[#334155]">No requests were returned from the data source.</p>
        </AdminCallout>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Review captured distance, eligibility, expected payout, claimed amount, and route validation against the registered residence profile for each request."
        eyebrow="Outstation review"
        icon={<ShieldAlert className="h-3.5 w-3.5" />}
        title="Residence-validated expense requests"
        badges={(
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-[#DDE6F1] bg-[#F8FAFC] px-3 py-2 font-semibold text-[#64748B]">Requests: {filtered.length}</span>
            <span className="rounded-full border border-[#DDE6F1] bg-[#F8FAFC] px-3 py-2 font-semibold text-[#64748B]">Expected: {formatCurrency(totals.expected)}</span>
            <span className="rounded-full border border-[#DDE6F1] bg-[#F8FAFC] px-3 py-2 font-semibold text-[#64748B]">Claimed: {formatCurrency(totals.claimed)}</span>
            <span className="rounded-full border border-[#DDE6F1] bg-[#F8FAFC] px-3 py-2 font-semibold text-[#64748B]">High Risk: {totals.highRisk}</span>
          </div>
        )}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Requests" value={String(filtered.length)} />
        <Metric label="High Risk" value={String(totals.highRisk)} />
        <Metric label="Expected" value={formatCurrency(totals.expected)} />
        <Metric label="Claimed" value={formatCurrency(totals.claimed)} />
      </div>

      <AdminTableShell
        action={hasActiveFilters ? (
          <button
            className="inline-flex rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-semibold text-[#64748B] transition hover:border-[#F97316] hover:text-[#EA580C]"
            onClick={clearFilters}
            type="button"
          >
            Clear filters
          </button>
        ) : null}
        description="Search by employee or location and filter by eligibility and role."
        title="Request filters"
      >
        <div className="grid gap-4 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]" />
              <Input
                className="pl-9"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Employee, HR ID, area, city"
                value={search}
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Eligibility</span>
            <select
              className="h-10 w-full rounded-xl border border-[#DDE6F1] bg-white px-3 text-sm font-semibold text-[#0F172A] focus:outline-none"
              onChange={(event) => setEligibility(event.target.value)}
              value={eligibility}
            >
              <option value="">All</option>
              <option value="eligible">Eligible</option>
              <option value="not_eligible">Not Eligible</option>
              <option value="needs_review">Needs Review</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Role</span>
            <select
              className="h-10 w-full rounded-xl border border-[#DDE6F1] bg-white px-3 text-sm font-semibold text-[#0F172A] focus:outline-none"
              onChange={(event) => setRole(event.target.value)}
              value={role}
            >
              <option value="">All</option>
              {roles.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>
      </AdminTableShell>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.9fr)]">
        <Card className={`${panelClassName} p-0`}>
          <div className="space-y-1.5 border-b border-[#E2E8F0] px-5 py-4">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#EA580C]">Request queue</p>
            <h2 className="text-lg font-black tracking-[-0.03em] text-[#0F172A]">Submitted outstation requests</h2>
            <p className="text-sm text-[#64748B]">Click any row to inspect route metrics and fraud validation.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1080px] w-full text-left text-sm">
              <thead className="bg-[#F8FAFC] text-[11px] uppercase tracking-[0.16em] text-[#64748B]">
                <tr>
                  <th className={adminTableHeaderClassName}>Employee</th>
                  <th className={adminTableHeaderClassName}>Trip</th>
                  <th className={adminTableHeaderClassName}>Distance</th>
                  <th className={adminTableHeaderClassName}>Eligibility</th>
                  <th className={adminTableHeaderClassName}>Expected</th>
                  <th className={adminTableHeaderClassName}>Claimed</th>
                  <th className={adminTableHeaderClassName}>Variance</th>
                  <th className={adminTableHeaderClassName}>Recommendation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0] bg-white">
                {filtered.map((request) => {
                  const selected = request.id === selectedRequest?.id;
                  return (
                    <tr
                      className={`cursor-pointer ${selected ? "bg-[#FFF7ED]" : "transition-colors hover:bg-[#F8FAFC]/80"}`}
                      key={request.id}
                      onClick={() => setSelectedId(request.id)}
                    >
                      <td className="px-4 py-3">
                        <div className="font-bold text-[#0F172A]">{request.employeeName}</div>
                        <div className="text-xs text-[#64748B]">{`${request.employeeHrId} • ${request.employeeRole}`}</div>
                      </td>
                      <td className="px-4 py-3 text-[#64748B]">
                        {formatDate(request.tripStartDate)} to {formatDate(request.tripEndDate)}
                      </td>
                      <td className="px-4 py-3 font-semibold text-[#0F172A]">
                        {request.distanceFromResidenceKm != null
                          ? `${request.distanceFromResidenceKm.toFixed(2)} KM`
                          : "N/A"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${statusTone(request.eligibilityStatus)}`}>
                          {request.eligibilityStatus.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-semibold text-[#64748B]">
                        {formatCurrency(request.expectedTotalAmount)}
                      </td>
                      <td className="px-4 py-3 font-semibold text-[#64748B]">
                        {formatCurrency(request.claimedTotalAmount)}
                      </td>
                      <td className="px-4 py-3 font-semibold text-[#64748B]">
                        {formatCurrency(request.varianceAmount)} ({request.variancePercent.toFixed(1)}%)
                      </td>
                      <td className={`px-4 py-3 text-[11px] font-black uppercase tracking-[0.14em] ${recommendationTone(request.approvalRecommendation)}`}>
                        {request.approvalRecommendation.replace(/_/g, " ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-6">
          <Card className={`${panelClassName} p-5`}>
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#FFF7ED] text-[#EA580C]">
                <ReceiptText className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.16em] text-[#EA580C]">Selected request</p>
                <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-[#0F172A]">
                  {selectedRequest?.employeeName ?? "No request selected"}
                </h2>
              </div>
            </div>

            {selectedRequest ? (
              <div className="space-y-3">
                <Info label="Residence" value={[selectedRequest.residenceAddress, selectedRequest.residenceArea, selectedRequest.residenceCity].filter(Boolean).join(", ") || "Not saved"} />
                <Info label="Captured Coordinates" value={`${selectedRequest.capturedLatitude.toFixed(5)}, ${selectedRequest.capturedLongitude.toFixed(5)}`} />
                <Info label="Distance" value={selectedRequest.distanceFromResidenceKm != null ? `${selectedRequest.distanceFromResidenceKm.toFixed(2)} KM` : "N/A"} />
                <Info label="Duration" value={selectedRequest.durationMinutes != null ? `${selectedRequest.durationMinutes.toFixed(0)} mins` : "N/A"} />
                <Info label="Eligibility Reason" value={selectedRequest.eligibilityReason} />
                <Info label="Transportation" value={selectedRequest.transportationType.replace("_", " ")} />
                <Info label="Status" value={selectedRequest.status} />
                <Info label="Destination" value={selectedRequest.toLabel ?? "N/A"} />
                <div className="pt-1">
                  <ApprovalRecommendationBadge value={selectedRequest.approvalRecommendation} />
                </div>
              </div>
            ) : (
              <p className="text-sm text-[#64748B]">No requests match the current filters.</p>
            )}
          </Card>

          <OutstationReviewMap request={selectedRequest} />

          {selectedRequest ? (
            <>
              <TerritoryValidationPanel
                reason={selectedRequest.territoryValidationReason}
                status={selectedRequest.territoryValidationStatus}
              />
              <FraudFlagsPanel
                fraudFlags={selectedRequest.fraudFlags}
                score={selectedRequest.suspiciousLocationScore}
              />
            </>
          ) : null}

          <Card className={`${panelClassName} p-5`}>
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#FFF7ED] text-[#EA580C]">
                <ShieldAlert className="h-5 w-5" />
              </span>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.16em] text-[#EA580C]">Fraud controls</p>
                <ul className="mt-2 space-y-2 text-sm leading-6 text-[#64748B]">
                  <li>Residence coordinates are the only approved origin reference.</li>
                  <li>Client GPS is captured with timestamp and accuracy, but server distance is authoritative.</li>
                  <li>Requests under 60 KM are not eligible for outstation expense.</li>
                </ul>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}




