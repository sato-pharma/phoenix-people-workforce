"use client";

import { BellRing } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  DeparturePhotoCard,
  type DeparturePhotoPendingRequest,
} from "@/components/outstation/departure-photo-card";
import { MissingTicketCard, type MissingTicketRequest } from "@/components/outstation/missing-ticket-card";

/**
 * What the employee must still do on claims already submitted — the first thing on Submit Expense
 * and the Expense Dashboard (owner, 2026-10-22: "in every step, show him what should he do in this
 * step and the next").
 *
 * WHY IT LEADS THE PAGE. Osama Mohamed El-said took his arrival photo in Assiut on Submit Expense,
 * and when the trip ended he came back to the same screen for the departure photo and found nothing
 * there: its card lived only on the Expense Dashboard and inside a collapsed row of Expense
 * Submissions. Whatever is owed now sits on top of the screen people actually return to.
 *
 * Data in, nothing else: the server page reads getOwnOutstationPendingActions and passes plain rows,
 * and a capture or an attach refreshes that page so a finished item leaves the list.
 */
export function OutstationPendingActions({
  departurePhotoDue,
  employeeHrId,
  missingTicket,
}: {
  departurePhotoDue: DeparturePhotoPendingRequest[];
  employeeHrId: string;
  missingTicket: MissingTicketRequest[];
}) {
  const router = useRouter();
  const count = departurePhotoDue.length + missingTicket.length;
  if (count === 0) return null;

  return (
    <section aria-label="Needs you now" className="grid gap-3">
      <div className="flex items-start gap-2 border-l-2 border-orange-500 bg-white px-3 py-2">
        <BellRing aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
        <div className="min-w-0">
          <p className="text-sm font-black text-slate-900">
            Needs you now · {count === 1 ? "1 item" : `${count} items`}
          </p>
          <p className="mt-0.5 text-phx-md leading-relaxed text-slate-600">
            Finish these on claims you already submitted. Each one holds its claim back until it is done.
          </p>
        </div>
      </div>
      <DeparturePhotoCard
        employeeHrId={employeeHrId}
        onCaptured={() => router.refresh()}
        requests={departurePhotoDue}
      />
      <MissingTicketCard requests={missingTicket} />
    </section>
  );
}
