import type { ValidationBadge } from "@/lib/validation/validation-badge";

/**
 * The "this venue is ALREADY validated" stamp + jump, shared by the two approver windows — the
 * direct-order pharmacy approver (`direct-order-request-detail.tsx`) and the marketing-request
 * customer approver (`marketing-request-approver-detail.tsx`).
 *
 * Owner ask (2026-09-22): when an approver opens an order/request whose pharmacy/customer is already
 * validated, tell them so — with WHO validated it and WHEN — and give them a jump to the full
 * validation evidence (photos, address, codes) that already sits lower on the same window.
 *
 * A plain anchor, not a router Link, on purpose: the same component renders inside the admin shell
 * AND the employee portal, and `href` may be either an in-page `#anchor` (the direct-order window,
 * whose full evidence already sits lower on the same screen) or a full URL to the standalone
 * customer dossier page (the marketing window). A plain `<a>` serves both without a router.
 */
export type ValidatedEvidenceLinkProps = {
  badge: ValidationBadge;
  /**
   * Where the jump goes: an in-page `#anchor` to evidence on the same window (direct orders), or a
   * URL to the full validation dossier page (marketing).
   */
  href: string;
  /** What kind of venue this is, for the accessible label ("pharmacy" | "customer"). */
  venueNoun?: string;
};

const cairoStamp = (iso: string | null): string | null =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : null;

export function ValidatedEvidenceLink({ badge, href, venueNoun = "venue" }: ValidatedEvidenceLinkProps) {
  const when = cairoStamp(badge.atIso);
  // Who and when — never inventing a reviewer the system did not have.
  const who = badge.isHuman
    ? badge.byName
      ? `by ${badge.byName}`
      : "by a reviewer"
    : `by the system${badge.method ? ` (${badge.method})` : ""}`;

  return (
    <a
      href={href}
      className="group flex flex-wrap items-center gap-x-2 gap-y-1 border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-900 transition-colors hover:bg-emerald-100"
    >
      <span className="inline-flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-emerald-700">
        <span aria-hidden className="inline-block h-1.5 w-1.5 bg-emerald-500" />
        Validated
      </span>
      <span className="text-phx-sm font-semibold" dir="auto">
        {who}
        {when ? <span className="font-normal text-emerald-700"> · {when}</span> : null}
        {badge.isHuman && badge.method ? (
          <span className="font-normal text-emerald-700"> · {badge.method}</span>
        ) : null}
      </span>
      <span
        aria-hidden
        className="ml-auto text-base font-black text-emerald-700 transition-transform group-hover:translate-x-0.5"
      >
        →
      </span>
      <span className="sr-only">Jump to the validation evidence for this {venueNoun}</span>
    </a>
  );
}
