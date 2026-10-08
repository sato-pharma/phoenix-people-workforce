import type { Metadata } from "next";

import { JoiningFormPage, SatoNotice } from "@/components/offers/joining-form-page";
import { loadJoiningForm } from "@/lib/offers/joining-form-service";

export const dynamic = "force-dynamic";

// The link carries a person's pay and is the only credential there is — never indexed, never cached.
// 100% Sato Pharma (owner, 2026-10-08) — the tab and a saved home-screen entry too, not only the
// page, so the root layout's Phoenix icon and app title are overridden here.
export const metadata: Metadata = {
  title: "Joining Form — Sato Pharma",
  robots: { index: false, follow: false, nocache: true },
  icons: { apple: "/brand/sato-pharma-logo-on-light.png", icon: "/brand/sato-pharma-logo-on-light.svg" },
  appleWebApp: { title: "Sato Pharma" },
};

/**
 * The candidate's joining form (owner, 2026-10-08) — reached from the Accept button in the offer
 * email. Deliberately OUTSIDE every login group: the candidate has no Phoenix account. The signed
 * token names the offer, and the offer row is re-read on every open and on Submit, so a withdrawn,
 * declined or already-completed offer shows its own message instead of the form.
 *
 * Opening the page changes nothing — a mail scanner that follows the link creates no employee. Only
 * the Submit POST (/api/public/offer-acceptance/[token]) accepts the offer.
 */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await loadJoiningForm(token);

  if (view.kind === "open") return <JoiningFormPage token={token} view={view} />;

  const title = view.kind === "invalid" ? "This link is not valid" : view.title;
  const body =
    view.kind === "invalid"
      ? "The link may be incomplete or out of date. Please open it again from the offer email, or reply to that email and our HR team will help you."
      : view.body;

  return <SatoNotice body={body} title={title} />;
}
