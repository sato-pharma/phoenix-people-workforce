"use client";

import { AlertCircle, Check, ChevronDown, Loader2, Pencil, RefreshCw, Search, X } from "lucide-react";
import * as React from "react";

import { AdminSectionHeader } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ProductOption, UserScopeOverride } from "@/lib/auth/scope-visibility";
import {
  PortalStackingCell,
  portalStackingBodyClassName,
  portalStackingHeadClassName,
  portalStackingRowClassName,
  portalStackingTableClassName,
} from "@/components/employee-portal/portal-primitives";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

const PRODUCT_LINES = ["Pedia", "CNS", "Anti Infective"] as const;

const SALES_SCOPE_OPTIONS = [
  { label: "— (role default)", value: "" },
  { label: "COMPANY", value: "COMPANY" },
  { label: "LINE", value: "LINE" },
  { label: "HIERARCHY", value: "HIERARCHY" },
  { label: "TEAM", value: "TEAM" },
  { label: "SELF", value: "SELF" },
  { label: "NONE", value: "NONE" },
] as const;

type Props = {
  initialData: UserScopeOverride[] | null;
  initialError: string | null;
  initialProducts: ProductOption[];
};

type EditState = {
  lineNames: string[];
  productCodes: string[];
  salesScopeOverride: string;
};

function ProductMultiSelect({
  products,
  selected,
  onChange,
}: {
  products: ProductOption[];
  selected: string[];
  onChange: (codes: string[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  const visibleProducts = search
    ? products.filter(
        (p) =>
          p.code.toLowerCase().includes(search.toLowerCase()) ||
          p.name.toLowerCase().includes(search.toLowerCase()),
      )
    : products;

  const byLine = PRODUCT_LINES.map((line) => ({
    line,
    // Case-insensitive so the display label ("Anti Infective") groups product rows regardless of
    // the stored line casing (legacy "Anti infective"/"Anti Inf") — decouples label from data.
    items: visibleProducts.filter((p) => (p.line ?? "").toLowerCase() === line.toLowerCase()),
  })).filter((g) => g.items.length > 0);

  function toggle(code: string) {
    onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code]);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v: boolean) => !v)}
        className="flex min-w-[180px] items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:border-slate-300 focus:border-orange-300 focus:outline-none"
      >
        <span>
          {selected.length === 0
            ? "Select product codes…"
            : `${selected.length} code${selected.length > 1 ? "s" : ""} selected`}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-slate-400" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <Input
              autoFocus
              className="h-7 text-xs"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
              placeholder="Search code or name…"
              value={search}
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {byLine.map(({ line, items }) => (
              <div key={line}>
                <p className="sticky top-0 bg-slate-50 px-3 py-1 text-phx-sm font-bold uppercase tracking-wider text-slate-400">
                  {line}
                </p>
                {items.map((p) => (
                  <label
                    key={p.code}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-orange-50"
                  >
                    <input
                      checked={selected.includes(p.code)}
                      className="h-3 w-3 accent-orange-500"
                      onChange={() => toggle(p.code)}
                      type="checkbox"
                    />
                    <span className="w-14 shrink-0 font-mono text-phx-xs text-slate-500">{p.code}</span>
                    <span className="text-slate-700">{p.name}</span>
                  </label>
                ))}
              </div>
            ))}
            {byLine.length === 0 && (
              <p className="p-3 text-center text-xs text-slate-400">No products match.</p>
            )}
          </div>
          {selected.length > 0 && (
            <div className="border-t border-slate-100 px-3 py-1.5">
              <button
                className="text-phx-xs text-red-500 hover:underline"
                onClick={() => onChange([])}
                type="button"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ScopeVisibilityManager({ initialData, initialError, initialProducts }: Props) {
  const [rows, setRows] = React.useState<UserScopeOverride[]>(initialData ?? []);
  const [search, setSearch] = React.useState("");
  const [filterLine, setFilterLine] = React.useState("");
  const [filterRole, setFilterRole] = React.useState("");
  const [editingLoginId, setEditingLoginId] = React.useState<string | null>(null);
  const [editState, setEditState] = React.useState<EditState | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(initialError);

  const uniqueRoles = React.useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.role) seen.add(row.role);
    }
    return Array.from(seen).sort();
  }, [rows]);

  const filtered = rows.filter((row: UserScopeOverride) => {
    const q = search.toLowerCase();
    if (
      q &&
      !row.loginId.toLowerCase().includes(q) &&
      !(row.fullName ?? "").toLowerCase().includes(q) &&
      !(row.hrId ?? "").toLowerCase().includes(q) &&
      !(row.role ?? "").toLowerCase().includes(q)
    ) {
      return false;
    }
    if (
      filterLine &&
      !(row.lineNames ?? []).some((l) => l.toLowerCase() === filterLine.toLowerCase())
    )
      return false;
    if (filterRole && row.role !== filterRole) return false;
    return true;
  });

  function startEdit(row: UserScopeOverride) {
    setEditingLoginId(row.loginId);
    setEditState({
      lineNames: row.lineNames ?? [],
      productCodes: row.productCodes ?? [],
      salesScopeOverride: row.salesScopeOverride ?? "",
    });
    setSaveError(null);
    setSaveSuccess(false);
  }

  function cancelEdit() {
    setEditingLoginId(null);
    setEditState(null);
    setSaveError(null);
    setSaveSuccess(false);
  }

  function toggleLine(line: string) {
    if (!editState) return;
    const existing = editState.lineNames.includes(line);
    setEditState({
      ...editState,
      lineNames: existing
        ? editState.lineNames.filter((l: string) => l !== line)
        : [...editState.lineNames, line],
    });
  }

  async function saveEdit() {
    if (!editState || !editingLoginId) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const body = {
        loginId: editingLoginId,
        lineNames: editState.lineNames.length > 0 ? editState.lineNames : null,
        productCodes: editState.productCodes.length > 0 ? editState.productCodes : null,
        salesScopeOverride: editState.salesScopeOverride || null,
      };

      const res = await fetch("/api/admin/scope-visibility", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { message?: string }).message ?? `HTTP ${res.status}`);
      }

      setRows((prev: UserScopeOverride[]) =>
        prev.map((row: UserScopeOverride) =>
          row.loginId === editingLoginId
            ? {
                ...row,
                lineNames: body.lineNames,
                productCodes: body.productCodes,
                salesScopeOverride: body.salesScopeOverride,
              }
            : row,
        ),
      );
      setSaveSuccess(true);
      setTimeout(() => {
        setEditingLoginId(null);
        setEditState(null);
        setSaveSuccess(false);
      }, 800);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/scope-visibility");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { overrides: UserScopeOverride[] };
      setRows(json.overrides ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <AdminSectionHeader
        description="Control which product lines and product codes each user can see in probation, organogram, vacancies, sales, and marketing requests. Changes persist to the database immediately."
        title="Scope & Visibility Overrides"
      />

      {error ? (
        <Card className="border-red-200 bg-red-50 p-4">
          <div className="flex items-center gap-2 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        </Card>
      ) : null}

      <Card className="p-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              aria-label="Search by name, login ID, or HR ID"
              className="pl-9"
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, login ID, HR ID…"
              value={search}
            />
          </div>
          <select
            aria-label="Filter by line"
            className={phxSelectClassName}
            onChange={(e) => setFilterLine(e.target.value)}
            value={filterLine}
          >
            <option value="">All lines</option>
            {PRODUCT_LINES.map((line) => (
              <option key={line} value={line}>
                {line}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by role"
            className={phxSelectClassName}
            onChange={(e) => setFilterRole(e.target.value)}
            value={filterRole}
          >
            <option value="">All roles</option>
            {uniqueRoles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <Button aria-label="Refresh" disabled={loading} onClick={refresh} size="sm" variant="outline">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div>
          <table className={cn(portalStackingTableClassName, "text-sm md:w-full md:table-fixed md:border-collapse")}>
            <colgroup>
              <col className="md:w-[20%]" />
              <col className="md:w-[12%]" />
              <col className="md:w-[18%]" />
              <col className="md:w-[24%]" />
              <col className="md:w-[16%]" />
              <col className="md:w-[10%]" />
            </colgroup>
            <thead className={portalStackingHeadClassName}>
              <tr className="border-b border-slate-100 text-left text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                <th className="pb-2 pr-4">User</th>
                <th className="pb-2 pr-4">Role</th>
                <th className="pb-2 pr-4">Line Override</th>
                <th className="pb-2 pr-4">Product Codes</th>
                <th className="pb-2 pr-4">Sales Scope</th>
                <th className="pb-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className={cn(portalStackingBodyClassName, "divide-y divide-slate-50")}>
              {filtered.map((row) => {
                const isEditing = editingLoginId === row.loginId;
                return (
                  <tr key={row.loginId} className={cn(portalStackingRowClassName, "align-top")}>
                    <PortalStackingCell className="py-3 pr-4" label="User">
                      <p className="font-medium text-slate-900">{row.displayName ?? row.fullName ?? row.loginId}</p>
                      <p className="text-phx-xs text-slate-400">
                        {row.loginId}
                      </p>
                    </PortalStackingCell>
                    <PortalStackingCell className="py-3 pr-4" label="Role">
                      <span className="text-slate-600">{row.role ?? "—"}</span>
                    </PortalStackingCell>

                    {isEditing && editState ? (
                      <>
                        <PortalStackingCell className="py-3 pr-4" label="Line override">
                          <div className="flex flex-wrap gap-1.5">
                            {PRODUCT_LINES.map((line) => (
                              <button
                                key={line}
                                className={`rounded border px-2 py-0.5 text-phx-xs font-semibold transition ${
                                  editState.lineNames.includes(line)
                                    ? "border-orange-300 bg-orange-100 text-orange-700"
                                    : "border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300"
                                }`}
                                onClick={() => toggleLine(line)}
                                type="button"
                              >
                                {line}
                              </button>
                            ))}
                          </div>
                          <p className="mt-1 text-phx-sm text-slate-400">
                            Click to toggle. Empty = role default.
                          </p>
                        </PortalStackingCell>
                        <PortalStackingCell className="py-3 pr-4" label="Product codes">
                          <ProductMultiSelect
                            onChange={(codes) => setEditState({ ...editState, productCodes: codes })}
                            products={initialProducts}
                            selected={editState.productCodes}
                          />
                          <p className="mt-1 text-phx-sm text-slate-400">Empty = no restriction.</p>
                        </PortalStackingCell>
                        <PortalStackingCell className="py-3 pr-4" label="Sales scope">
                          <select
                            aria-label={`Sales scope override for ${row.displayName ?? row.fullName ?? row.loginId}`}
                            className={phxSelectClassName}
                            onChange={(e) =>
                              setEditState({ ...editState, salesScopeOverride: e.target.value })
                            }
                            value={editState.salesScopeOverride}
                          >
                            {SALES_SCOPE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </PortalStackingCell>
                        <PortalStackingCell className="py-3" label="Actions">
                          <div className="flex items-center gap-1">
                            <Button
                              aria-label={`Save scope changes for ${row.displayName ?? row.fullName ?? row.loginId}`}
                              className="h-7 px-2"
                              disabled={saving}
                              onClick={saveEdit}
                              size="sm"
                            >
                              {saving ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : saveSuccess ? (
                                <Check className="h-3.5 w-3.5 text-emerald-500" />
                              ) : (
                                <Check className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              aria-label={`Cancel editing scope for ${row.displayName ?? row.fullName ?? row.loginId}`}
                              className="h-7 px-2"
                              disabled={saving}
                              onClick={cancelEdit}
                              size="sm"
                              variant="ghost"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          {saveError ? (
                            <p className="mt-1 text-phx-sm text-red-600">{saveError}</p>
                          ) : null}
                        </PortalStackingCell>
                      </>
                    ) : (
                      <>
                        <PortalStackingCell className="py-3 pr-4" label="Line override">
                          {row.lineNames && row.lineNames.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {row.lineNames.map((line) => (
                                <Badge key={line} className="text-phx-sm" variant="neutral">
                                  {line}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-phx-xs text-slate-400">role default</span>
                          )}
                        </PortalStackingCell>
                        <PortalStackingCell className="py-3 pr-4" label="Product codes">
                          {row.productCodes !== null && row.productCodes !== undefined ? (
                            row.productCodes.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {row.productCodes.map((code) => (
                                  <Badge key={code} className="font-mono text-phx-sm" variant="neutral">
                                    {code}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <span className="text-phx-xs text-red-500">sees nothing</span>
                            )
                          ) : (
                            <span className="text-phx-xs text-slate-400">no restriction</span>
                          )}
                        </PortalStackingCell>
                        <PortalStackingCell className="py-3 pr-4" label="Sales scope">
                          {row.salesScopeOverride ? (
                            <Badge className="text-phx-sm" variant="warning">
                              {row.salesScopeOverride}
                            </Badge>
                          ) : (
                            <span className="text-phx-xs text-slate-400">role default</span>
                          )}
                        </PortalStackingCell>
                        <PortalStackingCell className="py-3" label="Actions">
                          <Button
                            aria-label={`Edit scope for ${row.displayName ?? row.fullName ?? row.loginId}`}
                            className="h-7 px-2"
                            onClick={() => startEdit(row)}
                            size="sm"
                            variant="ghost"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </PortalStackingCell>
                      </>
                    )}
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr className={portalStackingRowClassName}>
                  <PortalStackingCell className="py-8 text-center text-sm text-slate-400" colSpan={6} label="">
                    {search || filterLine || filterRole
                      ? "No users match your filters."
                      : "No active users found."}
                  </PortalStackingCell>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
