"use client";

/**
 * Phoenix CRM — the rep's half of the Super Admin's photo validation (owner, 2026-11-20): "while this button is
 * on, the rep will capture the location. You will capture his location and put it here."
 *
 * On the List, under the chooser, only while the Super Admin's watch is on for a customer of this territory: the
 * customer's name and the Capture location button, the same one a validation at the door uses. The reading is
 * sent the moment it is taken; "Capture again" replaces it.
 *
 * 🔴 GOLDEN RULE #1 — the rep reads "capture the location of this customer" and nothing else: no watch, no
 * time left, no accuracy, no distance, no name of who asked. The server sends him no more than that
 * (`AdminPhotoRepAsk`). It reads again whenever the page comes back to the front, because the rep opens Phoenix
 * after the Super Admin phones him; it never asks on a timer, so a list left open costs nothing.
 */

import { useEffect, useState } from "react";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { CaptureLocation, type CapturedPin } from "@/components/phoenix-crm/capture-location";
import { CrmBlock, CrmNote } from "@/components/phoenix-crm/ui";
import type { AdminPhotoRepAsk } from "@/lib/phoenix-crm/view-types";

const ASK_URL = "/api/phoenix-crm/list/places/admin-photo/ask";

export function AdminPhotoAskCard({ seatId, test }: { seatId: string; test: boolean }) {
  const resource = useCrmGet<AdminPhotoRepAsk[]>(crmUrl(ASK_URL, { seatId, test }), "asks");
  const { reload, replace } = resource;
  const [pins, setPins] = useState<Record<string, CapturedPin | null>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ askId: string; message: string } | null>(null);

  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [reload]);

  const asks = resource.data ?? [];
  if (asks.length === 0) return null;

  async function send(ask: AdminPhotoRepAsk, pin: CapturedPin | null) {
    setPins((current) => ({ ...current, [ask.askId]: pin }));
    if (!pin) return;
    setSending(ask.askId);
    setProblem(null);
    try {
      replace(
        await crmPost<AdminPhotoRepAsk[]>(
          ASK_URL,
          { askId: ask.askId, seatId, test, lat: pin.lat, lon: pin.lon, accuracyMeters: pin.accuracyMeters, capturedAt: pin.capturedAt },
          "asks",
        ),
      );
    } catch (error) {
      setPins((current) => ({ ...current, [ask.askId]: null }));
      setProblem({ askId: ask.askId, message: messageOf(error) });
      reload();
    } finally {
      setSending(null);
    }
  }

  return (
    <CrmBlock className="border-t border-slate-100" title="Capture a location">
      <div className="grid min-w-0 gap-3">
        {asks.map((ask) => (
          <div className="grid min-w-0 gap-2 border border-slate-200 bg-white p-3" key={ask.askId}>
            <p className="break-words text-base font-black text-slate-950" dir="auto">
              {ask.customerName || "Customer"}
            </p>
            {ask.sent ? (
              <CrmNote tone="good">Location sent. Thank you.</CrmNote>
            ) : null}
            <CaptureLocation
              disabled={sending === ask.askId}
              onChange={(pin) => void send(ask, pin)}
              value={ask.sent ? (pins[ask.askId] ?? null) : null}
            />
            {problem?.askId === ask.askId ? <CrmNote tone="bad">{problem.message}</CrmNote> : null}
          </div>
        ))}
      </div>
    </CrmBlock>
  );
}
