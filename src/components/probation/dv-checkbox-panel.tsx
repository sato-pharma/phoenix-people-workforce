"use client";

import { useState } from "react";
import { CheckSquare, Square, Pencil } from "lucide-react";

import type { DvCheckboxState } from "@/lib/probation/feedback-service";

type DvField = "dm" | "nsm" | "pm_gpm" | "tm";

type Props = {
  probationId: number;
  dvState: DvCheckboxState;
  canManualOverride: boolean;
  onChanged?: () => void;
};

const LABELS: Record<DvField, string> = {
  dm: "DM DV",
  nsm: "NSM DV",
  pm_gpm: "PM/GPM DV",
  tm: "TM DV",
};

export function DvCheckboxPanel({ probationId, dvState, canManualOverride, onChanged }: Props) {
  const [saving, setSaving] = useState<DvField | null>(null);
  const [localState, setLocalState] = useState(dvState);

  const fields: DvField[] = ["dm", "nsm", "pm_gpm", "tm"];

  async function toggle(field: DvField) {
    if (!canManualOverride) return;
    const current = getDone(field);
    if (current === null) return; // CNS — not applicable
    setSaving(field);
    try {
      const res = await fetch("/api/probation/feedback/dv-checkbox", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ probationId, field, value: !current }),
      });
      if (res.ok) {
        applyLocal(field, !current);
        onChanged?.();
      }
    } finally {
      setSaving(null);
    }
  }

  function getDone(field: DvField): boolean | null {
    switch (field) {
      case "dm": return localState.dmDvDone;
      case "nsm": return localState.nsmDvDone;
      case "pm_gpm": return localState.pmGpmDvDone;
      case "tm": return localState.tmDvDone;
    }
  }

  function getManual(field: DvField): boolean {
    switch (field) {
      case "dm": return localState.dmDvDoneManually;
      case "nsm": return localState.nsmDvDoneManually;
      case "pm_gpm": return localState.pmGpmDvDoneManually;
      case "tm": return localState.tmDvDoneManually;
    }
  }

  function applyLocal(field: DvField, value: boolean) {
    setLocalState(prev => {
      switch (field) {
        case "dm": return { ...prev, dmDvDone: value, dmDvDoneManually: true };
        case "nsm": return { ...prev, nsmDvDone: value, nsmDvDoneManually: true };
        case "pm_gpm": return { ...prev, pmGpmDvDone: value, pmGpmDvDoneManually: true };
        case "tm": return { ...prev, tmDvDone: value, tmDvDoneManually: true };
      }
    });
  }

  const applicable = fields.filter(f => getDone(f) !== null);
  const doneCount = applicable.filter(f => getDone(f) === true).length;

  return (
    <div className="flex flex-wrap items-center gap-3">
      {fields.map(field => {
        const done = getDone(field);
        if (done === null) return null; // CNS — hide PM/GPM
        const isManual = getManual(field);
        const isSaving = saving === field;

        return (
          <button
            key={field}
            type="button"
            disabled={!canManualOverride || isSaving}
            onClick={() => toggle(field)}
            className="flex items-center gap-1.5 text-xs whitespace-nowrap disabled:cursor-default"
            title={isManual ? "Set manually by HR" : done ? "Auto-ticked from DV import" : "Not yet done"}
          >
            {done
              ? <CheckSquare className="size-4 text-emerald-600 shrink-0" />
              : <Square className="size-4 text-slate-300 shrink-0" />}
            <span className={done ? "text-slate-700 font-medium" : "text-slate-400"}>
              {LABELS[field]}
            </span>
            {isManual && done && (
              <Pencil className="size-3 text-slate-400" />
            )}
          </button>
        );
      })}
      <span className="ml-1 text-xs text-slate-500 whitespace-nowrap">
        {doneCount}/{applicable.length} DV done
      </span>
    </div>
  );
}
