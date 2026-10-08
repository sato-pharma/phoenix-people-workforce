"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { FormActions, FormError, FormField } from "@/components/ui/form-kit";
import { phxButtonDangerDenseClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import type { VacationRequestRecord } from "@/lib/vacation/types";
import { VACATION_DAY_PARTS, VACATION_STATUSES, VACATION_TYPES } from "@/lib/vacation/types";

/*
 * Editing and deleting a leave request lives HERE, on the request's own page in the Leave Approvals
 * hub — owner, 2026-10-08: "any type of leave should be in the leave approvals", and the Vacation
 * requests report is read-only for both. It is shown only to HR and Super Admin; the PATCH and DELETE
 * routes enforce the same gate, so this prop only keeps a button off a screen where pressing it
 * would be refused.
 *
 * The employee is fixed (the request belongs to them): the form sends it back unchanged, which is
 * what the PATCH route expects.
 */

type FormState = {
  dayPart: string;
  employeeHrId: string;
  endDate: string;
  notes: string;
  startDate: string;
  status: string;
  vacationType: string;
};

function formFromRow(row: VacationRequestRecord): FormState {
  return {
    dayPart: row.dayPart,
    employeeHrId: row.employeeHrId,
    endDate: row.endDate,
    notes: row.notes ?? "",
    startDate: row.startDate,
    status: row.status,
    vacationType: row.vacationType,
  };
}

export function VacationAdminControls({ backHref, row }: { backHref: string; row: VacationRequestRecord }) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "edit" | "confirm-delete">("idle");
  const [form, setForm] = useState<FormState>(() => formFromRow(row));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(key: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startEdit() {
    setError(null);
    setForm(formFromRow(row));
    setMode("edit");
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/vacations/requests/${encodeURIComponent(row.id)}`, {
        body: JSON.stringify(form),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "The request could not be saved.");
      }
      setMode("idle");
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The request could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/vacations/requests/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "The request could not be deleted.");
      }
      router.push(backHref);
      router.refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "The request could not be deleted.");
      setBusy(false);
    }
  }

  // Every type stays selectable: a sick or compensatory request is edited here, which the add form hides.
  const typeOptions = VACATION_TYPES;

  return (
    <section className="border border-phx-line bg-white">
      <header className="border-b border-phx-line bg-slate-900 px-4 py-2.5">
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Admin controls</h3>
      </header>
      <div className="space-y-3 px-4 py-3">
        <p className="text-phx-xs font-semibold text-slate-600">
          Change or remove this request. Every change is written to the request&apos;s timeline and the admin audit log.
        </p>

        {mode === "idle" ? (
          <div className="flex flex-wrap gap-2">
            <Button
              className="gap-1.5 rounded-sm border border-slate-300 bg-white text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
              onClick={startEdit}
              type="button"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit request
            </Button>
            <Button
              className={cn(phxButtonDangerDenseClassName, "gap-1.5 text-phx-sm font-bold")}
              onClick={() => {
                setError(null);
                setMode("confirm-delete");
              }}
              type="button"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete request
            </Button>
          </div>
        ) : null}

        {mode === "edit" ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Type">
                <SearchableSelect className={phxSelectClassName} value={form.vacationType} onChange={(event) => update("vacationType", event.target.value)}>
                  {typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SearchableSelect>
              </FormField>
              <FormField label="Status">
                <SearchableSelect className={phxSelectClassName} value={form.status} onChange={(event) => update("status", event.target.value)}>
                  {VACATION_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SearchableSelect>
              </FormField>
              <FormField label="Day part">
                <SearchableSelect className={phxSelectClassName} value={form.dayPart} onChange={(event) => update("dayPart", event.target.value)}>
                  {VACATION_DAY_PARTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SearchableSelect>
              </FormField>
              <div className="hidden sm:block" />
              <FormField label="From">
                <Input type="date" value={form.startDate} onChange={(event) => update("startDate", event.target.value)} />
              </FormField>
              <FormField label="To">
                <Input type="date" value={form.endDate} onChange={(event) => update("endDate", event.target.value)} />
              </FormField>
              <FormField className="sm:col-span-2" label="Admin note">
                <Input value={form.notes} onChange={(event) => update("notes", event.target.value)} />
              </FormField>
            </div>
            <FormActions
              left={
                <Button
                  className="rounded-sm border border-slate-300 bg-white text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
                  disabled={busy}
                  onClick={() => setMode("idle")}
                  type="button"
                >
                  Cancel
                </Button>
              }
              right={
                <Button
                  className="rounded-sm bg-orange-500 text-phx-sm font-bold text-white hover:bg-orange-600"
                  disabled={busy}
                  onClick={() => void save()}
                  type="button"
                >
                  {busy ? "Saving..." : "Save changes"}
                </Button>
              }
            />
          </div>
        ) : null}

        {mode === "confirm-delete" ? (
          <div className="space-y-3 border border-rose-200 bg-rose-50 px-3 py-3">
            <p className="text-phx-sm font-bold text-rose-900">
              Delete {row.requestCode} for {row.employeeName}? This removes the request. The admin audit log keeps the deleted record context.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                className={cn(phxButtonDangerDenseClassName, "text-phx-sm font-bold")}
                disabled={busy}
                onClick={() => void remove()}
                type="button"
              >
                {busy ? "Deleting..." : "Yes, delete this request"}
              </Button>
              <Button
                className="rounded-sm border border-slate-300 bg-white text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
                disabled={busy}
                onClick={() => setMode("idle")}
                type="button"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        <FormError>{error}</FormError>
      </div>
    </section>
  );
}
