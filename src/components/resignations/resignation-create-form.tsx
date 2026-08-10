"use client";

import { Plus } from "lucide-react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type {
  CreateResignationInput,
  ResignationEmployeeOption,
} from "@/lib/resignations/types";

const fieldLabelClassName =
  "mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]";

function Field({ children, className, label }: { children: React.ReactNode; className?: string; label: string }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className={fieldLabelClassName}>{label}</span>
      {children}
    </label>
  );
}

export function ResignationCreateForm({
  employees,
  form,
  isSaving,
  onChange,
  onSubmit,
}: {
  employees: readonly ResignationEmployeeOption[];
  form: CreateResignationInput;
  isSaving: boolean;
  onChange: (key: keyof CreateResignationInput, value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <AdminTableShell
      description="Submit a new resignation record and initialize workflow tracking."
      title="Create Resignation Workflow"
    >
      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-5">
        <Field label="Employee">
          <SearchableSelect
            onChange={(event) => onChange("employeeHrId", event.target.value)}
            value={form.employeeHrId}
          >
            <option value="">Select employee</option>
            {employees.map((employee, index) => (
              <option key={`${employee.value}:${index}`} value={employee.value}>
                {employee.label}
              </option>
            ))}
          </SearchableSelect>
        </Field>

        <Field label="Submitted Date">
          <Input
            onChange={(event) => onChange("submittedDate", event.target.value)}
            type="date"
            value={form.submittedDate}
          />
        </Field>

        <Field label="Effective Date">
          <Input
            onChange={(event) => onChange("effectiveDate", event.target.value)}
            type="date"
            value={form.effectiveDate}
          />
        </Field>

        <Field className="xl:col-span-2" label="Reason">
          <Input
            onChange={(event) => onChange("reason", event.target.value)}
            placeholder="Personal, career move, misconduct, redundancy..."
            value={form.reason ?? ""}
          />
        </Field>

        <Field className="md:col-span-2 xl:col-span-5" label="Workflow Note">
          <textarea
            className="min-h-24 w-full border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
            onChange={(event) => onChange("workflowNotes", event.target.value)}
            placeholder="Optional admin context for the initial submission."
            value={form.workflowNotes ?? ""}
          />
        </Field>

        <div className="xl:col-span-5">
          <Button className="h-11 w-full gap-2" disabled={isSaving} onClick={onSubmit}>
            <Plus className="h-4 w-4" />
            Create Workflow
          </Button>
        </div>
      </div>
    </AdminTableShell>
  );
}
