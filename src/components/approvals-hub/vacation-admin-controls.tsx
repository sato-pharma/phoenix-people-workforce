"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { LandingPanel } from "@/components/employee-portal/landing-kit";
import { FormActions, FormError, FormField } from "@/components/ui/form-kit";
import {
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
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

/** The buttons: full width, one under another, on a phone; on the right from `sm`. */
const ACTION_ROW = "flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end [&>button]:justify-center";

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
    <LandingPanel title="Admin controls" bodyClassName="space-y-3 px-3 py-3 sm:px-4">
      {mode === "idle" ? (
        <div className={ACTION_ROW}>
          <button className={phxButtonGhostClassName} onClick={startEdit} type="button">
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" /> Edit request
          </button>
          <button
            className={phxButtonDangerClassName}
            onClick={() => {
              setError(null);
              setMode("confirm-delete");
            }}
            type="button"
          >
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" /> Delete request
          </button>
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
              <button className={phxButtonGhostClassName} disabled={busy} onClick={() => setMode("idle")} type="button">
                Cancel
              </button>
            }
            right={
              <button className={phxButtonPrimaryClassName} disabled={busy} onClick={() => void save()} type="button">
                {busy ? "Saving..." : "Save changes"}
              </button>
            }
          />
        </div>
      ) : null}

      {mode === "confirm-delete" ? (
        // The confirmation is a rose rail and its words, never a filled box: the colour says it, the
        // two buttons under it decide it.
        <div className="space-y-3 border-l-4 border-rose-500 py-1 pl-3">
          <p className="break-words text-phx-sm font-bold text-rose-800">
            Delete {row.requestCode} for {row.employeeName}? This removes the request. The admin audit log keeps the deleted record context.
          </p>
          <div className={ACTION_ROW}>
            <button className={phxButtonDangerClassName} disabled={busy} onClick={() => void remove()} type="button">
              {busy ? "Deleting..." : "Yes, delete this request"}
            </button>
            <button className={phxButtonGhostClassName} disabled={busy} onClick={() => setMode("idle")} type="button">
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <FormError>{error}</FormError>
    </LandingPanel>
  );
}
