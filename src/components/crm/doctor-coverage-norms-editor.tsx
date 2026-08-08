"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { DoctorCoverageConfig, DoctorCoverageNorms } from "@/lib/crm/doctor-coverage-config";

// Doctor Coverage visit-norms editor. Six numbers: visits required per month, for each grade
// (A / B / C) and each contact kind — doctors (SP) and pharmacies/hospitals/contracts (HCP).
//
// Zero is a real, meaningful value here and the UI has to say so: it does NOT mean "needs zero
// visits" (which would paint every one of them green), it means that population is not held to a
// frequency at all and leaves the coverage % entirely.

const GRADES = ["A", "B", "C"] as const;
const KINDS = [
  {
    key: "sp" as const,
    title: "Doctors (SP)",
    hint: "Every medical specialty — Internal Medicine, Pediatrics, ENT, Neurology, Chest, GP, Urology, and the rest.",
  },
  {
    key: "hcp" as const,
    title: "Pharmacies, hospitals & accounts (HCP)",
    hint: "Pharmacy, Hospital, Private/University/Armed Forces/Police Hospital, Polyclinics, Contract, Health Insurance.",
  },
];

type Draft = Record<"sp" | "hcp", Record<"A" | "B" | "C", string>>;

function toDraft(norms: DoctorCoverageNorms): Draft {
  return {
    sp: { A: String(norms.sp.A), B: String(norms.sp.B), C: String(norms.sp.C) },
    hcp: { A: String(norms.hcp.A), B: String(norms.hcp.B), C: String(norms.hcp.C) },
  };
}

export function DoctorCoverageNormsEditor({ initial }: { initial: DoctorCoverageConfig }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial.norms));
  const [issues, setIssues] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial.updatedAt);

  const save = async () => {
    setStatus("saving");
    setIssues([]);
    try {
      const norms = {
        sp: { A: Number(draft.sp.A), B: Number(draft.sp.B), C: Number(draft.sp.C) },
        hcp: { A: Number(draft.hcp.A), B: Number(draft.hcp.B), C: Number(draft.hcp.C) },
      };
      const response = await fetch("/api/crm/doctor-coverage/config", {
        body: JSON.stringify({ norms }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = (await response.json()) as {
        config?: DoctorCoverageConfig;
        error?: string;
        issues?: string[];
      };
      if (!response.ok) {
        setIssues(payload.issues?.length ? payload.issues : [payload.error ?? "Could not save."]);
        setStatus("idle");
        return;
      }
      if (payload.config) {
        setDraft(toDraft(payload.config.norms));
        setUpdatedAt(payload.config.updatedAt);
      }
      setStatus("saved");
      // The board reads the norms server-side, so refresh so any open board reflects the change.
      router.refresh();
    } catch (error) {
      setIssues([error instanceof Error ? error.message : "Could not save."]);
      setStatus("idle");
    }
  };

  return (
    <div className="space-y-4">
      {KINDS.map((kind) => (
        <div className="border border-slate-200 bg-white" key={kind.key}>
          <div className="border-b border-slate-200 bg-slate-900 px-4 py-3">
            <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">{kind.title}</h2>
            <p className="mt-0.5 text-[10px] text-slate-400">{kind.hint}</p>
          </div>
          <div className="grid grid-cols-3 gap-3 p-4">
            {GRADES.map((grade) => (
              <label className="space-y-1" key={grade}>
                <span className="block text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">
                  Grade {grade} — visits / month
                </span>
                <input
                  className="h-9 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-400"
                  inputMode="numeric"
                  max={31}
                  min={0}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [kind.key]: { ...current[kind.key], [grade]: event.target.value },
                    }))
                  }
                  type="number"
                  value={draft[kind.key][grade]}
                />
                {draft[kind.key][grade].trim() === "0" ? (
                  <span className="block text-[10px] font-semibold text-amber-700">
                    Not scored — leaves the coverage %
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-[11px] text-slate-600">
          <strong className="font-black">0 does not mean &ldquo;no visits needed&rdquo;.</strong> It means that group is not
          held to a frequency: those contacts drop out of the coverage %, the red/amber/green counts and the call list,
          instead of all turning green.
        </p>
      </div>

      {issues.length > 0 ? (
        <div className="border border-rose-200 bg-rose-50 px-4 py-3">
          <p className="text-sm font-bold text-rose-800">Not saved.</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-rose-700">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          className="h-9 border border-slate-200 bg-slate-900 px-4 text-[11px] font-black uppercase tracking-[0.12em] text-white hover:bg-slate-700 disabled:opacity-50"
          disabled={status === "saving"}
          onClick={save}
          type="button"
        >
          {status === "saving" ? "Saving…" : "Save norms"}
        </button>
        {status === "saved" ? <span className="text-xs font-semibold text-emerald-700">Saved.</span> : null}
        {updatedAt ? (
          <span className="text-[11px] text-slate-400">
            Last changed {new Date(updatedAt).toLocaleString("en-GB", { timeZone: "Africa/Cairo" })} (Cairo)
          </span>
        ) : null}
      </div>
    </div>
  );
}
