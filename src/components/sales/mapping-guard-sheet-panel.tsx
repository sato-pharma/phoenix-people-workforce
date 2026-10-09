"use client";

import { useCallback, useRef, useState } from "react";

import { formatEgp } from "@/lib/sales/mapping-guard-hold-shape";
import {
  GUARD_ANSWER_LABEL,
  type GuardInstruction,
  type GuardPlan,
  type GuardPlanRow,
} from "@/lib/sales/mapping-guard-sheet-shape";
import type { HeldMappingChange } from "@/lib/sales/mapping-guard";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
} from "@/components/ui/form-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// The held changes as a sheet — export it, answer it in Excel, upload it back.
//
// Owner, 2026-10-10: "make me able to export xlsx with their address area brick and every geography
// data and map and upload".
//
// UPLOAD IS A PREVIEW FIRST, AND THE PREVIEW WRITES NOTHING. He sees what each row would do, the
// bricks, areas and governorates it touches, the sales money riding on it, and every row that
// cannot be checked; only then does one button write. Rows are written a page at a time, because
// each answer is several round trips, and a page the database no longer agrees with is refused whole.
//
// FITS BY CONSTRUCTION: stacked blocks and wrapping text, no table and no min-width, so there is
// nothing for a horizontal scroller to hide at 375px or at desktop. SQUARE EDGES, no radius anywhere.
// ─────────────────────────────────────────────────────────────────────────────

export type GuardSheetApplied = {
  decided: number;
  locked: number;
  failed: Array<{ holdId: number; customer: string; reason?: string }>;
  warnings: Array<{ holdId: number; customer: string; warning?: string }>;
  brickMoves: Array<{ holdId: number; brickMove?: unknown }>;
  /** The screen's refreshed list, sent with the last page. */
  holds?: HeldMappingChange[];
};

type Phase = "idle" | "exporting" | "previewing" | "ready" | "applying";

type ApplyPayload = {
  success?: boolean;
  error?: string;
  decided?: number;
  locked?: number;
  failed?: GuardSheetApplied["failed"];
  warnings?: GuardSheetApplied["warnings"];
  brickMoves?: GuardSheetApplied["brickMoves"];
  holds?: HeldMappingChange[];
};

function instructionOf(row: GuardPlanRow): GuardInstruction {
  return {
    answer: row.answer,
    holdId: row.holdId,
    lock: row.lock,
    moveToBrickId: row.moveToBrickId,
    nowBrickId: row.nowBrickId,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-slate-200 bg-white px-3 py-2">
      <div className="text-phx-2xs uppercase tracking-[0.12em] text-slate-400">{label}</div>
      <div className="text-sm font-semibold text-[#0B0B0B]">{value}</div>
    </div>
  );
}

function PlanRow({ row }: { row: GuardPlanRow }) {
  return (
    <li className="border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-semibold text-[#0B0B0B]">{row.customer}</span>
        <span className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">
          {GUARD_ANSWER_LABEL[row.answer]}
          {row.lock ? " · locked" : ""}
        </span>
      </div>
      <div className="mt-1 break-words text-slate-600">
        {row.from} <span className="text-slate-400">→</span> {row.to}
      </div>
      {row.trackedValue > 0 ? (
        <div className="mt-1 text-phx-2xs text-slate-500">
          {formatEgp(row.trackedValue)} of tracked sales
          {row.restatedValue > 0 ? `, ${formatEgp(row.restatedValue)} of it in finished months` : ""}
        </div>
      ) : null}
      {row.overridesRuling ? (
        <div className="mt-1 text-phx-2xs font-semibold text-amber-800">
          This overrides a ruling you made earlier on this customer.
        </div>
      ) : null}
    </li>
  );
}

export function MappingGuardSheetPanel({ onApplied }: { onApplied: (result: GuardSheetApplied) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<GuardPlan | null>(null);
  const [fileName, setFileName] = useState("");
  const [progress, setProgress] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = phase === "exporting" || phase === "previewing" || phase === "applying";

  const download = useCallback(async () => {
    setPhase("exporting");
    setError(null);
    try {
      const response = await fetch("/api/sales/mapping-guard/sheet/export", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "The sheet could not be exported.");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "phoenix-held-mapping-changes.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("The sheet could not be exported.");
    } finally {
      setPhase("idle");
    }
  }, []);

  const preview = useCallback(async (file: File) => {
    setPhase("previewing");
    setError(null);
    setPlan(null);
    setFileName(file.name);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/sales/mapping-guard/sheet/preview", { body: form, method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string; plan?: GuardPlan };
      if (!response.ok || !payload.success || !payload.plan) {
        setError(payload.error ?? "That sheet could not be read.");
        setPhase("idle");
        return;
      }
      setPlan(payload.plan);
      setPhase("ready");
    } catch {
      setError("That sheet could not be read.");
      setPhase("idle");
    }
  }, []);

  const discard = useCallback(() => {
    setPlan(null);
    setFileName("");
    setError(null);
    setProgress("");
    setPhase("idle");
    if (fileInput.current) fileInput.current.value = "";
  }, []);

  const apply = useCallback(async () => {
    if (!plan || plan.rows.length === 0) return;
    setPhase("applying");
    setError(null);
    const total: GuardSheetApplied = { brickMoves: [], decided: 0, failed: [], locked: 0, warnings: [] };
    try {
      for (let index = 0; index < plan.pages.length; index += 1) {
        const page = plan.pages[index];
        const wanted = new Set(page.holdIds);
        const last = index === plan.pages.length - 1;
        setProgress(`Writing page ${index + 1} of ${plan.pages.length}`);
        const response = await fetch("/api/sales/mapping-guard/sheet/apply", {
          body: JSON.stringify({
            digest: page.digest,
            instructions: plan.rows.filter((row) => wanted.has(row.holdId)).map(instructionOf),
            last,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const payload = (await response.json().catch(() => ({}))) as ApplyPayload;
        if (!response.ok || !payload.success) {
          // Pages before this one are already written; say so rather than pretend nothing happened.
          const written = total.decided;
          setError(
            `${payload.error ?? "That page did not go through."}${
              written > 0 ? ` ${plural(written, "answer was", "answers were")} written before it.` : " Nothing was written."
            }`,
          );
          if (written > 0) onApplied({ ...total });
          setPhase("idle");
          setPlan(null);
          setProgress("");
          return;
        }
        total.decided += payload.decided ?? 0;
        total.locked += payload.locked ?? 0;
        total.failed.push(...(payload.failed ?? []));
        total.warnings.push(...(payload.warnings ?? []));
        total.brickMoves.push(...(payload.brickMoves ?? []));
        if (last) total.holds = payload.holds;
      }
      onApplied(total);
      discard();
    } catch {
      setError("The answers could not be written. Preview the sheet again to see what is still waiting.");
      setPhase("idle");
      setPlan(null);
      setProgress("");
    }
  }, [discard, onApplied, plan]);

  const nothingToDo = plan !== null && plan.rows.length === 0;

  return (
    <section aria-label="Answer the held changes in a spreadsheet" className="space-y-3 border border-phx-line bg-white p-3">
      <div>
        <h2 className="text-sm font-semibold text-[#0B0B0B]">Answer them in a spreadsheet</h2>
        <p className="mt-1 text-sm text-slate-600">
          Export the held changes with each customer&apos;s name, address, brick, area and governorate — as Phoenix
          holds them and as the distributor filed them — answer in Excel, then upload the sheet back. You see
          exactly what each row would do before anything is written.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button className={phxButtonGhostClassName} disabled={busy} onClick={() => void download()} type="button">
          {phase === "exporting" ? "Preparing the sheet" : "Export the sheet"}
        </button>
        <button
          className={phxButtonPrimaryClassName}
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          type="button"
        >
          {phase === "previewing" ? "Reading the sheet" : "Upload the answered sheet"}
        </button>
        <input
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void preview(file);
          }}
          ref={fileInput}
          tabIndex={-1}
          type="file"
        />
      </div>

      {error ? <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

      {plan ? (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <p className="break-words text-sm text-slate-600">
            <span className="font-semibold text-[#0B0B0B]">{fileName}</span> — nothing has been written yet.
          </p>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Allow" value={String(plan.counts.allow)} />
            <Stat label="Keep as is" value={String(plan.counts.keep)} />
            <Stat label="Move to my brick" value={String(plan.counts.move)} />
            <Stat label="Will be locked" value={String(plan.counts.locking)} />
            <Stat label="Tracked sales behind them" value={formatEgp(plan.trackedValue)} />
            <Stat label="Of it in finished months" value={formatEgp(plan.restatedValue)} />
            <Stat label="Left blank" value={String(plan.skipped)} />
            <Stat label="Cannot be applied" value={String(plan.problems.length)} />
          </div>

          {plan.overridesRulings > 0 ? (
            <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {plural(plan.overridesRulings, "answer overrides", "answers override")} a ruling you made earlier on the
              same customer. They are marked below.
            </p>
          ) : null}

          {plan.problems.length > 0 ? (
            <div className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <p className="font-semibold">
                {plural(plan.problems.length, "row cannot", "rows cannot")} be applied and will be left exactly as{" "}
                {plan.problems.length === 1 ? "it is" : "they are"}.
              </p>
              <ul className="mt-1 space-y-1">
                {plan.problems.map((problem) => (
                  <li className="break-words" key={`${problem.sheetRow}-${problem.holdId ?? "x"}`}>
                    Sheet row {problem.sheetRow}
                    {problem.customer ? ` — ${problem.customer}` : ""}: {problem.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {plan.rows.length > 0 ? (
            <details className="border border-slate-200" open={plan.rows.length <= 25}>
              <summary className="cursor-pointer bg-slate-50 px-3 py-2 text-sm font-semibold text-[#0B0B0B]">
                {plural(plan.rows.length, "answer", "answers")} ready to write
              </summary>
              <ul className="space-y-2 p-2">
                {plan.rows.map((row) => (
                  <PlanRow key={row.holdId} row={row} />
                ))}
              </ul>
            </details>
          ) : null}

          {nothingToDo ? (
            <p className="text-sm text-slate-600">
              Nothing in this sheet can be written. Answer some rows in the orange columns, or export again.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              className={phxButtonAccentClassName}
              disabled={busy || plan.rows.length === 0}
              onClick={() => void apply()}
              type="button"
            >
              {phase === "applying" ? progress || "Writing" : `Write ${plural(plan.rows.length, "answer", "answers")}`}
            </button>
            <button className={phxButtonGhostClassName} disabled={phase === "applying"} onClick={discard} type="button">
              Discard this sheet
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
