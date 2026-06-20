"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Database, Download, Loader2, Plus, Save, Trash2, Upload } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { MappingCombobox } from "@/components/sales/source-of-sales-mapping-tab";
import { DistributorWorkspaceShell } from "@/components/sales/distributor-workspace-shell";
import { WeeklyBranchMappingManager } from "@/components/sales/weekly/weekly-branch-mapping-manager";
import { WeeklyProductMappingManager } from "@/components/sales/weekly/weekly-product-mapping-manager";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import { cn } from "@/lib/utils";

type Props = {
  distributors: SalesDistributorEntry[];
  products: { code: string; name: string }[];
  bricks: { id: string; name: string }[];
};

const PAGE = 50;
const panel = "rounded-2xl border border-[#D8E0EA] bg-white/95 shadow-[0_8px_22px_rgba(15,23,42,0.06)]";
const headRow = "sticky top-0 bg-[#020617] text-left text-[11px] font-black uppercase tracking-[0.12em] text-white";

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { return { success: false, error: text } as unknown as T; }
}

const bulkBtn = "inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-xs font-bold text-[#334155] transition hover:border-[#FDBA74] disabled:opacity-60";

// Bulk XLSX bar (download the template — pre-filled with the current mappings, so it doubles as the
// export — then upload the filled sheet). Wired to the existing /api/sales/monthly-import/*-mapping
// routes; refreshes the tab's list after a successful import. Mirrors the Weekly Mapping flow.
function MappingBulkBar({ templateHref, templateLabel, uploadUrl, uploadFields, onImported }: {
  templateHref: string;
  templateLabel: string;
  uploadUrl: string;
  uploadFields?: Record<string, string>;
  onImported: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function onUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true); setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      for (const [key, value] of Object.entries(uploadFields ?? {})) form.append(key, value);
      const res = await fetch(uploadUrl, { method: "POST", body: form });
      const payload = await readJson<{ success?: boolean; message?: string; error?: string; result?: { blockedRows?: { rowNumber: number; reason: string }[] } }>(res);
      if (payload.success) {
        setResult({ ok: true, text: payload.message ?? "Imported." });
        onImported();
      } else {
        const blocked = payload.result?.blockedRows ?? [];
        setResult({
          ok: false,
          text: blocked.length
            ? `${payload.error ?? "Import blocked."} First issue — row ${blocked[0].rowNumber}: ${blocked[0].reason}`
            : payload.error ?? "Import failed.",
        });
      }
    } catch (caught) {
      setResult({ ok: false, text: caught instanceof Error ? caught.message : "Import failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-dashed border-[#E2E8F0] bg-[#FCFDFE] px-3 py-2">
      <span className="text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Bulk XLSX</span>
      <a className={bulkBtn} href={templateHref}><Download className="h-4 w-4" /> {templateLabel}</a>
      <button className={bulkBtn} disabled={busy} onClick={() => fileRef.current?.click()} type="button">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import filled .xlsx
      </button>
      <input ref={fileRef} accept=".xlsx" className="hidden" onChange={onUpload} type="file" />
      {result ? <span className={cn("text-xs font-semibold", result.ok ? "text-emerald-700" : "text-rose-600")}>{result.text}</span> : null}
    </div>
  );
}

type MonthlyTab = "customers" | "products" | "territories";

// ── Customers (per distributor, server-paginated + searchable) ──
type CustomerRow = { customerCode: string; customerName: string; address: string; brickId: string; areaCode: string; regionCode: string };

function CustomersTab({ distributorCode, bricks }: { distributorCode: string; bricks: { id: string; name: string }[] }) {
  const brickOptions = bricks.map((b) => ({ code: b.id, name: b.name }));
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({}); // customerCode -> new brickId
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // add form
  const [addCode, setAddCode] = useState(""); const [addName, setAddName] = useState(""); const [addBrick, setAddBrick] = useState("");

  const load = useCallback(async (nextOffset: number, q: string) => {
    setLoading(true); setError(null);
    try {
      const url = `/api/sales/mapping-database/customer-map?distributor=${encodeURIComponent(distributorCode)}&search=${encodeURIComponent(q)}&limit=${PAGE}&offset=${nextOffset}`;
      const res = await fetch(url);
      const payload = await readJson<{ success: boolean; rows?: CustomerRow[]; total?: number; error?: string }>(res);
      if (!payload.success) { setError(payload.error ?? "Failed to load."); return; }
      setRows(payload.rows ?? []); setTotal(payload.total ?? 0); setOffset(nextOffset);
      setEdits({});
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load."); }
    finally { setLoading(false); }
  }, [distributorCode]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(0, ""); setSearch(""); }, [load]);

  async function post(body: Record<string, unknown>, key: string) {
    setBusyKey(key); setError(null);
    try {
      const res = await fetch("/api/sales/mapping-database/customer-map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await readJson<{ success: boolean; error?: string }>(res);
      if (!payload.success) { setError(payload.error ?? "Save failed."); return false; }
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed."); return false; }
    finally { setBusyKey(null); }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="h-9 w-64 rounded-[6px] border border-[#E2E8F0] px-3 text-sm outline-none focus:border-[#FDBA74]"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(0, search); }}
          placeholder="Search code / name / address"
          value={search}
        />
        <Button className="h-9" onClick={() => void load(0, search)} type="button" variant="secondary">Search</Button>
        <span className="text-xs text-[#64748B]">{total.toLocaleString()} mapped</span>
        {loading ? <Loader2 className="h-4 w-4 animate-spin text-[#F97316]" /> : null}
      </div>

      <MappingBulkBar
        onImported={() => void load(0, search)}
        templateHref={`/api/sales/monthly-import/customer-mapping/template?distributor=${encodeURIComponent(distributorCode)}`}
        templateLabel="Download template (your current map)"
        uploadFields={{ distributorCode }}
        uploadUrl="/api/sales/monthly-import/customer-mapping"
      />

      {error ? <AdminCallout tone="danger"><span>{error}</span></AdminCallout> : null}

      <div className="overflow-auto rounded-xl border border-[#E2E8F0]">
        <table className="w-full text-sm">
          <thead className={headRow}><tr>
            <th className="px-3 py-2">Customer</th><th className="px-3 py-2">Brick</th><th className="px-3 py-2 text-right">Actions</th>
          </tr></thead>
          <tbody>
            {/* add row */}
            <tr className="border-b border-[#FFE8D6] bg-[#FFFBF5]">
              <td className="px-3 py-2">
                <input className="mb-1 h-8 w-40 rounded border border-[#E2E8F0] px-2 text-xs" onChange={(e) => setAddCode(e.target.value)} placeholder="customer code" value={addCode} />
                <input className="h-8 w-48 rounded border border-[#E2E8F0] px-2 text-xs" onChange={(e) => setAddName(e.target.value)} placeholder="name (optional)" value={addName} />
              </td>
              <td className="px-3 py-2"><div className="w-56"><MappingCombobox onChange={setAddBrick} options={brickOptions} placeholder="brick (B10…)" value={addBrick} /></div></td>
              <td className="px-3 py-2 text-right">
                <Button className="h-8 gap-1 bg-[#F97316] font-black text-white hover:bg-[#EA6A0C]" disabled={busyKey === "add" || !addCode.trim() || !addBrick}
                  onClick={async () => { if (await post({ action: "upsert", distributorCode, customerCode: addCode.trim(), customerName: addName.trim(), brickId: addBrick }, "add")) { setAddCode(""); setAddName(""); setAddBrick(""); void load(offset, search); } }}
                  type="button">{busyKey === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Add</Button>
              </td>
            </tr>
            {rows.map((r) => {
              const editing = edits[r.customerCode] ?? r.brickId;
              const dirty = editing !== r.brickId;
              return (
                <tr className="border-b border-[#FFE8D6]" key={r.customerCode}>
                  <td className="px-3 py-2">
                    <span className="block font-semibold text-[#0F172A]">{r.customerName || r.customerCode}</span>
                    <span className="block font-mono text-xs text-[#64748B]">{r.customerCode}{r.address ? ` · ${r.address}` : ""}</span>
                  </td>
                  <td className="px-3 py-2"><div className="w-56"><MappingCombobox onChange={(v) => setEdits((p) => ({ ...p, [r.customerCode]: v }))} options={brickOptions} placeholder="brick" value={editing} /></div></td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      {dirty ? (
                        <Button className="h-8 gap-1 bg-[#0B0B0B] font-black text-white hover:bg-[#F97316]" disabled={busyKey === r.customerCode}
                          onClick={async () => { if (await post({ action: "upsert", distributorCode, customerCode: r.customerCode, customerName: r.customerName, address: r.address, brickId: editing }, r.customerCode)) void load(offset, search); }}
                          type="button">{busyKey === r.customerCode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save</Button>
                      ) : null}
                      <Button className="h-8 gap-1 border border-rose-200 text-rose-600 hover:bg-rose-50" disabled={busyKey === r.customerCode}
                        onClick={async () => { if (confirm(`Delete mapping for ${r.customerCode}?`) && await post({ action: "delete", distributorCode, customerCode: r.customerCode }, r.customerCode)) void load(offset, search); }}
                        type="button" variant="secondary"><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !loading ? <tr><td className="px-3 py-6 text-center text-xs text-[#64748B]" colSpan={3}>No customer mappings yet.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-[#64748B]">
        <span>Showing {rows.length ? offset + 1 : 0}–{offset + rows.length} of {total.toLocaleString()}</span>
        <div className="flex gap-2">
          <Button className="h-8" disabled={offset === 0 || loading} onClick={() => void load(Math.max(0, offset - PAGE), search)} type="button" variant="secondary">Prev</Button>
          <Button className="h-8" disabled={offset + PAGE >= total || loading} onClick={() => void load(offset + PAGE, search)} type="button" variant="secondary">Next</Button>
        </div>
      </div>
    </div>
  );
}

// ── Aliases (products per-distributor + territories global) ──
type AliasRow = { alias: string; normalizedAlias: string; code: string; kind: "product" | "territory" };

function AliasTab({ distributorCode, kind, options, codeLabel }: { distributorCode: string; kind: "product" | "territory"; options: { code: string; name: string }[]; codeLabel: string }) {
  const [rows, setRows] = useState<AliasRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [addRaw, setAddRaw] = useState(""); const [addCode, setAddCode] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/sales/mapping-database/aliases?distributor=${encodeURIComponent(distributorCode)}`);
      const payload = await readJson<{ success: boolean; products?: { alias: string; normalizedAlias: string; productCode: string }[]; territories?: { alias: string; normalizedAlias: string; targetCode: string }[]; error?: string }>(res);
      if (!payload.success) { setError(payload.error ?? "Failed to load."); return; }
      if (kind === "product") setRows((payload.products ?? []).map((p) => ({ alias: p.alias, normalizedAlias: p.normalizedAlias, code: p.productCode, kind })));
      else setRows((payload.territories ?? []).map((t) => ({ alias: t.alias, normalizedAlias: t.normalizedAlias, code: t.targetCode, kind })));
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load."); }
    finally { setLoading(false); }
  }, [distributorCode, kind]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function post(body: Record<string, unknown>, key: string) {
    setBusyKey(key); setError(null);
    try {
      const res = await fetch("/api/sales/mapping-database/aliases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: kind, ...body }) });
      const payload = await readJson<{ success: boolean; error?: string }>(res);
      if (!payload.success) { setError(payload.error ?? "Save failed."); return false; }
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed."); return false; }
    finally { setBusyKey(null); }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2 text-xs text-[#64748B]">{rows.length} mapped {loading ? <Loader2 className="h-4 w-4 animate-spin text-[#F97316]" /> : null}</div>
      <MappingBulkBar
        onImported={() => void load()}
        templateHref={kind === "product"
          ? `/api/sales/monthly-import/product-mapping/template?distributor=${encodeURIComponent(distributorCode)}`
          : "/api/sales/monthly-import/territory-mapping/template"}
        templateLabel="Download template (current mappings)"
        uploadFields={kind === "product" ? { distributorCode } : {}}
        uploadUrl={kind === "product" ? "/api/sales/monthly-import/product-mapping" : "/api/sales/monthly-import/territory-mapping"}
      />
      {error ? <AdminCallout tone="danger"><span>{error}</span></AdminCallout> : null}
      <div className="overflow-auto rounded-xl border border-[#E2E8F0]">
        <table className="w-full text-sm">
          <thead className={headRow}><tr><th className="px-3 py-2">Raw {kind === "product" ? "item" : "territory"}</th><th className="px-3 py-2">Phoenix {codeLabel}</th><th className="px-3 py-2 text-right">Actions</th></tr></thead>
          <tbody>
            <tr className="border-b border-[#FFE8D6] bg-[#FFFBF5]">
              <td className="px-3 py-2"><input className="h-8 w-56 rounded border border-[#E2E8F0] px-2 text-xs" onChange={(e) => setAddRaw(e.target.value)} placeholder={kind === "product" ? "item code or name" : "area text"} value={addRaw} /></td>
              <td className="px-3 py-2"><div className="w-56"><MappingCombobox onChange={setAddCode} options={options} placeholder={codeLabel} value={addCode} /></div></td>
              <td className="px-3 py-2 text-right">
                <Button className="h-8 gap-1 bg-[#F97316] font-black text-white hover:bg-[#EA6A0C]" disabled={busyKey === "add" || !addRaw.trim() || !addCode}
                  onClick={async () => { if (await post({ action: "upsert", distributorCode, raw: addRaw.trim(), code: addCode }, "add")) { setAddRaw(""); setAddCode(""); void load(); } }}
                  type="button">{busyKey === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Add</Button>
              </td>
            </tr>
            {rows.map((r) => (
              <tr className="border-b border-[#FFE8D6]" key={`${r.normalizedAlias}-${r.code}`}>
                <td className="px-3 py-2 font-semibold text-[#0F172A]">{r.alias || r.normalizedAlias}</td>
                <td className="px-3 py-2 font-mono text-xs text-[#0F172A]">{r.code}</td>
                <td className="px-3 py-2 text-right">
                  <Button className="h-8 gap-1 border border-rose-200 text-rose-600 hover:bg-rose-50" disabled={busyKey === r.normalizedAlias}
                    onClick={async () => { if (confirm(`Delete mapping "${r.alias || r.normalizedAlias}"?`) && await post({ action: "delete", distributorCode, normalizedAlias: r.normalizedAlias, code: r.code }, r.normalizedAlias)) void load(); }}
                    type="button" variant="secondary"><Trash2 className="h-3.5 w-3.5" /></Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading ? <tr><td className="px-3 py-6 text-center text-xs text-[#64748B]" colSpan={3}>No mappings yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className={cn("rounded-[6px] px-3.5 py-1.5 text-sm font-black transition", active ? "bg-[#0B0B0B] text-white" : "text-[#0F172A] hover:bg-[#FFF7ED]")}
      onClick={onClick}
      type="button"
    >{children}</button>
  );
}

function DistributorMapping({ selected, products, bricks }: { selected: SalesDistributorEntry; products: { code: string; name: string }[]; bricks: { id: string; name: string }[] }) {
  const [cadence, setCadence] = useState<"monthly" | "weekly">("monthly");
  const [tab, setTab] = useState<MonthlyTab>("customers");
  const [weeklyTab, setWeeklyTab] = useState<"products" | "branches">("products");
  const brickOptions = bricks.map((b) => ({ code: b.id, name: b.name }));

  return (
    <Card className={cn(panel, "overflow-hidden p-0")}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] bg-gradient-to-b from-white to-slate-50/50 px-4 py-3">
        <div>
          <h2 className="text-lg font-black tracking-tight text-slate-900">{selected.name} <span className="font-mono text-sm text-[#94A3B8]">{selected.code}</span></h2>
          <p className="text-xs text-[#64748B]">Edits here are live everywhere immediately — upload, normalizer, missing data.</p>
        </div>
        <div className="flex gap-1.5">
          <TabButton active={cadence === "monthly"} onClick={() => setCadence("monthly")}>Monthly</TabButton>
          {selected.weeklySupported ? <TabButton active={cadence === "weekly"} onClick={() => setCadence("weekly")}>Weekly</TabButton> : null}
        </div>
      </div>

      {cadence === "monthly" ? (
        <div>
          <div className="flex gap-1.5 border-b border-[#E2E8F0] px-4 py-2">
            <TabButton active={tab === "customers"} onClick={() => setTab("customers")}>Customers</TabButton>
            <TabButton active={tab === "products"} onClick={() => setTab("products")}>Products</TabButton>
            <TabButton active={tab === "territories"} onClick={() => setTab("territories")}>Territories</TabButton>
          </div>
          {tab === "customers" ? <CustomersTab bricks={bricks} distributorCode={selected.code} /> : null}
          {tab === "products" ? <AliasTab codeLabel="Product ID" distributorCode={selected.code} kind="product" options={products} /> : null}
          {tab === "territories" ? <AliasTab codeLabel="Brick ID" distributorCode={selected.code} kind="territory" options={brickOptions} /> : null}
        </div>
      ) : (
        <div>
          <div className="flex gap-1.5 border-b border-[#E2E8F0] px-4 py-2">
            <TabButton active={weeklyTab === "products"} onClick={() => setWeeklyTab("products")}>Product Aliases</TabButton>
            <TabButton active={weeklyTab === "branches"} onClick={() => setWeeklyTab("branches")}>Branch → Region</TabButton>
          </div>
          <div className="p-4">
            {weeklyTab === "products" ? (
              <WeeklyProductMappingManager initial={null} initialError={null} key={`p-${selected.code}`} lockedDistributor={selected.code} />
            ) : (
              <WeeklyBranchMappingManager initial={null} initialError={null} key={`b-${selected.code}`} lockedDistributor={selected.code} />
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export function MappingDatabaseWorkspace({ distributors, products, bricks }: Props) {
  return (
    <div className="space-y-5">
      <AdminPageHero
        description="The single source of truth for every distributor's mappings. Edit one row at a time, or bulk import/export with the XLSX template — changes are live across upload, normalizer and missing-data instantly."
        eyebrow="Sales · One connected module"
        icon={<Database className="h-4 w-4" />}
        title="Mapping Database"
      />
      <DistributorWorkspaceShell distributors={distributors}>
        {(selected) => <DistributorMapping bricks={bricks} products={products} selected={selected} />}
      </DistributorWorkspaceShell>
    </div>
  );
}
