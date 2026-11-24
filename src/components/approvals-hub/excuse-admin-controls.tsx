"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { adminPanelClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { Button } from "@/components/ui/button";
import { FormActions, FormError, FormField } from "@/components/ui/form-kit";
import { phxButtonDangerDenseClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import { EXCUSE_ADMIN_STATUS_OPTIONS, EXCUSE_ADMIN_TYPE_OPTIONS } from "@/lib/excuses/admin-edit";
import type { EmployeeExcuseRequest } from "@/lib/excuses/service";

/*
 * The Super Admin's tools on one excuse request — edit it or delete it — on the request's own page
 * in Excuse Approvals (owner, 2026-11-24: "in excuse approvals add admin tools"). The same panel,
 * words and look as Leave Approvals' `vacation-admin-controls.tsx`. The server decides who sees it
 * (`canAdminManage`) and the PATCH and DELETE ask the same gate again. Nobody is told.
 */

type FormState = {
  excuseDate: string;
  excuseType: string;
  reply: string;
  status: string;
};

function formFromRow(row: EmployeeExcuseRequest): FormState {
  return {
    excuseDate: row.excuseDate,
    excuseType: row.excuseType,
    reply: row.managerDecisionComment ?? "",
    status: row.status,
  };
}

const quietButtonClassName = "border border-slate-300 bg-white text-phx-sm font-bold text-slate-700 hover:bg-slate-50";

export function ExcuseAdminControls({ backHref, row }: { backHref: string; row: EmployeeExcuseRequest }) {
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
      const response = await fetch(`/api/excuses/${encodeURIComponent(row.id)}`, {
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
      const response = await fetch(`/api/excuses/${encodeURIComponent(row.id)}`, { method: "DELETE" });
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

  const replyDisabled = form.status === "pending_manager";

  return (
    <section className={adminPanelClassName}>
      <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Admin controls</h3>
      </header>
      <div className="space-y-3 px-4 py-3">
        <p className="text-phx-xs font-semibold text-slate-600">
          Change or remove this request. Every change is written to the admin audit log, and nobody is notified.
        </p>

        {mode === "idle" ? (
          <div className="flex flex-wrap gap-2">
            <Button className={cn(quietButtonClassName, "gap-1.5")} onClick={startEdit} type="button">
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
                <SearchableSelect className={phxSelectClassName} value={form.excuseType} onChange={(event) => update("excuseType", event.target.value)}>
                  {EXCUSE_ADMIN_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SearchableSelect>
              </FormField>
              <FormField label="Status">
                <SearchableSelect className={phxSelectClassName} value={form.status} onChange={(event) => update("status", event.target.value)}>
                  {EXCUSE_ADMIN_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SearchableSelect>
              </FormField>
              <FormField label="Date">
                <Input type="date" value={form.excuseDate} onChange={(event) => update("excuseDate", event.target.value)} />
              </FormField>
              <div className="hidden sm:block" />
              <FormField className="sm:col-span-2" label="Reply to the employee">
                <Input
                  disabled={replyDisabled}
                  placeholder={replyDisabled ? "Cleared while the request waits for the manager" : "Required when the request is returned"}
                  value={replyDisabled ? "" : form.reply}
                  onChange={(event) => update("reply", event.target.value)}
                />
              </FormField>
            </div>
            <FormActions
              left={
                <Button className={quietButtonClassName} disabled={busy} onClick={() => setMode("idle")} type="button">
                  Cancel
                </Button>
              }
              right={
                <Button
                  className="bg-orange-500 text-phx-sm font-bold text-white hover:bg-orange-600"
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
          <div className="space-y-3 border border-rose-200 bg-rose-50 px-3 py-3 shadow-[0_1px_2px_rgba(127,29,29,0.06),0_12px_28px_rgba(127,29,29,0.08)]">
            <p className="text-phx-sm font-bold text-rose-900">
              Delete {row.requestCode} for {row.employeeName}? This removes the request and gives the month&apos;s excuse back. The admin audit log keeps the deleted record.
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
              <Button className={quietButtonClassName} disabled={busy} onClick={() => setMode("idle")} type="button">
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
