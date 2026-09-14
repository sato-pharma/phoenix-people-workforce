"use client";

import { useState } from "react";

import { PharmacyValidationCapture } from "@/components/direct-orders/pharmacy-validation-capture";
import { directOrderInvoiceSlotLabel } from "@/lib/direct-orders/invoice-evidence";
import type { DirectOrderInvoiceSlots } from "@/lib/direct-orders/pharmacy-validation";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

const cairo = (iso: string) =>
  iso
    ? stableEnGbFormatter({ timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso))
    : "—";

/**
 * The rep's pharmacies standing on a distributor invoice — "2 of 5 pharmacies validated by invoice"
 * — and the way to free a slot: confirm one of them in the field with a live photo and location.
 *
 * Only a DECIDED invoice claim can be confirmed in the field. A pending one is still with the
 * reviewer, and a live photo filed beside it would be two claims about one pharmacy racing each
 * other on the desk.
 */
export function InvoiceValidatedPharmacies({ slots }: { slots: DirectOrderInvoiceSlots }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section className="border border-phx-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-phx-line bg-slate-900 px-4 py-2.5">
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Pharmacies validated by invoice</h3>
        <span className="text-phx-xs font-black text-orange-300">{directOrderInvoiceSlotLabel(slots)}</span>
      </header>
      <p className="border-b border-[#eef1f3] px-4 py-2 text-phx-sm font-medium text-slate-600">
        {slots.used >= slots.limit
          ? "All your invoice slots are in use. Confirm one of these pharmacies with a live photo and location to validate another pharmacy by invoice."
          : "Confirming one of these pharmacies with a live photo and location frees its slot."}
      </p>
      <ul className="divide-y divide-[#eef1f3]">
        {slots.pharmacies.map((pharmacy) => {
          const isOpen = openId === pharmacy.pharmacyId;
          const state =
            pharmacy.status === "pending"
              ? { tone: "bg-slate-100 text-slate-700", label: "Invoice waiting for review" }
              : pharmacy.fieldValidationPending
                ? { tone: "bg-sky-100 text-sky-800", label: "Live photo sent — waiting for review" }
                : { tone: "bg-emerald-100 text-emerald-800", label: "Confirmed on the invoice" };
          const canConfirmInField = pharmacy.status !== "pending" && !pharmacy.fieldValidationPending;
          return (
            <li key={pharmacy.validationId} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-black text-slate-900" dir="auto">{pharmacy.pharmacyName}</p>
                  <p className="text-phx-xs text-slate-500">Invoice sent {cairo(pharmacy.requestedAt)}</p>
                </div>
                <span className={`px-2 py-0.5 text-phx-xs font-black ${state.tone}`}>{state.label}</span>
              </div>
              {canConfirmInField ? (
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : pharmacy.pharmacyId)}
                  className={
                    isOpen
                      ? "mt-2 border border-slate-300 px-3 py-1.5 text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
                      : "mt-2 bg-orange-500 px-3 py-1.5 text-phx-sm font-black uppercase tracking-wider text-white hover:bg-orange-600"
                  }
                >
                  {isOpen ? "Close" : "Validate with a live photo and location"}
                </button>
              ) : null}
              {isOpen ? (
                <div className="mt-3">
                  <PharmacyValidationCapture
                    mode="upgrade"
                    pharmacyId={pharmacy.pharmacyId}
                    pharmacyName={pharmacy.pharmacyName}
                    requestId={null}
                    venueType={pharmacy.venueType}
                    onDone={() => setOpenId(null)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
