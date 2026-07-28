"use client";

import { Plus, Ticket } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

import type { OwnTicketExpenseRequest } from "@/lib/outstation/service";

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

/**
 * Lets an employee add ONE extra ticket (attachment + cost + reason) to their
 * own already-submitted train/bus request — e.g. an unplanned extra leg. The
 * cost is added to the request total; the allowance is never affected.
 */
export function ExtraTicketManager({ requests }: { requests: OwnTicketExpenseRequest[] }) {
  const router = useRouter();
  const [openId, setOpenId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ id: number; text: string; ok: boolean } | null>(null);

  if (requests.length === 0) return null;

  function resetForm() {
    setFile(null);
    setAmount("");
    setReason("");
  }

  function toggle(id: number) {
    setMessage(null);
    if (openId === id) {
      setOpenId(null);
      resetForm();
    } else {
      setOpenId(id);
      resetForm();
    }
  }

  async function submit(requestId: number) {
    if (!file) {
      setMessage({ id: requestId, text: "Select the ticket file to upload.", ok: false });
      return;
    }
    if (!(Number(amount) > 0)) {
      setMessage({ id: requestId, text: "Enter the ticket cost (greater than zero).", ok: false });
      return;
    }
    if (!reason.trim()) {
      setMessage({ id: requestId, text: "Add a short reason for the extra ticket.", ok: false });
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      const response = await fetch(`/api/outstation/${requestId}/extra-ticket`, {
        body: JSON.stringify({ dataUrl, name: file.name, amount: Number(amount), reason }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ id: requestId, text: payload.message ?? "Unable to add the ticket.", ok: false });
        return;
      }
      setOpenId(null);
      resetForm();
      setMessage({ id: requestId, text: "Extra ticket added and the total was updated.", ok: true });
      router.refresh();
    } catch {
      setMessage({ id: requestId, text: "Unable to add the ticket.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
      <div className="flex items-center gap-2">
        <Ticket className="h-4 w-4 text-orange-600" />
        <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
          Train / bus tickets
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-slate-500">
        Add an extra ticket to a train or bus request — for example an unplanned extra leg. The
        ticket cost is added to the request total. Already-paid requests cannot be changed.
      </p>

      <div className="mt-4 space-y-3">
        {requests.map((request) => {
          const isOpen = openId === request.id;
          const rowMessage = message?.id === request.id ? message : null;
          return (
            <div key={request.id} className="rounded-md border border-slate-200 bg-white p-3 sm:p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
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
                    {isOpen ? "Close" : "Extra ticket"}
                  </button>
                </div>
              </div>

              {isOpen ? (
                <div className="mt-3 grid gap-3 rounded-md border border-orange-100 bg-orange-50/40 p-3 sm:grid-cols-2">
                  <label className="block text-xs font-semibold text-slate-600">
                    Ticket file (PDF, JPG, PNG)
                    <input
                      accept="application/pdf,image/jpeg,image/png"
                      className="mt-1 block w-full text-xs text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-orange-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-orange-700"
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                      type="file"
                    />
                  </label>
                  <label className="block text-xs font-semibold text-slate-600">
                    Ticket cost (EGP)
                    <input
                      className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800"
                      min="0"
                      onChange={(event) => setAmount(event.target.value)}
                      placeholder="EGP"
                      type="number"
                      value={amount}
                    />
                  </label>
                  <label className="block text-xs font-semibold text-slate-600 sm:col-span-2">
                    Reason
                    <input
                      className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800"
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="e.g. extra leg Assiut → Sohag and back"
                      type="text"
                      value={reason}
                    />
                  </label>
                  <div className="sm:col-span-2">
                    <button
                      className="inline-flex items-center gap-1 rounded-md bg-orange-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-orange-600 disabled:opacity-60"
                      disabled={busy}
                      onClick={() => void submit(request.id)}
                      type="button"
                    >
                      {busy ? "Adding…" : "Add ticket to this request"}
                    </button>
                  </div>
                </div>
              ) : null}

              {rowMessage ? (
                <p
                  className={`mt-2 text-xs font-semibold ${
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
