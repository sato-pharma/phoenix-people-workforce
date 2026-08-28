"use client";

import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Database,
  Download,
  LayoutGrid,
  Loader2,
  Map as MapIcon,
  MapPin,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Truck,
  UploadCloud,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminTableShell } from "@/components/admin/admin-design-system";
import { DatabaseValidationTab } from "@/components/sales/database-validation-tab";
import { MappingCombobox } from "@/components/sales/source-of-sales-mapping-tab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/sales/format";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import type { HeaderGrid } from "@/lib/sales/normalizer/profile-grid";
import {
  MASTER_DEFINITIONS,
  MASTER_ORDER,
  editableColumns,
  normalizeCode,
  normalizeDisplay,
  type MasterColumn,
  type MasterColumnType,
  type MasterDefinition,
  type MasterKey,
  type MasterRowRecord,
} from "@/lib/sales/master-data/definitions";
import type { MasterImportResult } from "@/lib/sales/master-data/import-service";
import { cn } from "@/lib/utils";

const fieldInputClass = "h-9 border border-phx-line px-2 text-sm text-phx-ink outline-none focus:border-phx-accent-line";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">{label}</span>
      {children}
    </label>
  );
}

const MASTER_ICONS: Record<MasterKey, LucideIcon> = {
  areas: MapPin,
  blocks: LayoutGrid,
  bricks: Boxes,
  distributors: Truck,
  products: Package,
  regions: MapIcon,
};

type Props = {
  initialError: string | null;
  initialHeaderGrid: HeaderGrid;
  initialRows: Record<MasterKey, MasterRowRecord[]>;
};

type ImportResponse = { data?: MasterImportResult; error?: string; message?: string; success: boolean };
type ListResponse = { data?: MasterRowRecord[]; error?: string; success: boolean };

const tableHeaderClassName = "px-4 py-3 text-xs font-black uppercase tracking-[0.14em]";

async function readJson<T extends { error?: string; success: boolean }>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return { success: response.ok, error: response.ok ? undefined : response.statusText } as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { success: false, error: text } as T;
  }
}

function displayCell(column: { key: string; type: MasterColumnType }, row: MasterRowRecord) {
  const value = row[column.key];
  if (value === null || value === undefined || value === "") return "-";
  if (column.type === "number") return formatCurrency(Number(value));
  // Stored as a fraction (0.0341); shown as "3.41%". Two digits because the source ratios carry
  // two decimal places of percent and one digit would collapse distinct areas onto the same label.
  if (column.type === "percent") return formatPercent(Number(value), { digits: 2 });
  return String(value);
}

/** Renders one column's input for both the Add form and inline row editing: a parent picker for
 *  FK code columns (options limited to active parents, so a new/edited row can't be silently
 *  re-parented onto a row that was just deactivated), a plain input otherwise. */
function ColumnField({
  allRows,
  column,
  def,
  disabled,
  onChange,
  value,
}: {
  allRows: Record<MasterKey, MasterRowRecord[]>;
  column: MasterColumn;
  def: MasterDefinition;
  disabled: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  const parent = def.parents.find((p) => p.codeColumn === column.key);
  if (parent) {
    const parentDef = MASTER_DEFINITIONS[parent.parentMaster];
    const parentOptions = (allRows[parent.parentMaster] ?? [])
      .filter((row) => row.active !== false)
      .map((row) => ({ code: String(row[parentDef.keyColumn]), name: String(row[parentDef.keyColumn]) }));
    return <MappingCombobox onChange={onChange} options={parentOptions} placeholder={`Select ${parentDef.label}`} value={value} />;
  }
  const numeric = column.type === "number" || column.type === "percent";
  return (
    <input
      className={cn(fieldInputClass, "w-48")}
      disabled={disabled}
      max={column.type === "percent" ? 1 : undefined}
      min={column.type === "percent" ? 0 : undefined}
      onChange={(event) => onChange(event.target.value)}
      // Percent is entered as the stored fraction, so spell that out — the field shows 0.0341, not
      // 3.41, and a whole-number percent is rejected by the 0..1 bound rather than stored as 341%.
      placeholder={column.type === "percent" ? `${column.label} (0.0341 = 3.41%)` : column.label}
      step={column.type === "percent" ? 0.0001 : undefined}
      type={numeric ? "number" : "text"}
      value={value}
    />
  );
}

function MasterTab({
  allRows,
  def,
  onRowsChange,
  rows,
}: {
  allRows: Record<MasterKey, MasterRowRecord[]>;
  def: MasterDefinition;
  onRowsChange: (rows: MasterRowRecord[]) => void;
  rows: MasterRowRecord[];
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<MasterImportResult | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);
  const [addFormValues, setAddFormValues] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [activeKeyBusy, setActiveKeyBusy] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const editable = editableColumns(def);
  const editableLabels = def.columns.filter((column) => !column.locked).map((column) => column.label);
  const showHierarchyHint = def.parents.length > 0;
  const lookups = def.displayLookups;

  // Build code -> row maps for each referenced parent master so parent NAMES
  // can be resolved for display (the rows store only codes, not names).
  const referenceMaps = useMemo(() => {
    const maps = new Map<MasterKey, Map<string, MasterRowRecord>>();
    for (const lookup of lookups) {
      if (maps.has(lookup.lookupMaster)) continue;
      const parentDef = MASTER_DEFINITIONS[lookup.lookupMaster];
      const byCode = new Map<string, MasterRowRecord>();
      for (const parentRow of allRows[lookup.lookupMaster] ?? []) {
        byCode.set(normalizeCode(parentRow[parentDef.keyColumn]), parentRow);
      }
      maps.set(lookup.lookupMaster, byCode);
    }
    return maps;
  }, [allRows, lookups]);

  function resolveLookup(row: MasterRowRecord, lookup: (typeof lookups)[number]) {
    const parentRow = referenceMaps.get(lookup.lookupMaster)?.get(normalizeCode(row[lookup.viaCodeColumn]));
    const value = parentRow ? normalizeDisplay(parentRow[lookup.lookupColumn]) : "";
    return value || "-";
  }

  async function handleExport() {
    setExporting(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/sales/database-mapping/${def.master}/export`, { cache: "no-store" });
      if (!response.ok) {
        const payload = await readJson<ListResponse>(response);
        setMessage({ type: "error", text: payload.error ?? "Export failed." });
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `phoenix-${def.master}-master.xlsx`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Export failed." });
    } finally {
      setExporting(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/sales/database-mapping/${def.master}`, { cache: "no-store" });
      const payload = await readJson<ListResponse>(response);
      if (payload.success) onRowsChange(payload.data ?? []);
      else setMessage({ type: "error", text: payload.error ?? "Failed to refresh rows." });
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Failed to refresh rows." });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleImport(file: File) {
    setImporting(true);
    setMessage(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`/api/sales/database-mapping/${def.master}/import`, {
        body: formData,
        method: "POST",
      });
      const payload = await readJson<ImportResponse>(response);
      if (payload.success && payload.data) {
        setResult(payload.data);
        setMessage({ type: "success", text: payload.message ?? "Import complete." });
        await refresh();
      } else {
        setMessage({ type: "error", text: payload.error ?? "Import failed." });
      }
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Import failed." });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleAddRow() {
    setAdding(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/sales/database-mapping/${def.master}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addFormValues),
      });
      const payload = await readJson<{ success: boolean; message?: string; error?: string }>(response);
      if (payload.success) {
        setMessage({ type: "success", text: payload.message ?? "Row added successfully." });
        setAddFormValues({});
        await refresh();
      } else {
        setMessage({ type: "error", text: payload.error ?? "Add failed." });
      }
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Add failed." });
    } finally {
      setAdding(false);
    }
  }

  function startEdit(row: MasterRowRecord) {
    const initial: Record<string, string> = {};
    for (const column of editable) {
      const value = row[column.key];
      initial[column.key] = value === null || value === undefined ? "" : String(value);
    }
    setEditingKey(String(row[def.keyColumn]));
    setEditValues(initial);
    setConfirmDeleteKey(null);
    setMessage(null);
  }

  function cancelEdit() {
    setEditingKey(null);
    setEditValues({});
  }

  async function handleSaveEdit(rowKey: string) {
    setSavingEdit(true);
    setMessage(null);
    try {
      // Bricks: only a block_code CHANGE means "move" (relocate spawns a fresh block-prefixed ID
      // and deactivates rowKey — owner preference, 2026-07-23; see relocateBrick). Editing brick_name
      // alone (a rename) is a plain in-place PATCH on the same row, same as every other master.
      const originalRow = rows.find((row) => String(row[def.keyColumn]) === rowKey);
      const originalBlockCode = originalRow ? String(originalRow.block_code ?? "") : "";
      const isBrickRelocate = def.master === "bricks" && (editValues.block_code ?? "") !== originalBlockCode;
      const response = await fetch(
        isBrickRelocate
          ? `/api/sales/database-mapping/bricks/${encodeURIComponent(rowKey)}/relocate`
          : `/api/sales/database-mapping/${def.master}/${encodeURIComponent(rowKey)}`,
        {
          method: isBrickRelocate ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: isBrickRelocate
            ? JSON.stringify({ brickName: editValues.brick_name, newBlockCode: editValues.block_code })
            : JSON.stringify(editValues),
        },
      );
      const payload = await readJson<{ success: boolean; message?: string; error?: string }>(response);
      if (payload.success) {
        setMessage({ type: "success", text: payload.message ?? "Row updated successfully." });
        setEditingKey(null);
        setEditValues({});
        await refresh();
      } else {
        setMessage({ type: "error", text: payload.error ?? "Update failed." });
      }
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Update failed." });
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleSetActive(rowKey: string, active: boolean) {
    setActiveKeyBusy(rowKey);
    setMessage(null);
    try {
      const url = `/api/sales/database-mapping/${def.master}/${encodeURIComponent(rowKey)}`;
      const response = await fetch(url, {
        method: active ? "PATCH" : "DELETE",
        headers: active ? { "Content-Type": "application/json" } : undefined,
        body: active ? JSON.stringify({ active: true }) : undefined,
      });
      const payload = await readJson<{ success: boolean; message?: string; error?: string }>(response);
      if (payload.success) {
        setMessage({ type: "success", text: payload.message ?? (active ? "Row reactivated." : "Row deactivated.") });
        setConfirmDeleteKey(null);
        await refresh();
      } else {
        setMessage({ type: "error", text: payload.error ?? "Update failed." });
      }
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Update failed." });
    } finally {
      setActiveKeyBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="gap-2" disabled={refreshing} onClick={() => void refresh()} variant="secondary">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
            <Button className="gap-2" disabled={exporting} onClick={() => void handleExport()} variant="secondary">
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export XLSX
            </Button>
            <Button
              className="gap-2 bg-[#0B0B0B] text-white hover:bg-phx-accent"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              Import XLSX
            </Button>
            <input
              accept=".xlsx"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImport(file);
              }}
              ref={fileInputRef}
              type="file"
            />
          </div>
        )}
        description={def.description}
        title={def.label}
      >
        <div className="space-y-4 p-4 md:p-5">
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Rows: {formatNumber(rows.length)}</AdminInsightChip>
            <AdminInsightChip tone="orange">
              Editable: {editableLabels.length > 0 ? editableLabels.join(", ") : "none (add-only)"}
            </AdminInsightChip>
          </div>

          {showHierarchyHint ? (
            <AdminCallout tone="neutral">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>Import the masters top-down so parents exist first: Region → Area → Block → Brick.</p>
            </AdminCallout>
          ) : null}

          {message ? (
            <AdminCallout tone={message.type === "success" ? "success" : "danger"}>
              {message.type === "success" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4" />
              )}
              <p>{message.text}</p>
            </AdminCallout>
          ) : null}

          {result ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ResultStat label="Rows Read" value={formatNumber(result.totalRead)} />
              <ResultStat label="Added" tone="good" value={formatNumber(result.inserted)} />
              <ResultStat label="Updated" tone="good" value={formatNumber(result.updated)} />
              <ResultStat label="Unchanged" value={formatNumber(result.skipped)} />
              <ResultStat
                label="Blocked"
                tone={result.blockedRows.length > 0 ? "bad" : "good"}
                value={formatNumber(result.blockedRows.length)}
              />
            </div>
          ) : null}
        </div>
      </AdminTableShell>

      {result && result.blockedRows.length > 0 ? (
        <AdminTableShell description="Fix these rows in the workbook and re-import." title="Blocked Rows">
          <div className="overflow-x-auto p-4 md:p-5">
            <div className="overflow-hidden rounded-[16px] border border-phx-line">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr>
                    <th className={tableHeaderClassName}>Row</th>
                    <th className={tableHeaderClassName}>Key</th>
                    <th className={tableHeaderClassName}>Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-phx-line">
                  {result.blockedRows.slice(0, 200).map((blocked, index) => (
                    <tr className="text-phx-ink-soft" key={`${blocked.row}:${blocked.key}:${index}`}>
                      <td className="px-4 py-3 font-semibold text-phx-ink">{blocked.row}</td>
                      <td className="px-4 py-3">{blocked.key || "-"}</td>
                      <td className="px-4 py-3">{blocked.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </AdminTableShell>
      ) : null}

      <Card className="rounded-[32px] border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)] p-5">
        <div className="space-y-3">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Add Single Row</p>
          <div className="flex flex-wrap items-end gap-2">
            {def.columns.map((column) => (
              <Field key={column.key} label={column.label}>
                <ColumnField
                  allRows={allRows}
                  column={column}
                  def={def}
                  disabled={adding}
                  onChange={(value) => setAddFormValues((prev) => ({ ...prev, [column.key]: value }))}
                  value={addFormValues[column.key] || ""}
                />
              </Field>
            ))}
            <Button
              className="h-9 gap-1 rounded-xl bg-phx-accent font-black text-white transition hover:bg-[#EA6A0C]"
              disabled={adding}
              onClick={() => void handleAddRow()}
              type="button"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
            </Button>
          </div>
        </div>
      </Card>

      <AdminTableShell description={`Live rows currently stored in ${def.table}.`} title={`${def.label} Rows`}>
        <div className="overflow-x-auto p-4 md:p-5">
          <div className="overflow-hidden rounded-[16px] border border-phx-line">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr>
                  {def.columns.map((column) => (
                    <th className={tableHeaderClassName} key={column.key}>
                      {column.label}
                      {column.locked ? " 🔒" : ""}
                    </th>
                  ))}
                  {lookups.map((column) => (
                    <th className={tableHeaderClassName} key={column.key}>
                      {column.label}
                    </th>
                  ))}
                  <th className={tableHeaderClassName}>Active</th>
                  <th className={tableHeaderClassName}>Updated</th>
                  <th className={tableHeaderClassName}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-phx-line">
                {rows.map((row) => {
                  const rowKey = String(row[def.keyColumn]);
                  const isEditing = editingKey === rowKey;
                  const isActive = row.active !== false;
                  const isBusy = activeKeyBusy === rowKey;
                  const isConfirmingDelete = confirmDeleteKey === rowKey;
                  const isRelocatingEdit =
                    isEditing && def.master === "bricks" && (editValues.block_code ?? "") !== String(row.block_code ?? "");
                  return (
                    <tr className="text-phx-ink-soft" key={rowKey}>
                      {def.columns.map((column, columnIndex) => (
                        <td
                          className={cn("px-4 py-2.5 align-top", columnIndex === 0 ? "font-semibold text-phx-ink" : "")}
                          key={column.key}
                        >
                          {isEditing && !column.locked ? (
                            <ColumnField
                              allRows={allRows}
                              column={column}
                              def={def}
                              disabled={savingEdit}
                              onChange={(value) => setEditValues((prev) => ({ ...prev, [column.key]: value }))}
                              value={editValues[column.key] ?? ""}
                            />
                          ) : (
                            displayCell(column, row)
                          )}
                        </td>
                      ))}
                      {lookups.map((column) => (
                        <td className="px-4 py-2.5 align-top text-phx-ink-2" key={column.key}>
                          {resolveLookup(row, column)}
                        </td>
                      ))}
                      <td className="px-4 py-2.5">
                        <Badge variant={row.active === false ? "neutral" : "success"}>
                          {row.active === false ? "Inactive" : "Active"}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        {row.updated_at
                          ? new Date(String(row.updated_at)).toLocaleString("en-GB", {
                              timeZone: PHOENIX_BUSINESS_TIME_ZONE,
                            })
                          : "-"}
                      </td>
                      <td className="px-4 py-2.5">
                        {isEditing ? (
                          <div className="flex flex-col gap-1">
                            <div className="flex flex-wrap gap-1.5">
                              <Button disabled={savingEdit} onClick={() => void handleSaveEdit(rowKey)} size="sm">
                                {savingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} {isRelocatingEdit ? "Move" : "Save"}
                              </Button>
                              <Button disabled={savingEdit} onClick={cancelEdit} size="sm" variant="secondary">
                                Cancel
                              </Button>
                            </div>
                            {isRelocatingEdit ? (
                              <p className="max-w-[220px] text-phx-2xs font-semibold leading-tight text-phx-ink-faint">
                                Creates a new brick ID in the target block and deactivates this one.
                              </p>
                            ) : null}
                          </div>
                        ) : isConfirmingDelete ? (
                          <div className="flex flex-wrap gap-1.5">
                            <Button disabled={isBusy} onClick={() => void handleSetActive(rowKey, false)} size="sm" variant="destructive">
                              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Confirm
                            </Button>
                            <Button disabled={isBusy} onClick={() => setConfirmDeleteKey(null)} size="sm" variant="secondary">
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {editableLabels.length > 0 ? (
                              <Button onClick={() => startEdit(row)} size="icon-sm" title="Edit this row" variant="secondary">
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            ) : null}
                            {isActive ? (
                              <Button
                                onClick={() => setConfirmDeleteKey(rowKey)}
                                size="icon-sm"
                                title="Deactivate — hides this row everywhere immediately; reversible, keeps history."
                                variant="destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            ) : (
                              <Button
                                className="gap-1"
                                disabled={isBusy}
                                onClick={() => void handleSetActive(rowKey, true)}
                                size="sm"
                                title="Reactivate this row"
                                variant="secondary"
                              >
                                {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Reactivate
                              </Button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-sm font-semibold text-phx-ink-soft" colSpan={def.columns.length + lookups.length + 3}>
                      No rows yet. Export the template, fill it in, then import.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </AdminTableShell>
    </div>
  );
}

function ResultStat({ label, tone = "neutral", value }: { label: string; tone?: "neutral" | "good" | "bad"; value: string }) {
  const tones = {
    bad: "border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]",
    good: "border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]",
    neutral: "border-phx-line bg-[#FCFDFE] text-phx-ink",
  };
  return (
    <div className={cn("rounded-2xl border p-4", tones[tone])}>
      <p className="text-phx-2xs font-black uppercase tracking-[0.18em] opacity-70">{label}</p>
      <p className="mt-2 text-2xl font-black tracking-tight">{value}</p>
    </div>
  );
}

export function DatabaseMappingWorkspace({ initialError, initialHeaderGrid, initialRows }: Props) {
  const [rowsByMaster, setRowsByMaster] = useState(initialRows);
  const [activeTab, setActiveTab] = useState<MasterKey | "validation" | "profiles">(MASTER_ORDER[0]);
  const [downloadingMaster, setDownloadingMaster] = useState(false);
  const [masterError, setMasterError] = useState<string | null>(null);

  // Build + download the full 17-sheet master workbook, populated live from the current system data.
  async function handleDownloadMaster() {
    setDownloadingMaster(true);
    setMasterError(null);
    try {
      const response = await fetch("/api/sales/master-workbook/export", { cache: "no-store" });
      if (!response.ok) {
        const payload = await readJson<{ error?: string; success: boolean }>(response);
        setMasterError(payload.error ?? "Download failed.");
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `phoenix-master-workbook-${new Date().toISOString().slice(0, 10)}.xlsx`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (caught) {
      setMasterError(caught instanceof Error ? caught.message : "Download failed.");
    } finally {
      setDownloadingMaster(false);
    }
  }

  if (initialError) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-phx-paper p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  const activeDef = activeTab === "validation" || activeTab === "profiles" ? null : MASTER_DEFINITIONS[activeTab];

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <div className="relative overflow-hidden rounded-3xl border border-phx-line bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
          <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
                <Database className="h-3.5 w-3.5 text-orange-600" />
                <span className="text-phx-xs font-black uppercase tracking-[0.18em] text-orange-600">Source of Sales</span>
              </div>
              <h1 className="text-3xl font-black tracking-tight text-slate-950">Database Mapping</h1>
              <p className="mt-1 max-w-3xl text-sm text-slate-500">
                Export, edit and import the master tables that drive all Source of Sales mapping. Key and name columns are
                locked. Bulk import adds and updates rows but never deletes; use the row actions to edit a single row or
                deactivate it (a reversible soft delete — hides it everywhere immediately, keeps history).
              </p>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Button
                className="gap-2 bg-[#0B0B0B] text-white hover:bg-phx-accent"
                disabled={downloadingMaster}
                onClick={() => void handleDownloadMaster()}
                title="Download the full master workbook, populated live from the current system data."
              >
                {downloadingMaster ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Download Master Workbook
              </Button>
              <Link href="/sales/import">
                <Button className="gap-2" variant="secondary">
                  <Database className="h-4 w-4" />
                  Source of Sales
                </Button>
              </Link>
            </div>
          </div>
        </div>

        {masterError ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="h-4 w-4" />
            <p>{masterError}</p>
          </AdminCallout>
        ) : null}

        <div className="flex flex-wrap gap-2 rounded-2xl border border-phx-line bg-white/90 p-2 shadow-[0_14px_32px_rgba(15,23,42,0.06)]">
          {MASTER_ORDER.map((master) => {
            const Icon = MASTER_ICONS[master];
            return (
              <Button
                className={cn(
                  "gap-2 rounded-xl font-black",
                  activeTab === master ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "",
                )}
                key={master}
                onClick={() => setActiveTab(master)}
                variant="secondary"
              >
                <Icon className="h-4 w-4" />
                {MASTER_DEFINITIONS[master].label}
              </Button>
            );
          })}
          <Button
            className={cn("gap-2 rounded-xl font-black", activeTab === "validation" ? "bg-[#0B0B0B] text-white hover:bg-phx-accent" : "")}
            onClick={() => setActiveTab("validation")}
            variant="secondary"
          >
            <ShieldCheck className="h-4 w-4" />
            Distributor Mapping
          </Button>
        </div>

        {activeDef === null ? (
          <DatabaseValidationTab headerGrid={initialHeaderGrid} />
        ) : (
          <MasterTab
            allRows={rowsByMaster}
            def={activeDef}
            onRowsChange={(rows) => setRowsByMaster((current) => ({ ...current, [activeTab as MasterKey]: rows }))}
            rows={rowsByMaster[activeTab as MasterKey]}
          />
        )}
      </div>
    </div>
  );
}
