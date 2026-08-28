"use client";

import * as React from "react";
import { AlertTriangle, MapPin, Search } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import {
  PHARMACY_MATCH_CONFIDENCE_LABEL,
  PHARMACY_MATCH_REASON_LABEL,
  type PharmacyMatchCandidateGroup,
  type PharmacyMatchConfidence,
  type PharmacyMatchMember,
} from "@/lib/pharmacy-master/pharmacy-matching";
import { cn } from "@/lib/utils";

type CandidatesResponse = {
  candidates: PharmacyMatchCandidateGroup[];
  distributors: Array<{ id: number; code: string; name: string }>;
  totalPharmacies: number;
  totalLinked: number;
  generatedAtIso: string;
};

const CONFIDENCE_TONE: Record<PharmacyMatchConfidence, string> = {
  high: "border-emerald-200 bg-emerald-50 text-emerald-700",
  medium: "border-amber-200 bg-amber-50 text-amber-700",
  low: "border-slate-200 bg-slate-50 text-slate-500",
};

function ConfidenceBadge({ confidence }: { confidence: PharmacyMatchConfidence }) {
  return (
    <span className={cn("inline-flex items-center rounded-[4px] border px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide", CONFIDENCE_TONE[confidence])}>
      {PHARMACY_MATCH_CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

function MemberCard({ member }: { member: PharmacyMatchMember }) {
  const geo = [member.areaName, member.regionName, member.governorateName].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0 flex-1 rounded-[6px] border border-phx-line bg-phx-paper p-3">
      <p className="truncate text-phx-md font-black text-phx-ink" title={member.displayName}>{member.displayName}</p>
      <p className="mt-1 font-mono text-phx-xs font-bold text-phx-ink-soft">{member.pharmacyCode}</p>
      <div className="mt-2 space-y-1 text-phx-xs font-semibold text-phx-ink-2">
        <p>Distributor: <span className="text-phx-ink">{member.distributorName}</span></p>
        <p>Distributor code: <span className="font-mono text-phx-ink">{member.distributorPharmacyCode}</span></p>
        {geo ? <p className="text-phx-ink-soft">{geo}</p> : <p className="text-phx-ink-faint">No area/region/governorate on file</p>}
        {member.address ? <p className="flex items-start gap-1 text-phx-ink-soft"><MapPin className="mt-0.5 h-3 w-3 shrink-0" /> {member.address}</p> : null}
        {member.latitude != null && member.longitude != null ? (
          <p className="font-mono text-phx-ink-soft">{member.latitude.toFixed(5)}, {member.longitude.toFixed(5)}</p>
        ) : null}
      </div>
    </div>
  );
}

function CandidateCard({ group }: { group: PharmacyMatchCandidateGroup }) {
  return (
    <article className="rounded-[6px] border border-phx-line bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ConfidenceBadge confidence={group.confidence} />
          <span className="text-phx-xs font-bold text-phx-ink-soft">{PHARMACY_MATCH_REASON_LABEL[group.matchReason]}</span>
        </div>
        <span className="font-mono text-phx-xs font-bold text-phx-ink-faint">score {group.score}</span>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <MemberCard member={group.members[0]} />
        <MemberCard member={group.members[1]} />
      </div>
      {group.warning ? (
        <div className="mt-2 flex items-start gap-1.5 rounded-[5px] border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-phx-xs font-semibold text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {group.warning}
        </div>
      ) : null}
    </article>
  );
}

async function fetchJson<T>(url: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) return { data: null, error: payload?.message ?? "Request failed." };
    return { data: payload as T, error: null };
  } catch {
    return { data: null, error: "Request failed." };
  }
}

export function PharmacyMasterWorkspace() {
  const [data, setData] = React.useState<CandidatesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [confidenceFilter, setConfidenceFilter] = React.useState<"all" | PharmacyMatchConfidence>("all");
  const [distributorFilter, setDistributorFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [highConfidenceOnly, setHighConfidenceOnly] = React.useState(false);
  const [showAmbiguous, setShowAmbiguous] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      const { data: payload, error: fetchError } = await fetchJson<CandidatesResponse>("/api/pharmacy-master/candidates");
      if (cancelled) return;
      if (fetchError) setError(fetchError);
      else setData(payload);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredGroups = React.useMemo(() => {
    if (!data) return [];
    const normalizedSearch = search.trim().toLowerCase();
    return data.candidates.filter((group) => {
      // Low confidence is hidden by default — only "show ambiguous candidates" reveals it.
      if (group.confidence === "low" && !showAmbiguous) return false;
      if (highConfidenceOnly && group.confidence !== "high") return false;
      if (confidenceFilter !== "all" && group.confidence !== confidenceFilter) return false;
      if (distributorFilter) {
        const matchesDistributor = group.members.some((member) => String(member.distributorId) === distributorFilter);
        if (!matchesDistributor) return false;
      }
      if (normalizedSearch) {
        const matchesSearch = group.members.some(
          (member) =>
            member.displayName.toLowerCase().includes(normalizedSearch) ||
            member.pharmacyCode.toLowerCase().includes(normalizedSearch) ||
            member.distributorPharmacyCode.toLowerCase().includes(normalizedSearch),
        );
        if (!matchesSearch) return false;
      }
      return true;
    });
  }, [data, search, confidenceFilter, distributorFilter, highConfidenceOnly, showAmbiguous]);

  const counts = React.useMemo(() => {
    const all = data?.candidates ?? [];
    return {
      high: all.filter((group) => group.confidence === "high").length,
      medium: all.filter((group) => group.confidence === "medium").length,
      low: all.filter((group) => group.confidence === "low").length,
    };
  }, [data]);

  return (
    <WorkspaceErrorBoundary fallbackTitle="Pharmacy Master error">
      <div className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 rounded-[6px] border border-phx-line bg-white px-4 py-8 text-phx-md font-semibold text-phx-ink-soft shadow-sm">
            <LoadingSpinner /> Scanning pharmacies for possible duplicates…
          </div>
        ) : error ? (
          <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800">{error}</div>
        ) : data ? (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <SummaryStat label="Pharmacies" value={data.totalPharmacies} />
              <SummaryStat label="Distributor links" value={data.totalLinked} />
              <SummaryStat accent="high" label="High confidence" value={counts.high} />
              <SummaryStat accent="medium" label="Medium confidence" value={counts.medium} />
              <SummaryStat accent="low" label="Low (hidden by default)" value={counts.low} />
            </div>

            {/* Filters */}
            <section className="flex flex-wrap items-end gap-3 rounded-[6px] border border-phx-line bg-white p-3 shadow-sm">
              <label className="flex flex-col gap-1">
                <span className="text-phx-2xs font-bold uppercase tracking-wide text-phx-ink-faint">Confidence</span>
                <select
                  value={confidenceFilter}
                  onChange={(event) => setConfidenceFilter(event.target.value as "all" | PharmacyMatchConfidence)}
                  className="h-8 rounded-[5px] border border-phx-line px-2 text-phx-sm font-bold text-phx-ink"
                >
                  <option value="all">All</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-phx-2xs font-bold uppercase tracking-wide text-phx-ink-faint">Distributor</span>
                <select
                  value={distributorFilter}
                  onChange={(event) => setDistributorFilter(event.target.value)}
                  className="h-8 rounded-[5px] border border-phx-line px-2 text-phx-sm font-bold text-phx-ink"
                >
                  <option value="">All distributors</option>
                  {data.distributors.map((distributor) => (
                    <option key={distributor.id} value={distributor.id}>{distributor.name}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-phx-2xs font-bold uppercase tracking-wide text-phx-ink-faint">Search</span>
                <span className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-faint" />
                  <input
                    type="text"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Pharmacy name or code…"
                    className="h-8 rounded-[5px] border border-phx-line pl-7 pr-2 text-phx-sm font-semibold text-phx-ink"
                  />
                </span>
              </label>
              <label className="flex h-8 items-center gap-1.5 text-phx-xs font-bold text-phx-ink-2">
                <input type="checkbox" checked={highConfidenceOnly} onChange={(event) => setHighConfidenceOnly(event.target.checked)} />
                High-confidence only
              </label>
              <label className="flex h-8 items-center gap-1.5 text-phx-xs font-bold text-phx-ink-2">
                <input type="checkbox" checked={showAmbiguous} onChange={(event) => setShowAmbiguous(event.target.checked)} />
                Show ambiguous (low-confidence) candidates
              </label>
            </section>

            {/* Candidate list */}
            <section className="space-y-2">
              {filteredGroups.length === 0 ? (
                <div className="rounded-[6px] border border-phx-line bg-white px-4 py-8 text-center text-phx-md font-medium text-phx-ink-soft shadow-sm">
                  No candidates match these filters.
                </div>
              ) : (
                filteredGroups.map((group) => <CandidateCard key={group.groupKey} group={group} />)
              )}
            </section>
            <p className="text-phx-2xs font-medium text-phx-ink-faint">
              Read-only, suggestion-only report — nothing on this page merges, creates, or changes any pharmacy record.
              Generated {data.generatedAtIso}.
            </p>
          </>
        ) : null}
      </div>
    </WorkspaceErrorBoundary>
  );
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "high" | "medium" | "low";
}) {
  const border = accent === "high" ? "border-l-emerald-500" : accent === "medium" ? "border-l-amber-500" : accent === "low" ? "border-l-slate-400" : "border-l-slate-500";
  return (
    <div className={cn("rounded-[6px] border border-phx-line border-l-[3px] bg-white px-3.5 py-3 shadow-sm", border)}>
      <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">{label}</p>
      <p className="mt-1.5 text-[22px] font-black leading-none text-phx-ink">{value}</p>
    </div>
  );
}
