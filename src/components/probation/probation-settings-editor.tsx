"use client";

import { useState } from "react";

import type { ProbationConfig } from "@/lib/probation/intelligence/config";

// Admin editor for probation_config (Enhancement E5). Super-Admin only (page-gated). Edits the
// requirements, role weights, scoring scale, SLA hours, scorecard dimensions, and HR toggle, then
// PATCHes /api/probation/config (validated + audited server-side).

const ROLE = ["dm", "tm", "pm_gpm", "nsm"] as const;
const WEIGHT = ["dm", "tm", "pm_gpm", "nsm", "sfe", "hr"] as const;
const LABEL: Record<string, string> = { dm: "DM", tm: "TM", pm_gpm: "PM/GPM", nsm: "NSM", sfe: "SFE", hr: "HR" };

export function ProbationSettingsEditor({ initial }: { initial: ProbationConfig }) {
  const [requirements, setRequirements] = useState({ ...initial.requirements });
  const [roleWeights, setRoleWeights] = useState({ ...initial.roleWeights });
  const [scale, setScale] = useState({ ...initial.scoringScale });
  const [sla, setSla] = useState({ ...initial.sla });
  const [dimsText, setDimsText] = useState(initial.scorecardDimensions.join("\n"));
  const [hrEnabled, setHrEnabled] = useState(initial.hrAssessmentEnabled);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const num = (v: string) => (v === "" ? 0 : Number(v));

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/probation/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requirements, roleWeights, scoringScale: scale, sla,
          scorecardDimensions: dimsText.split("\n").map((d) => d.trim()).filter(Boolean),
          hrAssessmentEnabled: hrEnabled,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setMsg({ tone: "ok", text: "Saved." });
      else setMsg({ tone: "err", text: (data.issues?.join(" ") ?? data.error) || "Save failed." });
    } finally {
      setBusy(false);
    }
  }

  const cell = "h-9 w-24 rounded border border-slate-200 px-2 text-sm";

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Required DV-Days per role</h2>
        <div className="flex flex-wrap gap-3">
          {ROLE.map((r) => (
            <label key={r} className="text-xs text-slate-500">{LABEL[r]}
              <input type="number" min={0} className={`${cell} mt-1 block`} value={requirements[r]}
                onChange={(e) => setRequirements({ ...requirements, [r]: num(e.target.value) })} />
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Role weights</h2>
        <div className="flex flex-wrap gap-3">
          {WEIGHT.map((r) => (
            <label key={r} className="text-xs text-slate-500">{LABEL[r]}
              <input type="number" step="0.01" min={0} className={`${cell} mt-1 block`} value={roleWeights[r]}
                onChange={(e) => setRoleWeights({ ...roleWeights, [r]: num(e.target.value) })} />
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Scoring scale & SLA (hours)</h2>
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-slate-500">Min<input type="number" className={`${cell} mt-1 block`} value={scale.min} onChange={(e) => setScale({ ...scale, min: num(e.target.value) })} /></label>
          <label className="text-xs text-slate-500">Max<input type="number" className={`${cell} mt-1 block`} value={scale.max} onChange={(e) => setScale({ ...scale, max: num(e.target.value) })} /></label>
          <label className="text-xs text-slate-500">Due<input type="number" className={`${cell} mt-1 block`} value={sla.dueHours} onChange={(e) => setSla({ ...sla, dueHours: num(e.target.value) })} /></label>
          <label className="text-xs text-slate-500">Escalate<input type="number" className={`${cell} mt-1 block`} value={sla.escalateHours} onChange={(e) => setSla({ ...sla, escalateHours: num(e.target.value) })} /></label>
          <label className="text-xs text-slate-500">Overdue<input type="number" className={`${cell} mt-1 block`} value={sla.overdueHours} onChange={(e) => setSla({ ...sla, overdueHours: num(e.target.value) })} /></label>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Scorecard dimensions (one per line)</h2>
        <textarea rows={8} className="w-full rounded border border-slate-200 px-3 py-2 text-sm" value={dimsText} onChange={(e) => setDimsText(e.target.value)} />
      </section>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={hrEnabled} onChange={(e) => setHrEnabled(e.target.checked)} />
        HR assessment enabled
      </label>

      {msg && <p className={`text-sm ${msg.tone === "ok" ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>}
      <button disabled={busy} onClick={save} className="self-start rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {busy ? "Saving…" : "Save configuration"}
      </button>
    </div>
  );
}
