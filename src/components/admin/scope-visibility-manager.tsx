"use client";

import { AlertCircle, Check, Loader2, Pencil, RefreshCw, Search, X } from "lucide-react";
import * as React from "react";

import { AdminSectionHeader } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { UserScopeOverride } from "@/lib/auth/scope-visibility";

const PRODUCT_LINES = ["Pedia", "CNS", "Anti infective"] as const;

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
};

type EditState = {
  lineNames: string[];
  productCodesRaw: string;
  salesScopeOverride: string;
};

export function ScopeVisibilityManager({ initialData, initialError }: Props) {
  const [rows, setRows] = React.useState<UserScopeOverride[]>(initialData ?? []);
  const [search, setSearch] = React.useState("");
  const [editingLoginId, setEditingLoginId] = React.useState<string | null>(null);
  const [editState, setEditState] = React.useState<EditState | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(initialError);

  const filtered = rows.filter((row: UserScopeOverride) => {
    const q = search.toLowerCase();
    return (
      !q ||
      row.loginId.toLowerCase().includes(q) ||
      (row.fullName ?? "").toLowerCase().includes(q) ||
      (row.hrId ?? "").toLowerCase().includes(q) ||
      (row.role ?? "").toLowerCase().includes(q)
    );
  });

  function startEdit(row: UserScopeOverride) {
    setEditingLoginId(row.loginId);
    setEditState({
      lineNames: row.lineNames ?? [],
      productCodesRaw: (row.productCodes ?? []).join(", "),
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
      const productCodes = editState.productCodesRaw
        .split(/[,\s]+/)
        .map((c: string) => c.trim().toUpperCase())
        .filter(Boolean);

      const body = {
        loginId: editingLoginId,
        lineNames: editState.lineNames.length > 0 ? editState.lineNames : null,
        productCodes: productCodes.length > 0 ? productCodes : null,
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
      const json = await res.json() as { overrides: UserScopeOverride[] };
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
        <div className="mb-4 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              className="pl-9"
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, login ID, HR ID, or role…"
              value={search}
            />
          </div>
          <Button
            disabled={loading}
            onClick={refresh}
            size="sm"
            variant="outline"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <th className="pb-2 pr-4">User</th>
                <th className="pb-2 pr-4">Role</th>
                <th className="pb-2 pr-4">Line Override</th>
                <th className="pb-2 pr-4">Product Codes</th>
                <th className="pb-2 pr-4">Sales Scope</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.map((row) => {
                const isEditing = editingLoginId === row.loginId;
                return (
                  <tr key={row.loginId} className="align-top">
                    <td className="py-3 pr-4">
                      <p className="font-medium text-slate-900">{row.fullName ?? row.loginId}</p>
                      <p className="text-[11px] text-slate-400">{row.loginId}{row.hrId ? ` · ${row.hrId}` : ""}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <span className="text-slate-600">{row.role ?? "—"}</span>
                    </td>

                    {isEditing && editState ? (
                      <>
                        <td className="py-3 pr-4">
                          <div className="flex flex-wrap gap-1.5">
                            {PRODUCT_LINES.map((line) => (
                              <button
                                key={line}
                                onClick={() => toggleLine(line)}
                                type="button"
                                className={`rounded border px-2 py-0.5 text-[11px] font-semibold transition ${
                                  editState.lineNames.includes(line)
                                    ? "border-orange-300 bg-orange-100 text-orange-700"
                                    : "border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300"
                                }`}
                              >
                                {line}
                              </button>
                            ))}
                          </div>
                          <p className="mt-1 text-[10px] text-slate-400">Click to toggle. Empty = role default.</p>
                        </td>
                        <td className="py-3 pr-4">
                          <Input
                            className="h-7 text-xs"
                            onChange={(e) => setEditState({ ...editState, productCodesRaw: e.target.value })}
                            placeholder="CNS001, PEDIA002, …"
                            value={editState.productCodesRaw}
                          />
                          <p className="mt-1 text-[10px] text-slate-400">Comma/space separated. Empty = no restriction.</p>
                        </td>
                        <td className="py-3 pr-4">
                          <select
                            className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none focus:border-orange-300"
                            onChange={(e) => setEditState({ ...editState, salesScopeOverride: e.target.value })}
                            value={editState.salesScopeOverride}
                          >
                            {SALES_SCOPE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-1">
                            <Button
                              disabled={saving}
                              onClick={saveEdit}
                              size="sm"
                              className="h-7 px-2"
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
                              disabled={saving}
                              onClick={cancelEdit}
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          {saveError ? (
                            <p className="mt-1 text-[10px] text-red-600">{saveError}</p>
                          ) : null}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-3 pr-4">
                          {row.lineNames && row.lineNames.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {row.lineNames.map((line) => (
                                <Badge key={line} variant="neutral" className="text-[10px]">
                                  {line}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-slate-400 text-[11px]">role default</span>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {row.productCodes !== null && row.productCodes !== undefined ? (
                            row.productCodes.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {row.productCodes.map((code) => (
                                  <Badge key={code} variant="neutral" className="text-[10px] font-mono">
                                    {code}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <span className="text-red-500 text-[11px]">sees nothing</span>
                            )
                          ) : (
                            <span className="text-slate-400 text-[11px]">no restriction</span>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {row.salesScopeOverride ? (
                            <Badge variant="warning" className="text-[10px]">
                              {row.salesScopeOverride}
                            </Badge>
                          ) : (
                            <span className="text-slate-400 text-[11px]">role default</span>
                          )}
                        </td>
                        <td className="py-3">
                          <Button
                            onClick={() => startEdit(row)}
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-sm text-slate-400">
                    {search ? "No users match your search." : "No active users found."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
