"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { DoctorCoverageConfig, DoctorCoverageNorms } from "@/lib/crm/doctor-coverage-config";

/**
 * Declared locally rather than imported from doctor-coverage-scope.ts. `import type` is erased by
 * TypeScript, but this is a client component and that module reaches the Supabase admin client —
 * the same hazard that put the role list in its own client-safe file. Shape is structural, so the
 * server's DoctorCoverageOverrideCandidate satisfies it without either side importing the other.
 */
type OverrideCandidate = {
  canonicalHrId: string;
  hrId: string;
  jobTitle: string;
  lineId: number | null;
  lineName: string | null;
  name: string;
};

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

export function DoctorCoverageNormsEditor({
  candidates = [],
  initial,
  lines = [],
}: {
  /** People an override can actually affect — line-scoped roles only. */
  candidates?: OverrideCandidate[];
  initial: DoctorCoverageConfig;
  lines?: Array<{ id: number; name: string }>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial.norms));
  const [overrides, setOverrides] = useState<Record<string, number[]>>(() => ({ ...initial.lineOverrides }));
  const [addHrId, setAddHrId] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial.updatedAt);

  const byCanonical = new Map(candidates.map((candidate) => [candidate.canonicalHrId, candidate]));
  const overrideRows = Object.entries(overrides).sort(([a], [b]) =>
    (byCanonical.get(a)?.name ?? a).localeCompare(byCanonical.get(b)?.name ?? b),
  );

  const toggleLine = (key: string, lineId: number) => {
    setOverrides((current) => {
      const have = current[key] ?? [];
      const next = have.includes(lineId) ? have.filter((id) => id !== lineId) : [...have, lineId].sort((a, b) => a - b);
      return { ...current, [key]: next };
    });
  };

  const addOverride = () => {
    const candidate = candidates.find((entry) => entry.canonicalHrId === addHrId);
    if (!candidate || overrides[candidate.canonicalHrId]) return;
    // Seed with the line they already have, so the row starts as a no-op the admin then widens —
    // an empty row would be rejected on save and reads like the control is broken.
    setOverrides((current) => ({
      ...current,
      [candidate.canonicalHrId]: candidate.lineId != null ? [candidate.lineId] : [],
    }));
    setAddHrId("");
  };

  const removeOverride = (key: string) => {
    setOverrides((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const save = async () => {
    setStatus("saving");
    setIssues([]);
    try {
      const norms = {
        sp: { A: Number(draft.sp.A), B: Number(draft.sp.B), C: Number(draft.sp.C) },
        hcp: { A: Number(draft.hcp.A), B: Number(draft.hcp.B), C: Number(draft.hcp.C) },
      };
      const response = await fetch("/api/crm/doctor-coverage/config", {
        body: JSON.stringify({ lineOverrides: overrides, norms }),
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
        setOverrides({ ...payload.config.lineOverrides });
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
            <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{kind.title}</h2>
            <p className="mt-0.5 text-phx-2xs text-slate-400">{kind.hint}</p>
          </div>
          <div className="grid grid-cols-3 gap-3 p-4">
            {GRADES.map((grade) => (
              <label className="space-y-1" key={grade}>
                <span className="block text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">
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
                  <span className="block text-phx-2xs font-semibold text-amber-700">
                    Not scored — leaves the coverage %
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-phx-xs text-slate-600">
          <strong className="font-black">0 does not mean &ldquo;no visits needed&rdquo;.</strong> It means that group is not
          held to a frequency: those contacts drop out of the coverage %, the red/amber/green counts and the call list,
          instead of all turning green.
        </p>
      </div>

      {/* ── Line overrides ──────────────────────────────────────────────────────────────────── */}
      <div className="border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-900 px-4 py-3">
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Line coverage exceptions</h2>
          <p className="mt-0.5 text-phx-2xs text-slate-400">
            Product, Group Product and National Sales Managers normally see the one line on their employee record. Add
            someone here to give them more than one.
          </p>
        </div>

        <div className="divide-y divide-slate-100">
          {overrideRows.length === 0 ? (
            <p className="px-4 py-3 text-xs text-slate-400">
              No exceptions — everyone sees the line on their own record.
            </p>
          ) : (
            overrideRows.map(([key, lineIds]) => {
              const person = byCanonical.get(key);
              return (
                <div className="px-4 py-3" key={key}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="whitespace-nowrap">
                      <span className="text-sm font-bold text-slate-900">{person?.name ?? key.toUpperCase()}</span>
                      <span className="ml-2 text-phx-xs text-slate-400">
                        {person ? `${person.hrId} · ${person.jobTitle}` : "not a line-scoped role any more"}
                      </span>
                    </div>
                    <button
                      className="h-8 border border-slate-200 bg-white px-3 text-phx-2xs font-black uppercase tracking-[0.12em] text-rose-700 hover:border-rose-400"
                      onClick={() => removeOverride(key)}
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3">
                    {lines.map((line) => (
                      <label className="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-slate-700" key={line.id}>
                        <input
                          checked={lineIds.includes(line.id)}
                          onChange={() => toggleLine(key, line.id)}
                          type="checkbox"
                        />
                        {line.name}
                      </label>
                    ))}
                  </div>
                  {lineIds.length === 0 ? (
                    <p className="mt-1 text-phx-2xs font-semibold text-rose-700">
                      Pick at least one line, or remove this row — an empty exception is rejected on save.
                    </p>
                  ) : null}
                  {person?.lineId != null && lineIds.length === 1 && lineIds[0] === person.lineId ? (
                    <p className="mt-1 text-phx-2xs text-slate-400">
                      Same as their own record ({person.lineName ?? "their line"}) — this row changes nothing yet.
                    </p>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <label className="space-y-1">
            <span className="block text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Add a person</span>
            <select
              className="h-9 min-w-64 border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400"
              onChange={(event) => setAddHrId(event.target.value)}
              value={addHrId}
            >
              <option value="">Choose…</option>
              {candidates
                .filter((candidate) => !overrides[candidate.canonicalHrId])
                .map((candidate) => (
                  <option key={candidate.canonicalHrId} value={candidate.canonicalHrId}>
                    {candidate.name} — {candidate.jobTitle} ({candidate.lineName ?? "no line"})
                  </option>
                ))}
            </select>
          </label>
          <button
            className="h-9 border border-slate-200 bg-white px-4 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-600 hover:border-orange-400 disabled:opacity-40"
            disabled={!addHrId}
            onClick={addOverride}
            type="button"
          >
            Add
          </button>
          <span className="whitespace-nowrap text-phx-2xs text-slate-400">
            Only these roles are listed — an exception on a District Manager or a rep would do nothing.
          </span>
        </div>
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
          className="h-9 border border-slate-200 bg-slate-900 px-4 text-phx-xs font-black uppercase tracking-[0.12em] text-white hover:bg-slate-700 disabled:opacity-50"
          disabled={status === "saving"}
          onClick={save}
          type="button"
        >
          {status === "saving" ? "Saving…" : "Save norms"}
        </button>
        {status === "saved" ? <span className="text-xs font-semibold text-emerald-700">Saved.</span> : null}
        {updatedAt ? (
          <span className="text-phx-xs text-slate-400">
            Last changed {new Date(updatedAt).toLocaleString("en-GB", { timeZone: "Africa/Cairo" })} (Cairo)
          </span>
        ) : null}
      </div>
    </div>
  );
}
