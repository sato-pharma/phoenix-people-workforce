"use client";

import { AlertTriangle, CheckCircle2, Loader2, MapPinned, Plus, Save, Trash2 } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { AdminCallout, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type {
  AreaRow,
  LineAreaRegionMapRow,
  LineRow,
  LineZoneRegionRow,
  LineZoneRow,
  RegionRow,
  TerritoryMappingData,
} from "@/lib/sales/territory-mapping/service";
import { cn } from "@/lib/utils";

type Props = {
  initialData: TerritoryMappingData;
  initialError: string | null;
};

const tableHeaderClassName = "px-3 py-2.5 text-xs font-black uppercase tracking-[0.14em] whitespace-nowrap";
const selectClassName =
  "h-9 w-full rounded-none border border-[#E2E8F0] bg-white px-2 text-sm text-[#0F172A] outline-none focus:border-[#FDBA74] disabled:cursor-not-allowed disabled:opacity-60";
const inputClassName =
  "h-9 w-full rounded-none border border-[#E2E8F0] bg-white px-2 text-sm text-[#0F172A] outline-none focus:border-[#FDBA74] disabled:cursor-not-allowed disabled:opacity-60";

async function readJson<T extends { error?: string; success: boolean }>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return { success: response.ok, error: response.ok ? undefined : response.statusText } as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { success: false, error: text } as T;
  }
}

function mapKey(lineId: number, areaCode: string) {
  return `${lineId}:${areaCode}`;
}

// ── Tab 1: line_area_region_map grid — rows = areas (grouped by current region), columns = lines ──
function AreaRegionGrid({
  areas,
  lines,
  map,
  regions,
  onSaved,
}: {
  areas: AreaRow[];
  lines: LineRow[];
  map: LineAreaRegionMapRow[];
  regions: RegionRow[];
  onSaved: (row: LineAreaRegionMapRow) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  const mapByKey = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const row of map) byKey.set(mapKey(row.line_id, row.area_code), row.region_code);
    return byKey;
  }, [map]);

  const groupedAreas = useMemo(() => {
    const groups = new Map<string, AreaRow[]>();
    for (const area of areas) {
      const bucket = groups.get(area.region_code) ?? [];
      bucket.push(area);
      groups.set(area.region_code, bucket);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [areas]);

  const regionName = useMemo(() => {
    const byCode = new Map(regions.map((region) => [region.region_code, region.region_name]));
    return (code: string) => byCode.get(code) ?? code;
  }, [regions]);

  async function saveCell(lineId: number, areaCode: string, regionCode: string) {
    const key = mapKey(lineId, areaCode);
    setBusyKey(key);
    setError(null);
    try {
      const response = await fetch("/api/admin/org-territory-mapping/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lineId, areaCode, regionCode }),
      });
      const payload = await readJson<{ success: boolean; error?: string }>(response);
      if (!payload.success) {
        setError(payload.error ?? "Save failed.");
        return;
      }
      onSaved({ line_id: lineId, area_code: areaCode, region_code: regionCode });
      setSavedFlash(key);
      setTimeout(() => setSavedFlash((current) => (current === key ? null : current)), 1500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <AdminTableShell
      description="Each cell is the region that area rolls up to for that line. The same area can differ by line (e.g. Kafr El-Sheikh is AB under Pedia but D1 under Anti-Infective)."
      title="Area × Line → Region"
    >
      <div className="overflow-x-auto p-4 md:p-5">
        {error ? (
          <div className="mb-3">
            <AdminCallout tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>{error}</p>
            </AdminCallout>
          </div>
        ) : null}
        <div className="overflow-hidden rounded-[16px] border border-[#E2E8F0]">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="bg-[#020617] text-white">
                <th className={tableHeaderClassName}>Area</th>
                <th className={tableHeaderClassName}>Current Region</th>
                {lines.map((line) => (
                  <th className={tableHeaderClassName} key={line.id}>{line.name} ({line.code})</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#FFE8D6]">
              {groupedAreas.map(([regionCode, groupAreas]) => (
                <Fragment key={regionCode}>
                  <tr className="bg-[#FFF7ED]">
                    <td className="px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#C2410C]" colSpan={2 + lines.length}>
                      {regionName(regionCode)} ({regionCode})
                    </td>
                  </tr>
                  {groupAreas.map((area) => (
                    <tr key={area.area_code}>
                      <td className="whitespace-nowrap px-3 py-2 font-semibold text-[#0F172A]">
                        {area.area_name} <span className="font-mono text-xs text-[#94A3B8]">{area.area_code}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-[#64748B]">{area.region_code}</td>
                      {lines.map((line) => {
                        const key = mapKey(line.id, area.area_code);
                        const current = mapByKey.get(key) ?? "";
                        return (
                          <td className="px-3 py-2" key={key}>
                            <div className="flex items-center gap-1.5">
                              <select
                                className={selectClassName}
                                disabled={busyKey === key}
                                onChange={(event) => void saveCell(line.id, area.area_code, event.target.value)}
                                value={current}
                              >
                                <option disabled value="">Select region</option>
                                {regions.map((region) => (
                                  <option key={region.region_code} value={region.region_code}>
                                    {region.region_code} — {region.region_name}
                                  </option>
                                ))}
                              </select>
                              {busyKey === key ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#F97316]" /> : null}
                              {savedFlash === key ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : null}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
              {areas.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-center text-sm font-semibold text-[#64748B]" colSpan={2 + lines.length}>
                    No areas found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </AdminTableShell>
  );
}

// ── Tab 2: line_zones list/form (display-only RM territory labels) ──
function ZoneMembers({ zoneCode, zoneRegions, regions }: { zoneCode: string; zoneRegions: LineZoneRegionRow[]; regions: RegionRow[] }) {
  const codes = zoneRegions.filter((row) => row.zone_code === zoneCode).map((row) => row.region_code);
  const regionName = new Map(regions.map((region) => [region.region_code, region.region_name]));
  if (codes.length === 0) return <span className="text-xs text-[#94A3B8]">No regions</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {codes.map((code) => (
        <span
          className="whitespace-nowrap rounded-none bg-[#0F172A] px-2 py-0.5 text-[11px] font-semibold text-white"
          key={code}
          title={regionName.get(code) ?? code}
        >
          {code}
        </span>
      ))}
    </div>
  );
}

function ZoneEditRow({
  zone,
  lines,
  regions,
  zoneRegions,
  onSave,
  onCancel,
}: {
  zone: LineZoneRow;
  lines: LineRow[];
  regions: RegionRow[];
  zoneRegions: LineZoneRegionRow[];
  onSave: (values: { rmHrId: string; label: string; regionCodes: string[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const initialRegions = useMemo(
    () => new Set(zoneRegions.filter((row) => row.zone_code === zone.zone_code).map((row) => row.region_code)),
    [zoneRegions, zone.zone_code],
  );
  const line = lines.find((l) => l.id === zone.line_id);
  const [rmHrId, setRmHrId] = useState(zone.rm_hr_id ?? "");
  const [label, setLabel] = useState(zone.label);
  const [regionCodes, setRegionCodes] = useState<Set<string>>(initialRegions);
  const [saving, setSaving] = useState(false);

  function toggleRegion(code: string) {
    setRegionCodes((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  return (
    <tr className="bg-[#FFFBF5]">
      <td className="px-3 py-2 align-top font-mono text-xs font-bold text-[#0F172A]">
        {zone.zone_code}
        <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#94A3B8]">{line?.code ?? zone.line_id}</div>
      </td>
      <td className="px-3 py-2 align-top">
        <input className={inputClassName} onChange={(event) => setRmHrId(event.target.value)} placeholder="HR_ID (optional)" value={rmHrId} />
      </td>
      <td className="px-3 py-2 align-top">
        <input className={inputClassName} onChange={(event) => setLabel(event.target.value)} placeholder="Label" value={label} />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap gap-2">
          {regions.map((region) => (
            <label className="flex items-center gap-1 text-xs font-semibold text-[#334155]" key={region.region_code}>
              <input checked={regionCodes.has(region.region_code)} onChange={() => toggleRegion(region.region_code)} type="checkbox" />
              {region.region_code}
            </label>
          ))}
        </div>
      </td>
      <td className="px-3 py-2 text-right align-top">
        <div className="flex items-center justify-end gap-1.5">
          <Button
            className="h-8 gap-1 bg-[#0B0B0B] font-black text-white hover:bg-[#F97316]"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave({ rmHrId, label, regionCodes: [...regionCodes] });
              } finally {
                setSaving(false);
              }
            }}
            type="button"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
          <Button className="h-8" disabled={saving} onClick={onCancel} type="button" variant="secondary">Cancel</Button>
        </div>
      </td>
    </tr>
  );
}

function ZonesTab({
  lines,
  regions,
  zones,
  zoneRegions,
  onChanged,
}: {
  lines: LineRow[];
  regions: RegionRow[];
  zones: LineZoneRow[];
  zoneRegions: LineZoneRegionRow[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingZone, setEditingZone] = useState<string | null>(null);
  const [busyZone, setBusyZone] = useState<string | null>(null);

  // Add-zone form state
  const [addLineId, setAddLineId] = useState<string>(lines[0] ? String(lines[0].id) : "");
  const [addZoneCode, setAddZoneCode] = useState("");
  const [addRmHrId, setAddRmHrId] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addRegions, setAddRegions] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  function toggleAddRegion(code: string) {
    setAddRegions((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function handleAdd() {
    setAdding(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/org-territory-mapping/zones", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          zoneCode: addZoneCode,
          lineId: Number(addLineId),
          rmHrId: addRmHrId,
          label: addLabel,
          regionCodes: [...addRegions],
        }),
      });
      const payload = await readJson<{ success: boolean; error?: string }>(response);
      if (!payload.success) {
        setError(payload.error ?? "Failed to create zone.");
        return;
      }
      setMessage("Zone created.");
      setAddZoneCode("");
      setAddRmHrId("");
      setAddLabel("");
      setAddRegions(new Set());
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to create zone.");
    } finally {
      setAdding(false);
    }
  }

  async function handleSaveEdit(zoneCode: string, values: { rmHrId: string; label: string; regionCodes: string[] }) {
    setBusyZone(zoneCode);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/org-territory-mapping/zones", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ zoneCode, ...values }),
      });
      const payload = await readJson<{ success: boolean; error?: string }>(response);
      if (!payload.success) {
        setError(payload.error ?? "Failed to update zone.");
        return;
      }
      setMessage("Zone updated.");
      setEditingZone(null);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update zone.");
    } finally {
      setBusyZone(null);
    }
  }

  async function handleDelete(zoneCode: string) {
    if (!confirm(`Delete zone ${zoneCode}? This only removes the display label, not any employee data.`)) return;
    setBusyZone(zoneCode);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/org-territory-mapping/zones", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ zoneCode }),
      });
      const payload = await readJson<{ success: boolean; error?: string }>(response);
      if (!payload.success) {
        setError(payload.error ?? "Failed to delete zone.");
        return;
      }
      setMessage("Zone deleted.");
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to delete zone.");
    } finally {
      setBusyZone(null);
    }
  }

  return (
    <div className="space-y-5">
      <AdminTableShell
        description="Display-only Regional Manager territory labels (e.g. PD-Z1 = {AB, D1, D2}). These do NOT drive Sales access control — visibility is computed from the org hierarchy."
        title="RM Zones"
      >
        <div className="space-y-4 p-4 md:p-5">
          {error ? (
            <AdminCallout tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>{error}</p>
            </AdminCallout>
          ) : null}
          {message ? (
            <AdminCallout tone="success">
              <CheckCircle2 className="mt-0.5 h-4 w-4" />
              <p>{message}</p>
            </AdminCallout>
          ) : null}

          <div className="overflow-x-auto">
            <div className="overflow-hidden rounded-[16px] border border-[#E2E8F0]">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="bg-[#020617] text-white">
                    <th className={tableHeaderClassName}>Zone Code</th>
                    <th className={tableHeaderClassName}>RM HR_ID</th>
                    <th className={tableHeaderClassName}>Label</th>
                    <th className={tableHeaderClassName}>Regions</th>
                    <th className={tableHeaderClassName}>Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#FFE8D6]">
                  {zones.map((zone) =>
                    editingZone === zone.zone_code ? (
                      <ZoneEditRow
                        key={zone.zone_code}
                        lines={lines}
                        onCancel={() => setEditingZone(null)}
                        onSave={(values) => handleSaveEdit(zone.zone_code, values)}
                        regions={regions}
                        zone={zone}
                        zoneRegions={zoneRegions}
                      />
                    ) : (
                      <tr key={zone.zone_code}>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-bold text-[#0F172A]">
                          {zone.zone_code}
                          <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#94A3B8]">
                            {lines.find((l) => l.id === zone.line_id)?.code ?? zone.line_id}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-[#334155]">{zone.rm_hr_id ?? "-"}</td>
                        <td className="px-3 py-2 text-[#334155]">{zone.label || "-"}</td>
                        <td className="px-3 py-2"><ZoneMembers regions={regions} zoneCode={zone.zone_code} zoneRegions={zoneRegions} /></td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button className="h-8" disabled={busyZone === zone.zone_code} onClick={() => setEditingZone(zone.zone_code)} type="button" variant="secondary">
                              Edit
                            </Button>
                            <Button
                              className="h-8 gap-1 border border-rose-200 text-rose-600 hover:bg-rose-50"
                              disabled={busyZone === zone.zone_code}
                              onClick={() => void handleDelete(zone.zone_code)}
                              type="button"
                              variant="secondary"
                            >
                              {busyZone === zone.zone_code ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ),
                  )}
                  {zones.length === 0 ? (
                    <tr>
                      <td className="px-3 py-8 text-center text-sm font-semibold text-[#64748B]" colSpan={5}>
                        No zones yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </AdminTableShell>

      <Card className="rounded-none border border-[#D8E0EA] bg-white/95 p-5 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
        <div className="space-y-3">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">Add Zone</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Line</span>
              <select className={cn(selectClassName, "w-40")} onChange={(event) => setAddLineId(event.target.value)} value={addLineId}>
                {lines.map((line) => (
                  <option key={line.id} value={line.id}>{line.name} ({line.code})</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Zone Code</span>
              <input
                className={cn(inputClassName, "w-36")}
                onChange={(event) => setAddZoneCode(event.target.value)}
                placeholder="e.g. PD-Z2"
                value={addZoneCode}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">RM HR_ID</span>
              <input
                className={cn(inputClassName, "w-32")}
                onChange={(event) => setAddRmHrId(event.target.value)}
                placeholder="optional"
                value={addRmHrId}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Label</span>
              <input
                className={cn(inputClassName, "w-56")}
                onChange={(event) => setAddLabel(event.target.value)}
                placeholder="Territory label"
                value={addLabel}
              />
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Regions</span>
              <div className="flex flex-wrap gap-2 pt-1.5">
                {regions.map((region) => (
                  <label className="flex items-center gap-1 text-xs font-semibold text-[#334155]" key={region.region_code}>
                    <input checked={addRegions.has(region.region_code)} onChange={() => toggleAddRegion(region.region_code)} type="checkbox" />
                    {region.region_code}
                  </label>
                ))}
              </div>
            </div>
            <Button
              className="h-9 gap-1 rounded-none bg-[#F97316] font-black text-white hover:bg-[#EA6A0C]"
              disabled={adding || !addZoneCode.trim() || !addLineId}
              onClick={() => void handleAdd()}
              type="button"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Zone
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function OrgTerritoryMappingWorkspace({ initialData, initialError }: Props) {
  const [data, setData] = useState(initialData);
  const [tab, setTab] = useState<"map" | "zones">("map");
  const [loadError] = useState(initialError);

  async function refresh() {
    try {
      const response = await fetch("/api/admin/org-territory-mapping", { cache: "no-store" });
      const payload = await readJson<{ success: boolean; data?: TerritoryMappingData; error?: string }>(response);
      if (payload.success && payload.data) setData(payload.data);
    } catch {
      // Keep the last known-good state; the mutating action already surfaced its own error.
    }
  }

  if (loadError) {
    return (
      <div className="space-y-6 p-6 sm:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{loadError}</p>
        </AdminCallout>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <AdminPageHero
        description="Maintain the (line, area) → region lookup that Sales scope resolution reads, plus the display-only Regional Manager zone labels. Changes are live immediately — no migration needed."
        eyebrow="Sales · Master Data"
        icon={<MapPinned className="h-4 w-4" />}
        title="Org / Territory Mapping"
      />

      <div className="flex flex-wrap gap-2 rounded-none border border-[#D8E0EA] bg-white/90 p-2 shadow-[0_14px_32px_rgba(15,23,42,0.06)]">
        <Button
          className={cn("gap-2 rounded-none font-black", tab === "map" ? "bg-[#0B0B0B] text-white hover:bg-[#F97316]" : "")}
          onClick={() => setTab("map")}
          variant="secondary"
        >
          Area × Line → Region
        </Button>
        <Button
          className={cn("gap-2 rounded-none font-black", tab === "zones" ? "bg-[#0B0B0B] text-white hover:bg-[#F97316]" : "")}
          onClick={() => setTab("zones")}
          variant="secondary"
        >
          RM Zones
        </Button>
      </div>

      {tab === "map" ? (
        <AreaRegionGrid
          areas={data.areas}
          lines={data.lines}
          map={data.map}
          onSaved={(row) =>
            setData((current) => ({
              ...current,
              map: [...current.map.filter((entry) => !(entry.line_id === row.line_id && entry.area_code === row.area_code)), row],
            }))
          }
          regions={data.regions}
        />
      ) : (
        <ZonesTab
          lines={data.lines}
          onChanged={() => void refresh()}
          regions={data.regions}
          zoneRegions={data.zoneRegions}
          zones={data.zones}
        />
      )}
    </div>
  );
}
