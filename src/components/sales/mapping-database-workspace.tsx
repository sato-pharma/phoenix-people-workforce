"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Download, Loader2, Plus, Save, Trash2, Upload } from "lucide-react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { MappingCombobox } from "@/components/sales/source-of-sales-mapping-tab";
import { DistributorWorkspaceShell } from "@/components/sales/distributor-workspace-shell";
import { MappingLookupPanel } from "@/components/sales/mapping-lookup-panel";
import { WeeklyBranchMappingManager } from "@/components/sales/weekly/weekly-branch-mapping-manager";
import { WeeklyProductMappingManager } from "@/components/sales/weekly/weekly-product-mapping-manager";
import { WrongTownFinder } from "@/components/sales/wrong-town-finder";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";

type Props = {
  distributors: SalesDistributorEntry[];
  products: { code: string; name: string }[];
  bricks: { id: string; name: string }[];
};

const PAGE = 50;
const panel = "rounded-2xl border border-phx-line bg-white/95 shadow-[0_8px_22px_rgba(15,23,42,0.06)]";
const headRow = "sticky top-0 bg-[#020617] text-left text-phx-xs font-black uppercase tracking-[0.12em] text-white";

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { return { success: false, error: text } as unknown as T; }
}

const bulkBtn = "inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink-2 transition hover:border-phx-accent-line disabled:opacity-60";

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
    <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-dashed border-phx-line bg-[#FCFDFE] px-3 py-2">
      <span className="text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Bulk XLSX</span>
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
type CustomerRow = { customerCode: string; customerName: string; address: string; brickId: string; areaCode: string; regionCode: string; source?: string; confidence?: number | null };

const SOURCE_FILTERS = [
  { key: "", label: "All" },
  { key: "auto", label: "Auto" },
  { key: "normalizer", label: "Normalizer" },
  { key: "manual", label: "Manual" },
  { key: "admin-import", label: "Import" },
] as const;

function CustomersTab({ distributorCode, bricks }: { distributorCode: string; bricks: { id: string; name: string }[] }) {
  const brickOptions = bricks.map((b) => ({ code: b.id, name: b.name }));
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({}); // customerCode -> new brickId
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // add form
  const [addCode, setAddCode] = useState(""); const [addName, setAddName] = useState(""); const [addBrick, setAddBrick] = useState("");

  const load = useCallback(async (nextOffset: number, q: string, src?: string) => {
    setLoading(true); setError(null);
    try {
      const url = `/api/sales/mapping-database/customer-map?distributor=${encodeURIComponent(distributorCode)}&search=${encodeURIComponent(q)}&limit=${PAGE}&offset=${nextOffset}&source=${encodeURIComponent(src ?? "")}`;
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

  // One definition per control, used by BOTH the desktop row and the mobile card, so the phone can
  // never drift into a read-only copy of an editable table. Every one is `w-full` — the fixed
  // `w-40`/`w-48`/`w-56` they carried are exactly the un-shrinkable widths that dragged this table
  // to 561px inside a 283px container at 375px, and the wrapper's `overflow-auto` then scrolled it
  // sideways. The colgroup owns the widths now, so the table cannot exceed its container.
  const cardLabel = "mb-1 block text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint";
  const brickFor = (r: CustomerRow) => edits[r.customerCode] ?? r.brickId;

  const customerFacts = (r: CustomerRow) => (
    <>
      <span className="block break-words font-semibold text-phx-ink">{r.customerName || r.customerCode}</span>
      <span className="block break-words font-mono text-xs text-phx-ink-soft">{r.customerCode}{r.address ? ` · ${r.address}` : ""}</span>
      {r.source === "auto" ? (
        <span className="mt-0.5 inline-flex items-center gap-1 rounded-full border border-phx-info-line bg-phx-info-bg px-1.5 py-0.5 text-phx-sm font-bold text-phx-info">
          AUTO{typeof r.confidence === "number" ? ` · ${r.confidence}%` : ""}
        </span>
      ) : null}
    </>
  );
  const brickPicker = (r: CustomerRow) => (
    <MappingCombobox onChange={(v) => setEdits((p) => ({ ...p, [r.customerCode]: v }))} options={brickOptions} placeholder="brick" value={brickFor(r)} />
  );
  const saveButton = (r: CustomerRow) => (brickFor(r) === r.brickId ? null : (
    <Button className="h-8 gap-1 bg-[#0B0B0B] font-black text-white hover:bg-phx-accent" disabled={busyKey === r.customerCode}
      onClick={async () => { if (await post({ action: "upsert", distributorCode, customerCode: r.customerCode, customerName: r.customerName, address: r.address, brickId: brickFor(r) }, r.customerCode)) void load(offset, search, sourceFilter); }}
      type="button">{busyKey === r.customerCode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save</Button>
  ));
  const deleteButton = (r: CustomerRow) => (
    <Button className="h-8 gap-1 border border-rose-200 text-rose-600 hover:bg-rose-50" disabled={busyKey === r.customerCode}
      onClick={async () => { if (confirm(`Delete mapping for ${r.customerCode}?`) && await post({ action: "delete", distributorCode, customerCode: r.customerCode }, r.customerCode)) void load(offset, search, sourceFilter); }}
      type="button" variant="secondary"><Trash2 className="h-3.5 w-3.5" /></Button>
  );

  const addCodeInput = <input className={phxFieldClassName} onChange={(e) => setAddCode(e.target.value)} placeholder="customer code" value={addCode} />;
  const addNameInput = <input className={phxFieldClassName} onChange={(e) => setAddName(e.target.value)} placeholder="name (optional)" value={addName} />;
  const addBrickPicker = <MappingCombobox onChange={setAddBrick} options={brickOptions} placeholder="brick (B10…)" value={addBrick} />;
  const addButton = (
    <Button className="h-8 w-full gap-1 bg-phx-accent font-black text-white hover:bg-[#EA6A0C] md:w-auto" disabled={busyKey === "add" || !addCode.trim() || !addBrick}
      onClick={async () => { if (await post({ action: "upsert", distributorCode, customerCode: addCode.trim(), customerName: addName.trim(), brickId: addBrick }, "add")) { setAddCode(""); setAddName(""); setAddBrick(""); void load(offset, search, sourceFilter); } }}
      type="button">{busyKey === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Add</Button>
  );

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={cn(phxFieldClassName, "sm:w-64")}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(0, search, sourceFilter); }}
          placeholder="Search code / name / address"
          value={search}
        />
        <Button className="h-9" onClick={() => void load(0, search, sourceFilter)} type="button" variant="secondary">Search</Button>
        <span className="text-xs text-phx-ink-soft">{total.toLocaleString()} mapped</span>
        <span className="ml-2 inline-flex items-center gap-1">
          {SOURCE_FILTERS.map((f) => (
            <button
              className={cn(
                "h-7 rounded-full border px-2.5 text-phx-xs font-bold transition",
                sourceFilter === f.key ? "border-phx-accent bg-[#FFF3E8] text-phx-accent-press" : "border-phx-line bg-white text-phx-ink-soft hover:border-phx-accent-line",
              )}
              key={f.key || "all"}
              onClick={() => { setSourceFilter(f.key); void load(0, search, f.key); }}
              type="button"
            >{f.label}</button>
          ))}
        </span>
        {loading ? <Loader2 className="h-4 w-4 animate-spin text-phx-accent" /> : null}
      </div>

      <MappingBulkBar
        onImported={() => void load(0, search, sourceFilter)}
        templateHref={`/api/sales/monthly-import/customer-mapping/template?distributor=${encodeURIComponent(distributorCode)}`}
        templateLabel="Download template (your current map)"
        uploadFields={{ distributorCode }}
        uploadUrl="/api/sales/monthly-import/customer-mapping"
      />

      {error ? <AdminCallout tone="danger"><span>{error}</span></AdminCallout> : null}

      {/* A phone gets cards, a desktop gets the table (the admin-shell rule) — three editable
          columns cannot hold a code input, a brick combobox and two buttons inside 283px, and
          squeezing them is what made this table scroll sideways in the first place. */}
      <div className="space-y-2 md:hidden">
        <div className="space-y-2 border border-[#FFE8D6] bg-[#FFFBF5] p-3">
          <div><span className={cardLabel}>Customer</span>{addCodeInput}<div className="mt-1">{addNameInput}</div></div>
          <div><span className={cardLabel}>Brick</span>{addBrickPicker}</div>
          {addButton}
        </div>
        {rows.map((r) => (
          <div className="space-y-2 border border-phx-line p-3" key={r.customerCode}>
            <div>{customerFacts(r)}</div>
            <div><span className={cardLabel}>Brick</span>{brickPicker(r)}</div>
            <div className="flex flex-wrap items-center gap-1.5">{saveButton(r)}{deleteButton(r)}</div>
          </div>
        ))}
        {rows.length === 0 && !loading ? <p className="border border-phx-line p-4 text-center text-xs text-phx-ink-soft">No customer mappings yet.</p> : null}
      </div>

      <div className="hidden overflow-hidden rounded-xl border border-phx-line md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[38%]" /><col className="w-[38%]" /><col className="w-[24%]" />
          </colgroup>
          <thead className={headRow}><tr>
            <th className="px-3 py-2">Customer</th><th className="px-3 py-2">Brick</th><th className="px-3 py-2 text-right">Actions</th>
          </tr></thead>
          <tbody>
            {/* add row */}
            <tr className="border-b border-[#FFE8D6] bg-[#FFFBF5]">
              <td className="px-3 py-2">{addCodeInput}<div className="mt-1">{addNameInput}</div></td>
              <td className="px-3 py-2">{addBrickPicker}</td>
              <td className="px-3 py-2 text-right">{addButton}</td>
            </tr>
            {rows.map((r) => (
              <tr className="border-b border-[#FFE8D6] align-top" key={r.customerCode}>
                <td className="px-3 py-2">{customerFacts(r)}</td>
                <td className="px-3 py-2">{brickPicker(r)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center justify-end gap-1.5">{saveButton(r)}{deleteButton(r)}</div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading ? <tr><td className="px-3 py-6 text-center text-xs text-phx-ink-soft" colSpan={3}>No customer mappings yet.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-phx-ink-soft">
        <span>Showing {rows.length ? offset + 1 : 0}–{offset + rows.length} of {total.toLocaleString()}</span>
        <div className="flex gap-2">
          <Button className="h-8" disabled={offset === 0 || loading} onClick={() => void load(Math.max(0, offset - PAGE), search, sourceFilter)} type="button" variant="secondary">Prev</Button>
          <Button className="h-8" disabled={offset + PAGE >= total || loading} onClick={() => void load(offset + PAGE, search, sourceFilter)} type="button" variant="secondary">Next</Button>
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

  // One definition per control, shared by the desktop row and the mobile card. Both the raw-text
  // input and the code combobox carried `w-56`; two of those plus an Add button cannot fit inside
  // 283px, so the table reached 561px and the wrapper's `overflow-auto` scrolled it sideways.
  const cardLabel = "mb-1 block text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint";
  // The mapped target is shown by its name; the code stays only when the list has no name for it.
  const targetName = (code: string) => options.find((option) => option.code === code)?.name || code;
  const addRawInput = <input className={phxFieldClassName} onChange={(e) => setAddRaw(e.target.value)} placeholder={kind === "product" ? "item code or name" : "area text"} value={addRaw} />;
  const addCodePicker = <MappingCombobox onChange={setAddCode} options={options} placeholder={codeLabel} value={addCode} />;
  const addButton = (
    <Button className="h-8 w-full gap-1 bg-phx-accent font-black text-white hover:bg-[#EA6A0C] md:w-auto" disabled={busyKey === "add" || !addRaw.trim() || !addCode}
      onClick={async () => { if (await post({ action: "upsert", distributorCode, raw: addRaw.trim(), code: addCode }, "add")) { setAddRaw(""); setAddCode(""); void load(); } }}
      type="button">{busyKey === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Add</Button>
  );
  const deleteButton = (r: AliasRow) => (
    <Button className="h-8 gap-1 border border-rose-200 text-rose-600 hover:bg-rose-50" disabled={busyKey === r.normalizedAlias}
      onClick={async () => { if (confirm(`Delete mapping "${r.alias || r.normalizedAlias}"?`) && await post({ action: "delete", distributorCode, normalizedAlias: r.normalizedAlias, code: r.code }, r.normalizedAlias)) void load(); }}
      type="button" variant="secondary"><Trash2 className="h-3.5 w-3.5" /></Button>
  );

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2 text-xs text-phx-ink-soft">{rows.length} mapped {loading ? <Loader2 className="h-4 w-4 animate-spin text-phx-accent" /> : null}</div>
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
      {/* Cards on a phone, the table from `md` up — the admin-shell rule. An alias is raw
          distributor text, so every cell wraps with `break-words`: a single unspaced item name is
          wider than a fixed column, and nothing scrolls to reveal what a fixed column cuts. */}
      <div className="space-y-2 md:hidden">
        <div className="space-y-2 border border-[#FFE8D6] bg-[#FFFBF5] p-3">
          <div><span className={cardLabel}>Raw {kind === "product" ? "item" : "territory"}</span>{addRawInput}</div>
          <div><span className={cardLabel}>Phoenix {codeLabel}</span>{addCodePicker}</div>
          {addButton}
        </div>
        {rows.map((r) => (
          <div className="flex items-start justify-between gap-2 border border-phx-line p-3" key={`${r.normalizedAlias}-${r.code}`}>
            <div className="min-w-0">
              <span className="block break-words font-semibold text-phx-ink">{r.alias || r.normalizedAlias}</span>
              <span className="mt-0.5 block break-words text-xs text-phx-ink">{targetName(r.code)}</span>
            </div>
            {deleteButton(r)}
          </div>
        ))}
        {rows.length === 0 && !loading ? <p className="border border-phx-line p-4 text-center text-xs text-phx-ink-soft">No mappings yet.</p> : null}
      </div>

      <div className="hidden overflow-hidden rounded-xl border border-phx-line md:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[42%]" /><col className="w-[42%]" /><col className="w-[16%]" />
          </colgroup>
          <thead className={headRow}><tr><th className="px-3 py-2">Raw {kind === "product" ? "item" : "territory"}</th><th className="px-3 py-2">Phoenix {codeLabel}</th><th className="px-3 py-2 text-right">Actions</th></tr></thead>
          <tbody>
            <tr className="border-b border-[#FFE8D6] bg-[#FFFBF5]">
              <td className="px-3 py-2">{addRawInput}</td>
              <td className="px-3 py-2">{addCodePicker}</td>
              <td className="px-3 py-2 text-right">{addButton}</td>
            </tr>
            {rows.map((r) => (
              <tr className="border-b border-[#FFE8D6] align-top" key={`${r.normalizedAlias}-${r.code}`}>
                <td className="break-words px-3 py-2 font-semibold text-phx-ink">{r.alias || r.normalizedAlias}</td>
                <td className="break-words px-3 py-2 text-xs text-phx-ink">{targetName(r.code)}</td>
                <td className="px-3 py-2 text-right">{deleteButton(r)}</td>
              </tr>
            ))}
            {rows.length === 0 && !loading ? <tr><td className="px-3 py-6 text-center text-xs text-phx-ink-soft" colSpan={3}>No mappings yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className={cn("rounded-[6px] px-3.5 py-1.5 text-sm font-black transition", active ? "bg-[#0B0B0B] text-white" : "text-phx-ink hover:bg-phx-accent-soft")}
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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-phx-line bg-gradient-to-b from-white to-slate-50/50 px-4 py-3">
        <div>
          <h2 className="text-lg font-black tracking-tight text-slate-900">{selected.name} <span className="font-mono text-sm text-phx-ink-faint">{selected.code}</span></h2>
          <p className="text-xs text-phx-ink-soft">Edits here are live everywhere immediately — upload, normalizer, missing data.</p>
        </div>
        <div className="flex gap-1.5">
          <TabButton active={cadence === "monthly"} onClick={() => setCadence("monthly")}>Monthly</TabButton>
          {selected.weeklySupported ? <TabButton active={cadence === "weekly"} onClick={() => setCadence("weekly")}>Weekly</TabButton> : null}
        </div>
      </div>

      {cadence === "monthly" ? (
        <div>
          <div className="flex gap-1.5 border-b border-phx-line px-4 py-2">
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
          <div className="flex gap-1.5 border-b border-phx-line px-4 py-2">
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
  const [view, setView] = useState<"distributor" | "wrong-town">("distributor");
  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Header styled to match /sales/weekly exactly — same content as before, just re-skinned. */}
      <header>
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 rounded-full bg-phx-accent" />
          <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-accent">Sales · One connected module</span>
        </div>
        <h1 className="mt-1 text-xl font-black text-phx-ink">Mapping Database</h1>
        <p className="mt-1 text-sm font-medium text-phx-ink-soft">
          The single source of truth for every distributor&apos;s mappings. Edit one row at a time, or bulk
          import/export with the XLSX template — changes are live across upload, normalizer and missing-data
          instantly.
        </p>
      </header>
      <MappingLookupPanel />
      <div className="flex flex-wrap gap-1.5">
        <TabButton active={view === "distributor"} onClick={() => setView("distributor")}>By distributor</TabButton>
        <TabButton active={view === "wrong-town"} onClick={() => setView("wrong-town")}>Wrong town</TabButton>
      </div>
      {view === "distributor" ? (
        <DistributorWorkspaceShell distributors={distributors}>
          {(selected) => <DistributorMapping bricks={bricks} products={products} selected={selected} />}
        </DistributorWorkspaceShell>
      ) : (
        <Card className="overflow-hidden p-0">
          <WrongTownFinder distributors={distributors} />
        </Card>
      )}
    </div>
  );
}
