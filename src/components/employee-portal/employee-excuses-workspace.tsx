"use client";

import { useMemo, useState, useTransition } from "react";
import { CalendarClock, CheckCircle2, Clock3, History, Send, XCircle } from "lucide-react";

import type { EmployeeExcuseWorkspaceData, EmployeeExcuseStatus } from "@/lib/excuses/service";

type EmployeeExcusesWorkspaceProps = {
  initialData: EmployeeExcuseWorkspaceData;
};

function statusClass(status: EmployeeExcuseStatus) {
  if (status === "approved") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "rejected") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function statusIcon(status: EmployeeExcuseStatus) {
  if (status === "approved") return CheckCircle2;
  if (status === "rejected") return XCircle;
  return Clock3;
}

function typeLabel(type: "morning" | "afternoon") {
  return type === "morning" ? "Morning excuse" : "Afternoon excuse";
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

export function EmployeeExcusesWorkspace({ initialData }: EmployeeExcusesWorkspaceProps) {
  const [workspace, setWorkspace] = useState(initialData);
  const [activeTab, setActiveTab] = useState<"request" | "history">("request");
  const [excuseDate, setExcuseDate] = useState(todayDate());
  const [excuseType, setExcuseType] = useState<"morning" | "afternoon">("morning");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const currentMonthLabel = useMemo(() => {
    const [year, month] = workspace.monthly.yearMonth.split("-");
    return new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  }, [workspace.monthly.yearMonth]);

  const submitDisabled = isPending || workspace.monthly.remaining <= 0;

  const handleSubmit = () => {
    setMessage(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/excuses", {
          body: JSON.stringify({ excuseDate, excuseType }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = await response.json().catch(() => null) as {
          message?: string;
          success?: boolean;
          workspace?: EmployeeExcuseWorkspaceData;
        } | null;

        if (!response.ok || !payload?.success || !payload.workspace) {
          throw new Error(payload?.message || "Unable to submit excuse request.");
        }

        setWorkspace(payload.workspace);
        setActiveTab("history");
        setMessage({ kind: "success", text: "Excuse request sent to your direct manager." });
      } catch (error) {
        setMessage({
          kind: "error",
          text: error instanceof Error ? error.message : "Unable to submit excuse request.",
        });
      }
    });
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(360px,0.45fr)]">
      <section className="overflow-hidden rounded border border-white/80 bg-white/92 shadow-[0_22px_60px_rgba(15,23,42,0.08)] ring-1 ring-slate-200/70 backdrop-blur">
        <div className="border-b border-slate-100 bg-gradient-to-r from-slate-50 to-orange-50/40 p-4 sm:p-5">
          <div className="inline-flex rounded border border-slate-200 bg-white p-1 shadow-sm">
            <button
              className={`inline-flex items-center gap-2 rounded px-4 py-2 text-xs font-black transition ${activeTab === "request" ? "bg-[#17233E] text-white shadow-sm" : "text-slate-500 hover:text-[#17233E]"}`}
              onClick={() => setActiveTab("request")}
              type="button"
            >
              <Send className="h-4 w-4" />
              New Excuse
            </button>
            <button
              className={`inline-flex items-center gap-2 rounded px-4 py-2 text-xs font-black transition ${activeTab === "history" ? "bg-[#17233E] text-white shadow-sm" : "text-slate-500 hover:text-[#17233E]"}`}
              onClick={() => setActiveTab("history")}
              type="button"
            >
              <History className="h-4 w-4" />
              History
            </button>
          </div>
        </div>

        {activeTab === "request" ? (
          <div className="space-y-5 p-5 sm:p-6">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">Simple workflow</p>
              <h2 className="mt-2 text-2xl font-black tracking-[-0.03em] text-[#17233E]">Request a 2-hour excuse</h2>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500">
                Choose the date and whether the excuse is morning or afternoon. The request goes directly to your manager for approval.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2">
                <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Date</span>
                <input
                  className="h-12 w-full rounded border border-slate-200 bg-slate-50 px-4 text-sm font-bold text-[#17233E] outline-none transition focus:border-orange-300 focus:bg-white focus:ring-4 focus:ring-orange-100"
                  onChange={(event) => setExcuseDate(event.target.value)}
                  type="date"
                  value={excuseDate}
                />
              </label>
              <label className="space-y-2">
                <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Excuse type</span>
                <select
                  className="h-12 w-full rounded border border-slate-200 bg-slate-50 px-4 text-sm font-bold text-[#17233E] outline-none transition focus:border-orange-300 focus:bg-white focus:ring-4 focus:ring-orange-100"
                  onChange={(event) => setExcuseType(event.target.value as "morning" | "afternoon")}
                  value={excuseType}
                >
                  <option value="morning">Morning excuse</option>
                  <option value="afternoon">Afternoon excuse</option>
                </select>
              </label>
            </div>

            {message ? (
              <div className={`rounded border px-4 py-3 text-sm font-bold ${message.kind === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
                {message.text}
              </div>
            ) : null}

            <button
              className="inline-flex h-12 items-center justify-center gap-2 rounded bg-[#F05A1A] px-5 text-sm font-black text-white shadow-[0_14px_28px_rgba(240,90,26,0.22)] transition hover:bg-[#d94f16] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
              disabled={submitDisabled}
              onClick={handleSubmit}
              type="button"
            >
              <Send className="h-4 w-4" />
              {isPending ? "Sending..." : "Submit request"}
            </button>

            {workspace.monthly.remaining <= 0 ? (
              <p className="text-xs font-semibold text-slate-500">
                Monthly limit reached for {currentMonthLabel}. Rejected requests do not count against the allowance.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="p-5 sm:p-6">
            <div className="space-y-3">
              {workspace.requests.length === 0 ? (
                <div className="rounded border border-dashed border-slate-200 bg-slate-50 p-8 text-center">
                  <CalendarClock className="mx-auto h-8 w-8 text-slate-400" />
                  <p className="mt-3 text-sm font-bold text-slate-600">No excuse requests yet.</p>
                </div>
              ) : (
                workspace.requests.map((request) => {
                  const Icon = statusIcon(request.status);
                  return (
                    <article
                      className="rounded border border-slate-200 bg-white p-4 shadow-[0_12px_30px_rgba(15,23,42,0.05)]"
                      key={request.id}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-sm font-black text-[#17233E]">{typeLabel(request.excuseType)}</p>
                          <p className="mt-1 text-xs font-semibold text-slate-500">
                            {request.excuseDate} · {request.durationHours} hours · Manager: {request.managerName ?? "Not assigned"}
                          </p>
                        </div>
                        <span className={`inline-flex w-fit items-center gap-1.5 rounded border px-3 py-1 text-[11px] font-black uppercase tracking-[0.08em] ${statusClass(request.status)}`}>
                          <Icon className="h-3.5 w-3.5" />
                          {request.status.replace("_", " ")}
                        </span>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </div>
        )}
      </section>

      <aside className="space-y-4">
        <div className="rounded border border-slate-950 bg-[linear-gradient(135deg,#0A1020,#17233E_60%,#2C1605)] p-5 text-white shadow-[0_22px_60px_rgba(15,23,42,0.18)]">
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-orange-200">{currentMonthLabel}</p>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <div className="rounded bg-white/10 p-3 ring-1 ring-white/10">
              <p className="text-2xl font-black">{workspace.monthly.used}</p>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-300">Used</p>
            </div>
            <div className="rounded bg-white/10 p-3 ring-1 ring-white/10">
              <p className="text-2xl font-black">{workspace.monthly.remaining}</p>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-300">Left</p>
            </div>
            <div className="rounded bg-white/10 p-3 ring-1 ring-white/10">
              <p className="text-2xl font-black">{workspace.monthly.allowance}</p>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-300">Limit</p>
            </div>
          </div>
        </div>

        <div className="rounded border border-white/80 bg-white/92 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70">
          <p className="text-[11px] font-black uppercase tracking-[0.16em] text-orange-600">Profile</p>
          <h3 className="mt-2 text-lg font-black text-[#17233E]">{workspace.employee.fullName}</h3>
          <div className="mt-4 space-y-2 text-sm text-slate-600">
            <p><span className="font-bold text-slate-900">HR ID:</span> {workspace.employee.hrId}</p>
            <p><span className="font-bold text-slate-900">Line:</span> {workspace.employee.lineName ?? "Head Office"}</p>
            <p><span className="font-bold text-slate-900">Manager:</span> {workspace.employee.managerName ?? "Not assigned"}</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
