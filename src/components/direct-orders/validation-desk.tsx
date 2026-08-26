"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { PharmacyComboBox, type PharmacySearchHit } from "@/components/direct-orders/pharmacy-combo-box";
import { EvidenceReading } from "@/components/direct-orders/evidence-reading";
import type { DirectOrderValidationRow } from "@/lib/direct-orders/pharmacy-validation";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { PharmacyLicenseEvidence } from "@/components/venues/pharmacy-license-evidence";

type Props = { rows: DirectOrderValidationRow[] };

const cairo = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : "—";

/**
 * The Super Admin validation desk (spec A2 — docs/specs/direct-orders-v2.md).
 *
 * Every claim arrives with its own evidence: the live storefront photo, the pin, and how far that
 * pin sits from the requester's own area. The admin's first move is deliberately MATCH, not
 * approve — most "new" pharmacies are real ones spelled differently, and matching resolves the
 * order without minting a second identity for the same shop. Approving as new is the exception,
 * and it costs the pharmacy a 90-day probation.
 */
export function ValidationDesk({ rows }: Props) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [match, setMatch] = useState<Record<string, PharmacySearchHit | null>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Three-valued per row: undefined = the admin has not touched the control, so nothing is claimed
  // about the licence. Never initialised to false — that would record "the names do not match" for
  // every claim decided without looking, which is a statement nobody made.
  const [licenseVerdict, setLicenseVerdict] = useState<Record<string, boolean | undefined>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function decide(row: DirectOrderValidationRow, decision: "approve" | "match" | "reject") {
    setError(null);
    setOk(null);
    const picked = match[row.id] ?? null;
    if (decision === "match" && (!picked || !picked.distributorCode || !picked.customerCode)) {
      setError("Search and pick the real customer this pharmacy matches.");
      return;
    }
    setBusy(row.id);
    try {
      const res = await fetch(`/api/direct-orders/pharmacy-validations/${encodeURIComponent(row.id)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          notes: notes[row.id]?.trim() || null,
          matchDistributorCode: decision === "match" ? picked?.distributorCode : null,
          matchCustomerCode: decision === "match" ? picked?.customerCode : null,
          licenseNameMatchesSign: licenseVerdict[row.id] ?? null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not record the decision.");
      setOk(
        decision === "match"
          ? "Matched to the existing customer. The pharmacy is trusted and its held orders are moving."
          : decision === "approve"
            ? "Approved as new. The pharmacy is on 90-day probation and its held orders are moving."
            : "Rejected. The order stays held.",
      );
      setOpenId(null);
      router.refresh();
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return (
      <section className="border border-[#e4e9ec] bg-white px-4 py-8 text-center">
        <p className="text-sm font-bold text-slate-600">No pharmacy validations waiting.</p>
        <p className="mt-1 text-[12px] text-slate-400">Every submitted order is on a pharmacy the master database recognises.</p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      {error ? <p className="border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700">{error}</p> : null}
      {ok ? <p className="border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700">{ok}</p> : null}

      {rows.map((row) => {
        const isOpen = openId === row.id;
        // An unknown distance must read as unknown — never as "inside".
        const proximity =
          row.areaDistanceKm == null
            ? { tone: "bg-slate-100 text-slate-600", label: "distance unknown" }
            : row.gpsInsideRequesterArea
              ? { tone: "bg-emerald-100 text-emerald-800", label: `${row.areaDistanceKm} km from their area` }
              : { tone: "bg-rose-100 text-rose-800", label: `${row.areaDistanceKm} km from their area` };

        return (
          <div key={row.id} className="border border-[#e4e9ec] bg-white">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e4e9ec] bg-slate-50 px-4 py-2.5">
              <div>
                <p className="text-sm font-black text-slate-900" dir="auto">
                  {row.claimedPharmacyName}
                  <span className="ml-2 text-[11px] font-normal text-slate-500">{row.phoenixPharmacyCode}</span>
                </p>
                <p className="text-[11px] text-slate-500">
                  {row.requestedByName} · {cairo(row.requestedAt)}
                </p>
              </div>
              <span className={`px-2 py-0.5 text-[11px] font-black ${proximity.tone}`}>{proximity.label}</span>
            </header>

            <div className="grid grid-cols-1 gap-4 px-4 py-3 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
              <div>
                {row.photoUrl ? (
                  <ZoomablePhoto
                    alt="Storefront evidence"
                    caption={`Storefront evidence · ${row.claimedPharmacyName}`}
                    className="w-full border border-slate-200"
                    src={row.photoUrl}
                  />
                ) : (
                  <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-800">
                    No photo on file for this claim.
                  </p>
                )}
                {/* What the photo was read to say (spec E2), directly under it.
                    ADVISORY ONLY — it sits beside the evidence, never on the decision buttons, and
                    an absent or unreadable answer says so rather than staying quiet. Silence here
                    would be read as "nothing wrong", which is the one thing it must never mean. */}
                <EvidenceReading check={row.evidenceCheck} claimedName={row.claimedPharmacyName} />
                {row.capturedLatitude != null ? (
                  <a
                    className="mt-1 block text-[11px] font-bold text-orange-600 underline"
                    href={`https://www.google.com/maps?q=${row.capturedLatitude},${row.capturedLongitude}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open the pin on the map
                  </a>
                ) : null}

                {/* The pharmacy licence, directly under the storefront photo it is meant to be read
                    against. The two sit together on purpose: the whole check is one name in two
                    places, and putting the licence in a separate panel would mean scrolling between
                    the two halves of a single comparison. */}
                <div className="mt-2 border border-[#eef1f3] p-2">
                  {row.licenseUrl ? (
                    <>
                      {/* Shared with the two approval screens, so the PDF-versus-image decision is
                          made in exactly one place. A licence that renders as a broken image on one
                          screen reads as "no licence" to whoever is looking at that screen. */}
                      <PharmacyLicenseEvidence
                        contentType={row.licenseContentType}
                        label={row.claimedPharmacyName}
                        url={row.licenseUrl}
                      />
                      {/* The other half of the comparison, spelled out beside the document rather
                          than left for the reviewer to find further up the row. */}
                      <p className="mt-1 text-[11px] font-semibold text-slate-600" dir="auto">
                        Claimed name: {row.claimedPharmacyName}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                        Pharmacy licence · رخصة الصيدلية
                      </p>
                      {/* What is missing depends on WHY. A pharmacy with a distributor code already
                          has its identity vouched for by that distributor, so an absent licence is
                          unremarkable. A codeless one has nothing else at all, and that is worth
                          saying in colour. */}
                      <p
                        className={`mt-1 px-2 py-1.5 text-[12px] font-semibold ${
                          row.hasDistributorCode
                            ? "text-slate-500"
                            : "border border-amber-200 bg-amber-50 text-amber-900"
                        }`}
                      >
                        {row.hasDistributorCode
                          ? "No licence attached. This pharmacy carries a distributor code, so its identity is already vouched for."
                          : "No licence attached, and no distributor code in any distributor — nothing outside this claim confirms the pharmacy's trade name."}
                      </p>
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-2 text-[12px]">
                <p><span className="font-black uppercase tracking-wider text-slate-400">Reason: </span><span dir="auto">{row.claimedReason ?? "—"}</span></p>
                <p><span className="font-black uppercase tracking-wider text-slate-400">Address: </span><span dir="auto">{row.claimedAddress ?? "—"}</span></p>
                <p><span className="font-black uppercase tracking-wider text-slate-400">Doctor: </span><span dir="auto">{row.claimedDoctorName ?? "—"}</span></p>
                <p><span className="font-black uppercase tracking-wider text-slate-400">Their area: </span>{row.requesterAreaCode ?? "—"}</p>
                <p><span className="font-black uppercase tracking-wider text-slate-400">Photo taken: </span>{cairo(row.capturedAt)}</p>

                {isOpen ? (
                  <div className="space-y-2 border-t border-[#eef1f3] pt-2">
                    <div>
                      <label className="block text-[11px] font-black uppercase tracking-wider text-slate-500">
                        Is it already in the database? Search and pick it
                      </label>
                      {match[row.id] ? (
                        <div className="mt-1 flex items-center justify-between gap-2 border border-emerald-300 bg-emerald-50 px-2 py-1.5">
                          <span className="text-[12px] font-bold text-slate-800" dir="auto">
                            {match[row.id]?.customerName ?? match[row.id]?.customerCode}
                            <span className="ml-1 font-normal text-slate-500">
                              {match[row.id]?.distributorCode} · {match[row.id]?.customerCode}
                            </span>
                          </span>
                          <button type="button" className="text-[11px] font-bold text-orange-600" onClick={() => setMatch((p) => ({ ...p, [row.id]: null }))}>
                            Change
                          </button>
                        </div>
                      ) : (
                        <PharmacyComboBox
                          inputClassName="mt-1 w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
                          onSelect={(hit) => setMatch((p) => ({ ...p, [row.id]: hit }))}
                        />
                      )}
                    </div>
                    {/* Recorded, never required. Leaving it alone stores null — "nobody was asked"
                        — rather than a verdict, and no decision is blocked either way (the system
                        flags, it never rejects). Only offered when there IS a licence to judge. */}
                    {row.licenseUrl ? (
                      <div className="border border-[#eef1f3] px-2 py-1.5">
                        <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                          Does the licence trade name match the shop sign?
                        </p>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {([
                            { label: "Yes, it matches", tone: "emerald", value: true },
                            { label: "No, it differs", tone: "rose", value: false },
                          ] as const).map((choice) => {
                            const active = licenseVerdict[row.id] === choice.value;
                            return (
                              <button
                                key={choice.label}
                                type="button"
                                onClick={() =>
                                  setLicenseVerdict((p) => ({
                                    ...p,
                                    // Clicking the active choice clears it back to "not answered",
                                    // so a mis-click is undoable without reloading the desk.
                                    [row.id]: active ? undefined : choice.value,
                                  }))
                                }
                                className={
                                  active
                                    ? `border px-3 py-1 text-[12px] font-black ${
                                        choice.tone === "emerald"
                                          ? "border-emerald-400 bg-emerald-50 text-emerald-800"
                                          : "border-rose-400 bg-rose-50 text-rose-800"
                                      }`
                                    : "border border-slate-300 px-3 py-1 text-[12px] font-bold text-slate-600 hover:bg-slate-50"
                                }
                              >
                                {choice.label}
                              </button>
                            );
                          })}
                          <span className="self-center text-[11px] font-medium text-slate-400">
                            {licenseVerdict[row.id] === undefined ? "Not answered — optional" : "Recorded with your decision"}
                          </span>
                        </div>
                      </div>
                    ) : null}
                    <textarea
                      className="w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
                      rows={2}
                      placeholder="Notes (optional)"
                      value={notes[row.id] ?? ""}
                      onChange={(e) => setNotes((p) => ({ ...p, [row.id]: e.target.value }))}
                      dir="auto"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={busy === row.id} onClick={() => decide(row, "match")} className="bg-emerald-600 px-3 py-1.5 text-[12px] font-black uppercase tracking-wider text-white hover:bg-emerald-700 disabled:bg-slate-300">
                        Match to this customer
                      </button>
                      <button type="button" disabled={busy === row.id} onClick={() => decide(row, "approve")} className="bg-slate-900 px-3 py-1.5 text-[12px] font-black uppercase tracking-wider text-white hover:bg-slate-800 disabled:bg-slate-300">
                        Approve as new (90-day probation)
                      </button>
                      <button type="button" disabled={busy === row.id} onClick={() => decide(row, "reject")} className="border border-rose-300 px-3 py-1.5 text-[12px] font-black uppercase tracking-wider text-rose-700 hover:bg-rose-50 disabled:opacity-50">
                        Reject
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="mt-1 bg-orange-500 px-3 py-1.5 text-[12px] font-black uppercase tracking-wider text-white hover:bg-orange-600" onClick={() => setOpenId(row.id)}>
                    Review
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
