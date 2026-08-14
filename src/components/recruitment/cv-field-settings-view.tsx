"use client";

// Recruitment / ATS — the include/exclude switch for every field CV extraction can read.
//
// See src/lib/recruitment/cv-field-settings.ts for the rule this renders: enabled is the default,
// the table stores only deviations, and switching a field off removes it from the AI request
// schema itself — so an off field costs no tokens and simply never produces a value. That is also
// why the warning below is permanent: a field that was off during an extraction is not recoverable
// from that extraction afterwards, only from the CV.
//
// Imports the schema from cv-field-schemas.ts, which is deliberately pure/isomorphic. The settings
// service is server-only (it hits the database) and is never imported here.

import { Lock } from "lucide-react";
import { useState } from "react";

import { Switch } from "@/components/ui/switch";
import {
  CV_FIELD_SECTIONS,
  type CvFieldDefinition,
  type CvFieldType,
} from "@/lib/recruitment/cv-field-schemas";
import { cn } from "@/lib/utils";

export type CvFieldSettingRow = CvFieldDefinition & { enabled: boolean; locked: boolean };

const TYPE_LABEL: Record<CvFieldType, string> = {
  array: "List",
  boolean: "Yes / No",
  date: "Date",
  number: "Number",
  string: "Text",
};

// Repeating blocks are the reason one CV yields five employer rows and another none — say so, and
// name the entry's own fields, so the row explains what a "List" actually captures.
function entryShape(field: CvFieldSettingRow): string | null {
  if (field.type !== "array" || !field.itemFields?.length) return null;
  return field.itemFields.map((item) => item.label).join(" · ");
}

function FieldNotes({ field }: { field: CvFieldSettingRow }) {
  const shape = entryShape(field);
  return (
    <>
      <span className="block text-slate-600">{field.aiDescription}</span>
      {shape ? (
        <span className="mt-1 block text-xs text-slate-500">
          Repeating block — one entry per item, each holding: {shape}
        </span>
      ) : null}
      {field.locked ? (
        <span className="mt-1 block text-xs text-slate-500">
          Always extracted. Candidate matching and duplicate detection are built on this field, so switching it off
          would make every inbound CV a brand-new candidate.
        </span>
      ) : null}
    </>
  );
}

function FieldControl({
  field,
  pending,
  onToggle,
}: {
  field: CvFieldSettingRow;
  pending: boolean;
  onToggle: (fieldKey: string, enabled: boolean) => void;
}) {
  // A locked field is not a greyed-out switch with no explanation — it reads as its own state,
  // and FieldNotes carries the reason next to it.
  if (field.locked) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Lock aria-hidden="true" className="h-3 w-3" />
        Always on
      </span>
    );
  }

  return (
    <div className={cn("flex items-center gap-2 whitespace-nowrap", pending && "pointer-events-none opacity-50")}>
      <span className={cn("text-xs font-bold", field.enabled ? "text-emerald-700" : "text-slate-400")}>
        {field.enabled ? "On" : "Off"}
      </span>
      <Switch
        checked={field.enabled}
        label={`Extract ${field.label}`}
        onChange={(next) => onToggle(field.key, next)}
      />
    </div>
  );
}

function SectionCard({
  fields,
  label,
  pending,
  onToggle,
}: {
  fields: readonly CvFieldSettingRow[];
  label: string;
  pending: Record<string, boolean>;
  onToggle: (fieldKey: string, enabled: boolean) => void;
}) {
  const onCount = fields.filter((field) => field.enabled).length;

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <h2 className="whitespace-nowrap border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700">
        {label} <span className="font-normal text-slate-400">— {onCount} of {fields.length} on</span>
      </h2>

      {/* Desktop: the full table. Mobile gets the cards below instead — admin-shell rule. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="whitespace-nowrap px-3 py-2">Field</th>
              <th className="whitespace-nowrap px-3 py-2">What it captures</th>
              <th className="whitespace-nowrap px-3 py-2">Type</th>
              <th className="whitespace-nowrap px-3 py-2">Extraction</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr className="border-t border-slate-100 align-top" key={field.key}>
                <td className="whitespace-nowrap px-3 py-2.5 font-medium text-slate-800">{field.label}</td>
                <td className="px-3 py-2.5 text-sm">
                  <FieldNotes field={field} />
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">{TYPE_LABEL[field.type]}</td>
                <td className="px-3 py-2.5">
                  <FieldControl field={field} onToggle={onToggle} pending={Boolean(pending[field.key])} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per field, never the table. */}
      <ul className="divide-y divide-slate-100 md:hidden">
        {fields.map((field) => (
          <li className="p-4" key={field.key}>
            <div className="flex items-center justify-between gap-3">
              <span className="whitespace-nowrap font-medium text-slate-800">{field.label}</span>
              <FieldControl field={field} onToggle={onToggle} pending={Boolean(pending[field.key])} />
            </div>
            <p className="mt-1 whitespace-nowrap text-[11px] uppercase tracking-wide text-slate-400">
              {TYPE_LABEL[field.type]}
            </p>
            <div className="mt-2 text-sm">
              <FieldNotes field={field} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CvFieldSettingsView({ fields: initialFields }: { fields: CvFieldSettingRow[] }) {
  const [fields, setFields] = useState(initialFields);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  async function toggle(fieldKey: string, enabled: boolean) {
    setError(null);
    setPending((prev) => ({ ...prev, [fieldKey]: true }));
    // Optimistic — the switch answers immediately and flips back if the write is refused. The
    // server is still the authority: setCvFieldEnabled rejects an unknown key and any attempt to
    // switch off an identity field.
    setFields((prev) => prev.map((field) => (field.key === fieldKey ? { ...field, enabled } : field)));
    try {
      const res = await fetch("/api/recruitment/cv-field-settings", {
        body: JSON.stringify({ enabled, fieldKey }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message || "Failed to save the field setting.");
    } catch (caught) {
      setFields((prev) => prev.map((field) => (field.key === fieldKey ? { ...field, enabled: !enabled } : field)));
      setError(caught instanceof Error ? caught.message : "Failed to save the field setting.");
    } finally {
      setPending((prev) => ({ ...prev, [fieldKey]: false }));
    }
  }

  const onCount = fields.filter((field) => field.enabled).length;
  const offCount = fields.length - onCount;

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-2.5 text-sm text-rose-900">{error}</p>
      ) : null}

      <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
        Switching a field off removes it from the AI request itself, not just from this list. Nothing is captured for
        it on any CV read while it is off, and that gap cannot be filled in later from the extraction — only by
        opening the CV again.
      </p>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <p className="whitespace-nowrap text-[11px] uppercase tracking-wide text-slate-500">Fields captured</p>
            <p className="whitespace-nowrap text-lg font-semibold text-slate-900">
              {onCount} of {fields.length}
            </p>
          </div>
          <div>
            <p className="whitespace-nowrap text-[11px] uppercase tracking-wide text-slate-500">Switched off</p>
            <p className="whitespace-nowrap text-lg font-semibold text-slate-900">{offCount}</p>
          </div>
        </div>
      </section>

      {CV_FIELD_SECTIONS.map((section) => {
        const sectionFields = fields.filter((field) => field.section === section.key);
        if (sectionFields.length === 0) return null;
        return (
          <SectionCard
            fields={sectionFields}
            key={section.key}
            label={section.label}
            onToggle={toggle}
            pending={pending}
          />
        );
      })}
    </div>
  );
}
