"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

type TicketRow = { file: File | null; amount: string };

const emptyRow: TicketRow = { file: null, amount: "" };

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the selected file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Inline editor for adding one or more extra tickets (each with its own file +
 * cost) plus a shared reason to a single outstation request — e.g. an
 * unplanned multi-leg trip. Meant to be embedded directly inside that
 * request's own row/detail panel (not a separate list), so the caller
 * supplies the requestId and decides where/when it's shown.
 */
export function ExtraTicketRowEditor({
  requestId,
  onAdded,
}: {
  requestId: number;
  onAdded: () => void;
}) {
  const [rows, setRows] = useState<TicketRow[]>([{ ...emptyRow }]);
  const [destination, setDestination] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  function updateRow(index: number, patch: Partial<TicketRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((current) => [...current, { ...emptyRow }]);
  }

  function removeRow(index: number) {
    setRows((current) => (current.length <= 1 ? current : current.filter((_, i) => i !== index)));
  }

  async function submit() {
    const filled = rows.filter((row) => row.file);
    if (filled.length === 0) {
      setMessage({ text: "Attach at least one ticket file.", ok: false });
      return;
    }
    if (filled.some((row) => !(Number(row.amount) > 0))) {
      setMessage({ text: "Enter a cost (greater than zero) for every ticket.", ok: false });
      return;
    }
    if (!destination.trim()) {
      setMessage({ text: "Enter where the extra leg is going.", ok: false });
      return;
    }
    if (!reason.trim()) {
      setMessage({ text: "Add a short reason for the extra tickets.", ok: false });
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
        body: JSON.stringify({ destination, reason, tickets }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage({ text: payload.message ?? "Unable to add the tickets.", ok: false });
        return;
      }
      setRows([{ ...emptyRow }]);
      setDestination("");
      setReason("");
      setMessage({ text: `${tickets.length} ticket(s) added and the total was updated.`, ok: true });
      onAdded();
    } catch {
      setMessage({ text: "Unable to add the tickets.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-orange-100 bg-orange-50/40 p-3">
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <input
              accept="application/pdf,image/jpeg,image/png"
              className="min-w-0 flex-1 text-xs text-slate-700 file:mr-3 file:border-0 file:bg-orange-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-orange-700"
              onChange={(event) => updateRow(index, { file: event.target.files?.[0] ?? null })}
              type="file"
            />
            <input
              className={cn(phxFieldClassName, "w-28")}
              min="0"
              onChange={(event) => updateRow(index, { amount: event.target.value })}
              placeholder="EGP"
              type="number"
              value={row.amount}
            />
            <button
              aria-label="Remove ticket"
              className="border border-slate-200 bg-white p-2 text-slate-500 transition hover:bg-slate-50 disabled:opacity-40"
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

      <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-slate-600">
        Destination:
        <input
          className={phxFieldClassName}
          onChange={(event) => setDestination(event.target.value)}
          type="text"
          value={destination}
        />
      </label>

      <label className="mt-2 flex items-center gap-2 text-xs font-semibold text-slate-600">
        Note:
        <input
          className={phxFieldClassName}
          onChange={(event) => setReason(event.target.value)}
          type="text"
          value={reason}
        />
      </label>

      <div className="mt-3 flex items-center gap-3">
        <button
          className="inline-flex items-center gap-1 bg-orange-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-orange-600 disabled:opacity-60"
          disabled={busy}
          onClick={() => void submit()}
          type="button"
        >
          {busy ? "Adding…" : "Add tickets to this request"}
        </button>
        {message ? (
          <span className={`text-xs font-semibold ${message.ok ? "text-emerald-700" : "text-rose-700"}`}>
            {message.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
