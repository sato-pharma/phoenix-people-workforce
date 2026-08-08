import type { DirectOrderEvidenceCheck } from "@/lib/direct-orders/evidence-check";

/**
 * What the storefront photo was read to say (spec E2).
 *
 * Three deliberate rules:
 *
 * 1. UNKNOWN IS NOT A PASS. A null check, or a null `isPharmacy` inside it, renders as "could not
 *    read" in plain grey. Saying nothing would be read as "nothing wrong" — the same mistake the
 *    GPS chip avoids by printing "distance unknown" rather than staying blank.
 *
 * 2. IT NEVER DECIDES. It sits beside the photo, not near any decision buttons. A photographed
 *    pharmacy in Egypt may have a handwritten sign, an Arabic-only sign, or one behind a parked
 *    truck; a human weighs it, the software does not.
 *
 * 3. IT IS NEVER ANNOUNCED (spec D4). "The sign reads …" — no model name, no "AI", and the stored
 *    similarity number is deliberately not rendered, because a percentage invites people to treat
 *    a reading as a score.
 *
 * Shell-agnostic on purpose (no outer Card/border of its own) — it drops unchanged into the
 * Validation Desk, the admin approval detail panel, and the portal detail panel alike.
 */
export function EvidenceReading({
  check,
  claimedName,
}: {
  check: DirectOrderEvidenceCheck | null;
  claimedName: string;
}) {
  if (!check) {
    return (
      <p className="mt-2 border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-500">
        The photo has not been read. Judge it yourself.
      </p>
    );
  }

  const tone =
    check.isPharmacy === false
      ? "border-rose-200 bg-rose-50 text-rose-800"
      : check.isPharmacy === true && check.signMatchesClaim === false
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : check.isPharmacy === true
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-slate-200 bg-slate-50 text-slate-500";

  const headline =
    check.isPharmacy === false
      ? "This does not look like a pharmacy."
      : check.isPharmacy === true
        ? "This looks like a pharmacy."
        : "Could not tell whether this is a pharmacy.";

  return (
    <div className={`mt-2 space-y-0.5 border px-3 py-2 text-[12px] ${tone}`}>
      <p className="font-black">{headline}</p>
      {check.signText ? (
        <p dir="auto">
          The sign reads <span className="font-bold">{check.signText}</span>
          {check.signMatchesClaim === false ? (
            <span className="font-bold">, which is not “{claimedName}”.</span>
          ) : check.signMatchesClaim === true ? (
            <span> — the name they claimed.</span>
          ) : null}
        </p>
      ) : (
        <p>Could not read the sign.</p>
      )}
      {check.note ? <p className="opacity-80">{check.note}</p> : null}
    </div>
  );
}
