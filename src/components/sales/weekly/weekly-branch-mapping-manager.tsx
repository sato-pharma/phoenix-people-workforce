"use client";

import { AlertTriangle, Download, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { WeeklyBranchSplitPreview } from "@/lib/sales/weekly/branch-attribution";
import type {
  WeeklyBranchFileType,
  WeeklyBranchRegionAdmin,
  WeeklyBranchRegionRow,
} from "@/lib/sales/weekly/branch-region-map";
import { SearchableSelect } from "@/components/ui/searchable-select";


type DraftRow = { branchName: string; branchCode: string; columnIndex: string; regionCode: string; areaCode: string; excluded: boolean };

const EMPTY_DRAFT: DraftRow = { branchName: "", branchCode: "", columnIndex: "", regionCode: "", areaCode: "", excluded: false };

export function WeeklyBranchMappingManager({
  initial,
  initialError,
  lockedDistributor,
}: {
  initial: WeeklyBranchRegionAdmin | null;
  initialError: string | null;
  /** Force a distributor and hide the internal selector (embedded in a distributor-scoped page). */
  lockedDistributor?: string;
}) {
  const [data, setData] = useState<WeeklyBranchRegionAdmin | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [distributor, setDistributor] = useState<string>(lockedDistributor || initial?.distributorCode || "IS");
  const [fileType, setFileType] = useState<WeeklyBranchFileType>("any");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRow>(EMPTY_DRAFT);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const isPs = distributor === "PS";
  const effectiveFileType: WeeklyBranchFileType = isPs ? (fileType === "any" ? "sales" : fileType) : "any";
  const isStock = effectiveFileType === "stock";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Defer the loading flag off the synchronous effect tick (avoids cascading-render lint).
      await Promise.resolve();
      if (cancelled) return;
      setBusy(true);
      setError(null);
      try {
        const params = new URLSearchParams({ distributor, fileType: effectiveFileType });
        const response = await fetch(`/api/sales/weekly/branch-mapping?${params.toString()}`, { cache: "no-store" });
        const payload = (await response.json()) as { success?: boolean; data?: WeeklyBranchRegionAdmin; error?: string };
        if (cancelled) return;
        if (payload?.success && payload.data) setData(payload.data);
        else setError(payload?.error ?? "Failed to load branch mapping.");
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load branch mapping.");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [distributor, effectiveFileType]);

  async function mutate(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/sales/weekly/branch-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ distributorCode: distributor, sourceFileType: effectiveFileType, ...body }),
      });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklyBranchRegionAdmin; error?: string };
      if (payload?.success && payload.data) {
        setData(payload.data);
        return true;
      }
      setError(payload?.error ?? "Save failed.");
      return false;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addDraft() {
    if (!draft.regionCode && !draft.excluded) {
      setError("Pick a region (or mark the row excluded).");
      return;
    }
    const ok = await mutate({
      rawBranch: isStock ? draft.branchName : draft.branchCode || draft.branchName,
      branchName: draft.branchName || draft.branchCode,
      regionCode: draft.regionCode,
      areaCode: draft.areaCode || null,
      branchColumnIndex: isStock && draft.columnIndex ? Number(draft.columnIndex) : null,
      excluded: draft.excluded,
    });
    if (ok) setDraft(EMPTY_DRAFT);
  }

  function saveRow(
    row: WeeklyBranchRegionRow,
    patch: { regionCode?: string; areaCode?: string | null; excluded?: boolean },
  ) {
    // Changing the region invalidates any area sitting in the old one, so clear it rather than send a
    // combination the server would (correctly) reject.
    const regionChanged = patch.regionCode != null && patch.regionCode !== row.regionCode;
    const areaCode = patch.areaCode !== undefined ? patch.areaCode : regionChanged ? null : row.areaCode;
    return mutate({
      rawBranch: row.rawBranch,
      branchName: row.branchHeaderRaw ?? row.rawBranch,
      regionCode: patch.regionCode ?? row.regionCode,
      areaCode: areaCode || null,
      branchColumnIndex: row.branchColumnIndex,
      excluded: patch.excluded ?? row.excluded,
    });
  }

  async function onUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("distributorCode", distributor);
      form.append("fileType", effectiveFileType);
      const response = await fetch("/api/sales/weekly/branch-mapping", { method: "POST", body: form });
      const payload = (await response.json()) as {
        success?: boolean;
        data?: WeeklyBranchRegionAdmin;
        error?: string;
        message?: string;
        result?: { blockedRows?: { rowNumber: number; reason: string }[] };
      };
      if (payload?.data) setData(payload.data);
      if (payload?.success) {
        setNotice(payload.message ?? "Mapping imported.");
      } else {
        const blocked = payload?.result?.blockedRows ?? [];
        setError(
          blocked.length
            ? `${payload?.error ?? "Import blocked."} First issue — row ${blocked[0].rowNumber}: ${blocked[0].reason}`
            : payload?.error ?? "Import failed.",
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  const regions = useMemo(() => data?.masterRegions ?? [], [data]);
  const allAreas = useMemo(() => data?.masterAreas ?? [], [data]);
  // An area may only be attached to a branch already mapped to that area's region.
  const areasForRegion = useMemo(
    () => (regionCode: string) =>
      regionCode ? allAreas.filter((area) => area.regionCode.toUpperCase() === regionCode.toUpperCase()) : [],
    [allAreas],
  );
  const rows = data?.rows ?? [];

  if (!data) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <span>{error ?? "Failed to load branch mapping."}</span>
        </div>
      </div>
    );
  }

  const templateHref = `/api/sales/weekly/branch-mapping/template?distributor=${encodeURIComponent(distributor)}&fileType=${effectiveFileType}`;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-phx-accent" aria-hidden />
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-phx-accent">Weekly Sales</span>
        </div>
        <h1 className="mt-1 text-xl font-black text-phx-ink">Branch Region Mapping</h1>
        <p className="mt-1 text-sm font-medium text-phx-ink-soft">
          Map each distributor branch / outlet to one official region. The weekly upload uses this to roll every
          distributor up into the same regions. Mark warehouses, platforms or tenders as excluded to keep them out of totals.
        </p>
        <p className="mt-2 text-sm font-medium text-phx-ink-soft">
          Under every branch is <span className="font-black text-[#9A3412]">how its name is read</span> and the exact split
          that follows: a depot serving several territories pays each of them an equal share, then divides that share evenly
          again inside each one. Set <span className="font-black text-phx-ink">Area</span> to overrule the reading — a
          branch pinned to an area sends the whole of its value there and its name is no longer read.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && <div className="border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">{notice}</div>}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-phx-line bg-white p-3 shadow-sm">
        {lockedDistributor ? null : (
          <>
            <span className="text-[11px] font-black uppercase tracking-[0.14em] text-phx-ink-soft">Distributor</span>
            <SearchableSelect
              className="h-9 min-w-[14rem] border border-phx-line bg-white px-2 text-sm font-bold text-phx-ink outline-none focus:border-phx-accent-line"
              disabled={busy}
              value={distributor}
              onChange={(event) => {
                setDistributor(event.target.value);
                setFileType("any");
                setDraft(EMPTY_DRAFT);
              }}
            >
              {data.distributors.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name} ({option.code})
                </option>
              ))}
            </SearchableSelect>
          </>
        )}

        {isPs && (
          <div className="flex items-center gap-1">
            {(["sales", "stock"] as const).map((type) => (
              <button
                key={type}
                className={`h-9 border px-3 text-xs font-black uppercase tracking-wide transition ${
                  effectiveFileType === type
                    ? "border-phx-accent bg-phx-accent-soft text-[#9A3412]"
                    : "border-phx-line bg-white text-phx-ink-soft hover:border-phx-accent-line"
                }`}
                disabled={busy}
                onClick={() => setFileType(type)}
                type="button"
              >
                {type === "sales" ? "POS Sales outlets" : "Stock locations"}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <a
            className="inline-flex h-9 items-center gap-1 rounded-[6px] border border-phx-line px-3 text-xs font-bold text-phx-ink-2 transition hover:border-phx-accent-line"
            href={templateHref}
          >
            <Download className="h-4 w-4" /> Template
          </a>
          <button
            className="inline-flex h-9 items-center gap-1 rounded-[6px] border border-phx-line px-3 text-xs font-bold text-phx-ink-2 transition hover:border-phx-accent-line disabled:opacity-60"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            type="button"
          >
            <Upload className="h-4 w-4" /> Upload filled
          </button>
          <input ref={fileInput} className="hidden" type="file" accept=".xlsx" onChange={onUpload} />
        </div>
      </div>

      {/* Add row */}
      <div className="flex flex-wrap items-end gap-2 rounded-[6px] border border-phx-line bg-white p-3 shadow-sm">
        <Field label={isStock ? "Location name" : "Branch name"}>
          <input
            className="h-9 w-56 border border-phx-line px-2 text-sm text-phx-ink outline-none focus:border-phx-accent-line"
            disabled={busy}
            onChange={(event) => setDraft((prev) => ({ ...prev, branchName: event.target.value }))}
            value={draft.branchName}
          />
        </Field>
        {isStock ? (
          <Field label="Column #">
            <input
              className="h-9 w-24 border border-phx-line px-2 text-sm text-phx-ink outline-none focus:border-phx-accent-line"
              disabled={busy}
              inputMode="numeric"
              onChange={(event) => setDraft((prev) => ({ ...prev, columnIndex: event.target.value }))}
              value={draft.columnIndex}
            />
          </Field>
        ) : (
          <Field label="Branch code (key)">
            <input
              className="h-9 w-40 border border-phx-line px-2 text-sm text-phx-ink outline-none focus:border-phx-accent-line"
              disabled={busy}
              onChange={(event) => setDraft((prev) => ({ ...prev, branchCode: event.target.value }))}
              value={draft.branchCode}
            />
          </Field>
        )}
        <Field label="Region">
          <SearchableSelect
            className="h-9 w-44 border border-phx-line bg-white px-2 text-sm font-semibold text-phx-ink outline-none focus:border-phx-accent-line disabled:opacity-60"
            disabled={busy || draft.excluded}
            onChange={(event) => setDraft((prev) => ({ ...prev, regionCode: event.target.value }))}
            value={draft.regionCode}
          >
            <option value="">Select…</option>
            {regions.map((region) => (
              <option key={region.regionCode} value={region.regionCode}>
                {region.regionName} ({region.regionCode})
              </option>
            ))}
          </SearchableSelect>
        </Field>
        <Field label="Area (optional)">
          <SearchableSelect
            className="h-9 w-48 border border-phx-line bg-white px-2 text-sm font-semibold text-phx-ink outline-none focus:border-phx-accent-line disabled:opacity-60"
            disabled={busy || draft.excluded || !draft.regionCode}
            onChange={(event) => setDraft((prev) => ({ ...prev, areaCode: event.target.value }))}
            value={draft.areaCode}
          >
            <option value="">Whole region</option>
            {areasForRegion(draft.regionCode).map((area) => (
              <option key={area.areaCode} value={area.areaCode}>
                {area.areaName} ({area.areaCode})
              </option>
            ))}
          </SearchableSelect>
        </Field>
        <label className="flex h-9 items-center gap-1 text-xs font-bold text-phx-ink-soft">
          <input
            checked={draft.excluded}
            disabled={busy}
            onChange={(event) => setDraft((prev) => ({ ...prev, excluded: event.target.checked }))}
            type="checkbox"
          />
          Exclude
        </label>
        <button
          className="inline-flex h-9 items-center gap-1 rounded-[6px] bg-phx-accent px-4 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:opacity-60"
          disabled={busy}
          onClick={addDraft}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-[6px] border border-phx-line bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-[#020617] text-left text-[11px] font-black uppercase tracking-wide text-white">
            <tr>
              <th className="px-3 py-2">Branch name</th>
              <th className="px-3 py-2">Code / key</th>
              {isStock && <th className="px-3 py-2">Col #</th>}
              <th className="px-3 py-2">Region</th>
              <th className="px-3 py-2">Area (optional)</th>
              <th className="px-3 py-2 text-center">Excluded</th>
              <th className="px-3 py-2 text-right" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-center text-phx-ink-faint" colSpan={isStock ? 7 : 6}>
                  No branches mapped yet — add one above or upload the template.
                </td>
              </tr>
            )}
            {rows.map((row) => [
              <tr className="border-t border-[#FFE8D6] align-middle" key={row.id}>
                <td className="px-3 py-2 font-semibold text-phx-ink">{row.branchHeaderRaw || row.rawBranch}</td>
                <td className="px-3 py-2 text-phx-ink-soft">{row.rawBranch}</td>
                {isStock && <td className="px-3 py-2 text-phx-ink-soft">{row.branchColumnIndex ?? "—"}</td>}
                <td className="px-3 py-2">
                  <SearchableSelect
                    className="h-8 w-44 border border-phx-line bg-white px-2 text-sm font-semibold text-phx-ink outline-none focus:border-phx-accent-line disabled:opacity-50"
                    disabled={busy || row.excluded}
                    onChange={(event) => void saveRow(row, { regionCode: event.target.value })}
                    value={row.regionCode}
                  >
                    <option value="">{row.excluded ? "— excluded —" : "Select…"}</option>
                    {regions.map((region) => (
                      <option key={region.regionCode} value={region.regionCode}>
                        {region.regionName} ({region.regionCode})
                      </option>
                    ))}
                  </SearchableSelect>
                </td>
                <td className="px-3 py-2">
                  <SearchableSelect
                    className="h-8 w-48 border border-phx-line bg-white px-2 text-sm font-semibold text-phx-ink outline-none focus:border-phx-accent-line disabled:opacity-50"
                    disabled={busy || row.excluded || !row.regionCode}
                    onChange={(event) => void saveRow(row, { areaCode: event.target.value })}
                    value={row.areaCode ?? ""}
                  >
                    <option value="">Whole region</option>
                    {areasForRegion(row.regionCode).map((area) => (
                      <option key={area.areaCode} value={area.areaCode}>
                        {area.areaName} ({area.areaCode})
                      </option>
                    ))}
                  </SearchableSelect>
                </td>
                <td className="px-3 py-2 text-center">
                  <input
                    checked={row.excluded}
                    disabled={busy}
                    onChange={(event) => void saveRow(row, { excluded: event.target.checked })}
                    type="checkbox"
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    className="inline-flex items-center gap-1 border border-phx-line px-2 py-1 text-xs font-bold text-[#B91C1C] transition hover:border-[#FCA5A5]"
                    disabled={busy}
                    onClick={() => void mutate({ action: "delete", id: row.id })}
                    type="button"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </button>
                </td>
              </tr>,
              row.split ? <SplitBand columns={isStock ? 7 : 6} key={`${row.id}-split`} split={row.split} /> : null,
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The owner's instruction, 2026-08-27: the split "must show in the weekly mapping sheet, with
 * calculation like this". So the arithmetic sits under the branch it belongs to rather than in a
 * separate report — the same screen the mapping is corrected on.
 *
 * It is a BAND rather than a column because the rule is that text never wraps and is never cut with
 * an ellipsis: a nine-area split cannot live in a table cell without breaking one of those. Each
 * area is its own chip, whole and on one line, and the band is free to use the table's full width.
 */
function SplitBand({ columns, split }: { columns: number; split: WeeklyBranchSplitPreview }) {
  const showsLineLabels = split.arithmetic.length > 1;
  return (
    <tr className="bg-[#FFFBF7]">
      <td className="px-3 pb-2.5 pt-0" colSpan={columns}>
        <div className="flex flex-col gap-1.5">
          <span className="whitespace-nowrap text-[11px] font-semibold text-phx-ink-faint">{split.note}</span>
          {split.arithmetic.map((entry) => (
            <div className="flex flex-wrap items-center gap-1.5" key={entry.lines.join("|")}>
              {showsLineLabels && (
                <span className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.12em] text-phx-ink-faint">
                  {entry.lines.join(" + ")}
                </span>
              )}
              {entry.shares.map((share) => (
                <span
                  className="whitespace-nowrap rounded-full border border-[#FFD8B4] bg-white px-2 py-0.5 text-[11px] font-bold text-[#9A3412]"
                  key={share.areaCode}
                >
                  {share.areaName} <span className="text-phx-accent-press">{share.percentLabel}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-phx-ink-faint">{label}</span>
      {children}
    </label>
  );
}
