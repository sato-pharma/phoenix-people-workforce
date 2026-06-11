"use client";

import { AlertTriangle, Check, Loader2, Pencil, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { WeeklyProductScopeAdmin, WeeklyScopeAssignment } from "@/lib/sales/weekly/types";

export function WeeklyScopeManager({
  initial,
  initialError,
}: {
  initial: WeeklyProductScopeAdmin | null;
  initialError: string | null;
}) {
  const [data, setData] = useState<WeeklyProductScopeAdmin | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [editing, setEditing] = useState<{ hrId: string; name: string; role: string; codes: Set<string> } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(hrId: string, productCodes: string[]) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/sales/weekly/product-scope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hrId, productCodes }),
      });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklyProductScopeAdmin; error?: string };
      if (payload?.success && payload.data) {
        setData(payload.data);
        setEditing(null);
      } else {
        setError(payload?.error ?? "Failed to save.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save.");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <span>{error ?? "Failed to load product access."}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-black text-[#0F172A]">Weekly Sales — Product Access</h1>
        <p className="mt-1 text-sm font-medium text-[#64748B]">
          Choose which products each Product / Group Product / Marketing Manager can see in the weekly
          dashboard. They see only their assigned products; sales-field roles stay scoped by region/line.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Add a person who has no scope yet */}
      <div className="flex flex-wrap items-center gap-2 border border-[#E2E8F0] bg-white p-3">
        <span className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Add product owner</span>
        <select
          className="h-9 min-w-[16rem] border border-[#E2E8F0] bg-white px-2 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
          disabled={busy}
          value=""
          onChange={(event) => {
            const person = data.eligibleWithoutScope.find((p) => p.hrId === event.target.value);
            if (person) setEditing({ hrId: person.hrId, name: person.name, role: person.role, codes: new Set() });
          }}
        >
          <option value="">{data.eligibleWithoutScope.length ? "Select a person…" : "No unassigned PM/GPM/Marketing"}</option>
          {data.eligibleWithoutScope.map((person) => (
            <option key={person.hrId} value={person.hrId}>
              {person.name} · {person.role} ({person.hrId})
            </option>
          ))}
        </select>
      </div>

      {/* Current assignments */}
      <div className="overflow-x-auto border border-[#E2E8F0] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[#F8FAFC] text-left text-[11px] font-black uppercase tracking-wide text-[#64748B]">
            <tr>
              <th className="px-3 py-2">Person</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Products</th>
              <th className="px-3 py-2 text-right" />
            </tr>
          </thead>
          <tbody>
            {data.assignments.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-center text-[#94A3B8]" colSpan={4}>
                  No product owners assigned yet.
                </td>
              </tr>
            )}
            {data.assignments.map((assignment) => (
              <AssignmentRow
                key={assignment.hrId}
                assignment={assignment}
                products={data.products}
                onEdit={() =>
                  setEditing({
                    hrId: assignment.hrId,
                    name: assignment.name,
                    role: assignment.role,
                    codes: new Set(assignment.productCodes),
                  })
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditDrawer
          person={editing}
          products={data.products}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(codes) => save(editing.hrId, codes)}
        />
      )}
    </div>
  );
}

function AssignmentRow({
  assignment,
  products,
  onEdit,
}: {
  assignment: WeeklyScopeAssignment;
  products: WeeklyProductScopeAdmin["products"];
  onEdit: () => void;
}) {
  const nameByCode = useMemo(() => new Map(products.map((p) => [p.code, p.name])), [products]);
  return (
    <tr className="border-t border-[#F1F5F9] align-top">
      <td className="px-3 py-2">
        <div className="font-bold text-[#0F172A]">{assignment.name}</div>
        <div className="text-[11px] font-medium text-[#94A3B8]">{assignment.hrId}</div>
      </td>
      <td className="px-3 py-2 text-[#334155]">{assignment.role}</td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {assignment.productCodes.length === 0 && <span className="text-[#94A3B8]">— none —</span>}
          {assignment.productCodes.map((code) => (
            <span key={code} className="inline-flex items-center bg-[#F1F5F9] px-2 py-0.5 text-[11px] font-bold text-[#334155]">
              {nameByCode.get(code) ?? code}
            </span>
          ))}
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <button
          className="inline-flex items-center gap-1 border border-[#E2E8F0] px-2 py-1 text-xs font-bold text-[#334155] transition hover:border-[#FDBA74]"
          onClick={onEdit}
          type="button"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
      </td>
    </tr>
  );
}

function EditDrawer({
  person,
  products,
  busy,
  onClose,
  onSave,
}: {
  person: { hrId: string; name: string; role: string; codes: Set<string> };
  products: WeeklyProductScopeAdmin["products"];
  busy: boolean;
  onClose: () => void;
  onSave: (codes: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(person.codes));
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q));
  }, [products, query]);

  const toggle = (code: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onMouseDown={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col bg-white shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#E2E8F0] px-4 py-3">
          <div>
            <div className="text-sm font-black text-[#0F172A]">{person.name}</div>
            <div className="text-[11px] font-medium text-[#94A3B8]">{person.role} · {person.hrId}</div>
          </div>
          <button className="text-[#94A3B8] transition hover:text-[#0F172A]" onClick={onClose} type="button">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-[#E2E8F0] p-3">
          <div className="flex items-center gap-2 border border-[#E2E8F0] px-2">
            <Search className="h-4 w-4 text-[#94A3B8]" />
            <input
              className="h-9 w-full text-sm text-[#0F172A] outline-none"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search products…"
              value={query}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] font-bold text-[#64748B]">
            <span>{selected.size} selected</span>
            <div className="flex gap-2">
              <button className="underline" onClick={() => setSelected(new Set(products.map((p) => p.code)))} type="button">
                Select all
              </button>
              <button className="underline" onClick={() => setSelected(new Set())} type="button">
                Clear
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-2">
          {filtered.map((product) => {
            const checked = selected.has(product.code);
            return (
              <button
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm ${checked ? "bg-[#FFF7ED]" : "hover:bg-[#F8FAFC]"}`}
                key={product.code}
                onClick={() => toggle(product.code)}
                type="button"
              >
                <span className={`flex h-4 w-4 items-center justify-center border ${checked ? "border-[#F97316] bg-[#F97316] text-white" : "border-[#CBD5E1]"}`}>
                  {checked && <Check className="h-3 w-3" />}
                </span>
                <span className="font-semibold text-[#0F172A]">{product.name}</span>
                <span className="ml-auto text-[11px] font-medium text-[#94A3B8]">{product.code}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 border-t border-[#E2E8F0] p-3">
          <button
            className="inline-flex h-10 items-center gap-2 bg-[#F97316] px-4 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:opacity-60"
            disabled={busy}
            onClick={() => onSave([...selected])}
            type="button"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Save access
          </button>
          <button className="h-10 px-3 text-sm font-bold text-[#64748B]" onClick={onClose} type="button">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
