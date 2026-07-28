"use client";

import { Plus, Ticket, Trash2 } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

import type { OwnTicketExpenseRequest } from "@/lib/outstation/service";

type TicketRow = { file: File | null; amount: string };

function formatEgp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatTripDate(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(
    date,
  );
}

function statusLabel(status: string) {
  const normalized = status.toLowerCase();
  if (normalized.startsWith("accepted")) return "Approved";
  if (normalized === "submitted") return "Pending review";
  return status;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the selected file."));
    reader.readAsDataURL(file);
  });
}

const emptyRow: TicketRow = { file: null, amount: "" };

/**
 * The employee's own train/bus requests, shown as rows. Each row opens inline so
 * the employee can add ONE OR MORE extra tickets (each with its own file + cost)
 * plus a reason directly on that request — e.g. an unplanned multi-leg trip. The
 * summed cost is added to that request's total; the allowance is never affected.
 */
export function ExtraTicketManager({ requests }: { requests: OwnTicketExpenseRequest[] }) {
  const router = useRouter();
  const [openId, setOpenId] = useState<number | null>(null);
  const [rows, setRows] = useState<TicketRow[]>([{ ...emptyRow }]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ id: number; text: string; ok: boolean } | null>(null);

  if (requests.length === 0) return null;

  function reset() {
    setRows([{ ...emptyRow }]);
    setReason("");
  }

  function toggle(id: number) {
    setMessage(null);
    setOpenId((current) => (current === id ? null : id));
    reset();
  }

  function updateRow(index: number, patch: Partial<TicketRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((current) => [...current, { ...emptyRow }]);
  }

  function removeRow(index: number) {
    setRows((current) => (current.length <= 1 ? current : current.filter((_, i) => i !== index)));
  }

  async function submit(requestId: number) {
    const filled = rows.filter((row) => row.file);
    if (filled.length === 0) {
      setMessage({ id: requestId, text: "Attach at least one ticket file.", ok: false });
      return;
    }
    if (filled.some((row) => !(Number(row.amount) > 0))) {
      setMessage({ id: requestId, text: "Enter a cost (greater than zero) for every ticket.", ok: false });
      return;
    }
    if (!reason.trim()) {
      setMessage({ id: requestId, text: "Add a short reason for the extra tickets.", ok: false });
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const tickets = await Promise.all(
        filled.map(async (row) => ({
          dataUrl: await fileToDataUrl(row.file as File),
          name: (row.file as File).name,
          amount: Number(row.amount),
        })),
      );
      const response = await fetch(`/api/outstation/${requestId}/extra-ticket`, {
        body: JSON.stringify({ tickets, reason }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ id: requestId, text: payload.message ?? "Unable to add the tickets.", ok: false });
        return;
      }
      setOpenId(null);
      reset();
      setMessage({
        id: requestId,
        text: `${tickets.length} ticket(s) added and the total was updated.`,
        ok: true,
      });
      router.refresh();
    } catch {
      setMessage({ id: requestId, text: "Unable to add the tickets.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
      <div className="flex items-center gap-2">
        <Ticket className="h-4 w-4 text-orange-600" />
        <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
          My train / bus requests
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-slate-500">
        Open a request to add extra tickets — e.g. an unplanned extra leg. Upload each ticket with
        its cost; the amounts are added to that request&apos;s total. Already-paid requests cannot
        be changed.
      </p>

      <div className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200">
        {requests.map((request) => {
          const isOpen = openId === request.id;
          const rowMessage = message?.id === request.id ? message : null;
          return (
            <div key={request.id} className="bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">{request.destination}</p>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">
                    {formatTripDate(request.tripStartDate)} – {formatTripDate(request.tripEndDate)} ·{" "}
                    {request.transportationType} · {statusLabel(request.status)} ·{" "}
                    {request.ticketCount} ticket{request.ticketCount === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-sm font-bold text-slate-900">{formatEgp(request.total)}</p>
                  <button
                    className="inline-flex items-center gap-1 rounded-md border border-orange-300 bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-700 transition hover:bg-orange-100"
                    onClick={() => toggle(request.id)}
                    type="button"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {isOpen ? "Close" : "Add tickets"}
                  </button>
                </div>
              </div>

              {isOpen ? (
                <div className="border-t border-orange-100 bg-orange-50/40 px-3 py-3 sm:px-4">
                  <div className="space-y-2">
                    {rows.map((row, index) => (
                      <div key={index} className="flex flex-wrap items-center gap-2">
                        <input
                          accept="application/pdf,image/jpeg,image/png"
                          className="min-w-0 flex-1 text-xs text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-orange-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-orange-700"
                          onChange={(event) => updateRow(index, { file: event.target.files?.[0] ?? null })}
                          type="file"
                        />
                        <input
                          className="h-9 w-28 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800"
                          min="0"
                          onChange={(event) => updateRow(index, { amount: event.target.value })}
                          placeholder="EGP"
                          type="number"
                          value={row.amount}
                        />
                        <button
                          aria-label="Remove ticket"
                          className="rounded-md border border-slate-200 bg-white p-2 text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"
                          disabled={rows.length <= 1}
                          onClick={() => removeRow(index)}
                          type="button"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-orange-700 hover:underline"
                    onClick={addRow}
                    type="button"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add another ticket
                  </button>

                  <input
                    className="mt-3 h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800"
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason — e.g. extra leg Assiut → Sohag and back"
                    type="text"
                    value={reason}
                  />

                  <div className="mt-3">
                    <button
                      className="inline-flex items-center gap-1 rounded-md bg-orange-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-orange-600 disabled:opacity-60"
                      disabled={busy}
                      onClick={() => void submit(request.id)}
                      type="button"
                    >
                      {busy ? "Adding…" : "Add tickets to this request"}
                    </button>
                  </div>
                </div>
              ) : null}

              {rowMessage ? (
                <p
                  className={`px-3 pb-3 text-xs font-semibold sm:px-4 ${
                    rowMessage.ok ? "text-emerald-700" : "text-rose-700"
                  }`}
                >
                  {rowMessage.text}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
