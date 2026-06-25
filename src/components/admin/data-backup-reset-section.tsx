"use client";

import { useState } from "react";

import { MODULE_META } from "@/lib/admin/data-backup";
import { RESET_GROUPS, type ResetScope, type ResetTableResult } from "@/lib/admin/data-reset";

const REQUIRED_CONFIRMATION = "CONFIRM DELETE";

type ResetState =
  | { status: "idle" }
  | { status: "confirming"; scope: ResetScope }
  | { status: "loading"; scope: ResetScope }
  | { status: "done"; scope: ResetScope; tables: ResetTableResult[]; totalDeleted: number }
  | { status: "error"; message: string };

export function DataBackupResetSection() {
  const [state, setState] = useState<ResetState>({ status: "idle" });
  const [confirmText, setConfirmText] = useState("");

  function startConfirm(scope: ResetScope) {
    setConfirmText("");
    setState({ status: "confirming", scope });
  }

  function cancelConfirm() {
    setConfirmText("");
    setState({ status: "idle" });
  }

  async function executeReset(scope: ResetScope) {
    if (confirmText !== REQUIRED_CONFIRMATION) return;
    setState({ status: "loading", scope });
    try {
      const res = await fetch("/api/admin/data-backup/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, confirmation: confirmText }),
      });
      const json = (await res.json()) as { ok?: boolean; result?: { tables: ResetTableResult[]; totalDeleted: number }; message?: string };
      if (!res.ok || !json.ok) {
        setState({ status: "error", message: json.message ?? "Reset failed." });
        return;
      }
      setState({
        status: "done",
        scope,
        tables: json.result?.tables ?? [],
        totalDeleted: json.result?.totalDeleted ?? 0,
      });
      setConfirmText("");
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Network error." });
    }
  }

  const confirmingScope = state.status === "confirming" ? state.scope : null;

  const scopeGroups = (scope: ResetScope) =>
    scope === "all" ? RESET_GROUPS : RESET_GROUPS.filter((g) => g.module === scope);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 border border-amber-300 bg-amber-50 p-4">
        <span className="mt-0.5 text-lg leading-none text-amber-600">⚠</span>
        <div className="space-y-1 text-sm text-amber-800">
          <p className="font-semibold">Irreversible operation — download the backup FIRST</p>
          <p>
            Resetting a module permanently deletes all uploaded data from the database.
            This cannot be undone. Make sure you have downloaded and verified the XLSX backup above before proceeding.
          </p>
        </div>
      </div>

      {/* Per-module reset cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {(["sales", "weekly", "marketing"] as const).map((mod) => {
          const meta = MODULE_META[mod];
          const groups = scopeGroups(mod);
          const tableCount = groups.flatMap((g) => g.tables).length;
          const isConfirming = confirmingScope === mod;

          return (
            <div key={mod} className="border border-red-100 bg-white">
              <div className="border-b border-red-100 p-4">
                <div className="mb-1 flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: `#${meta.tabColor}` }}
                  />
                  <p className="text-sm font-bold text-slate-900">{meta.label}</p>
                </div>
                {groups.map((g) => (
                  <p key={g.label} className="mt-1 text-xs text-slate-500">{g.description}</p>
                ))}
                <p className="mt-2 text-xs font-medium text-red-600">{tableCount} tables will be wiped</p>
              </div>

              <div className="p-4">
                {!isConfirming ? (
                  <button
                    className="w-full border border-red-300 px-3 py-2 text-xs font-semibold text-red-600 hover:border-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={state.status === "loading"}
                    onClick={() => startConfirm(mod)}
                    type="button"
                  >
                    Reset {meta.label}
                  </button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-slate-700">
                      Type <span className="font-mono font-bold">{REQUIRED_CONFIRMATION}</span> to confirm:
                    </p>
                    <input
                      autoFocus
                      className="w-full border border-slate-300 px-2 py-1.5 font-mono text-xs focus:border-red-400 focus:outline-none"
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder={REQUIRED_CONFIRMATION}
                      type="text"
                      value={confirmText}
                    />
                    <div className="flex gap-2">
                      <button
                        className="flex-1 border border-red-500 bg-red-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={confirmText !== REQUIRED_CONFIRMATION || state.status === "loading"}
                        onClick={() => executeReset(mod)}
                        type="button"
                      >
                        {state.status === "loading" ? "Deleting…" : "Delete Now"}
                      </button>
                      <button
                        className="flex-1 border border-slate-300 px-2 py-1.5 text-xs font-semibold text-slate-600 hover:border-slate-500"
                        onClick={cancelConfirm}
                        type="button"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Reset all — extra wide warning */}
      <div className="border border-red-200 bg-white p-4">
        <p className="mb-2 text-sm font-bold text-red-700">Reset All Modules at Once</p>
        <p className="mb-3 text-xs text-slate-500">
          Wipes Source of Sales, Weekly Sales, and Marketing Requests uploaded data in one operation.
          {" "}{RESET_GROUPS.flatMap((g) => g.tables).length} tables total.
        </p>
        {confirmingScope !== "all" ? (
          <button
            className="border border-red-500 bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={state.status === "loading"}
            onClick={() => startConfirm("all")}
            type="button"
          >
            Reset All Modules
          </button>
        ) : (
          <div className="max-w-sm space-y-2">
            <p className="text-xs font-medium text-slate-700">
              Type <span className="font-mono font-bold">{REQUIRED_CONFIRMATION}</span> to confirm:
            </p>
            <input
              autoFocus
              className="w-full border border-slate-300 px-2 py-1.5 font-mono text-xs focus:border-red-400 focus:outline-none"
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={REQUIRED_CONFIRMATION}
              type="text"
              value={confirmText}
            />
            <div className="flex gap-2">
              <button
                className="border border-red-500 bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={confirmText !== REQUIRED_CONFIRMATION || state.status === "loading"}
                onClick={() => executeReset("all")}
                type="button"
              >
                {state.status === "loading" ? "Deleting…" : "Delete All — Confirm"}
              </button>
              <button
                className="border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:border-slate-500"
                onClick={cancelConfirm}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Result */}
      {state.status === "done" && (
        <div className="border border-green-300 bg-green-50 p-4">
          <p className="mb-2 text-sm font-semibold text-green-800">
            Reset complete — {state.totalDeleted.toLocaleString()} rows deleted across {state.tables.length} tables
          </p>
          <div className="space-y-0.5">
            {state.tables.map((t) => (
              <p key={t.table} className="font-mono text-xs text-green-700">
                {t.table}: {t.deleted.toLocaleString()} rows deleted
              </p>
            ))}
          </div>
        </div>
      )}

      {state.status === "error" && (
        <div className="border border-red-300 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-800">Reset failed</p>
          <p className="mt-1 font-mono text-xs text-red-700">{state.message}</p>
          <button
            className="mt-2 text-xs text-red-600 underline"
            onClick={() => setState({ status: "idle" })}
            type="button"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
