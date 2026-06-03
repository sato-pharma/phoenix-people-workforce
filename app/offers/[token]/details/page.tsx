import Link from "next/link";
import { Mail, MessageCircle } from "lucide-react";

import { getOfferDecisionPreview } from "@/lib/offers/service";

export const dynamic = "force-dynamic";
export const metadata = {
  robots: {
    follow: false,
    index: false,
  },
};

function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "To be confirmed";
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number(value));
}

function dateText(value: string | null | undefined) {
  if (!value) return "To be confirmed";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

export default async function OfferDetailsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const preview = await getOfferDecisionPreview(token);
  const offer = preview.offer;
  const hrEmail = process.env.JOB_OFFER_HR_CONTACT_EMAIL || process.env.HR_REPLY_EMAIL_FROM || "hr@satopharma.com";
  const whatsapp = process.env.JOB_OFFER_HR_WHATSAPP || "";

  return (
    <main className="min-h-screen bg-[#F8FAFC] px-4 py-10 text-slate-950">
      <section className="mx-auto max-w-3xl">
        <div className="rounded-lg bg-[#0F172A] px-6 py-7 text-white shadow-[0_18px_50px_rgba(15,23,42,0.14)] sm:px-8">
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-orange-300">Phoenix Workforce</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">Offer Details</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-white/70">
            Thank you for taking the time to review this opportunity. Please read the details carefully, then choose your response from this secure page.
          </p>
        </div>

        <div className="space-y-6 py-6 sm:py-8">
          {!offer ? (
            <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm font-semibold text-orange-900">
              {preview.message}
            </div>
          ) : (
            <>
              <div>
                <h2 className="text-2xl font-black">{offer.jobTitle}</h2>
                <p className="mt-1 text-sm text-slate-600">{offer.candidateName}</p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Position", offer.jobTitle],
                  ["Area", offer.areaScope ?? "To be assigned"],
                  ["Hiring date", dateText(offer.startDate)],
                  ["Base salary", money(offer.baseSalary)],
                  ["Basic salary", money(offer.basicSalary)],
                  ["Net salary", money(offer.netSalary ?? offer.salaryAmount)],
                ].map(([label, value]) => (
                  <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" key={label}>
                    <div className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</div>
                    <div className="mt-2 text-sm font-bold text-slate-950">{value}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">
                We would be pleased to welcome you to Sato Pharmaceuticals. This role is part of an active hiring plan, and HR will support you through the next onboarding steps after acceptance.
              </div>

              <div className="flex flex-wrap gap-3">
                {preview.canSubmit ? (
                  <>
                    <Link className="rounded-lg bg-emerald-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-emerald-700" href={`/offers/${token}/accept`}>
                      Accept Offer
                    </Link>
                    <Link className="rounded-lg bg-orange-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-orange-700" href={`/offers/${token}/reject`}>
                      Reject Offer
                    </Link>
                  </>
                ) : (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
                    {preview.message}
                  </div>
                )}
                <a className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-800 transition hover:bg-slate-50" href={`mailto:${hrEmail}`}>
                  <Mail className="h-4 w-4" />
                  Contact HR
                </a>
                {whatsapp ? (
                  <a className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-800 transition hover:bg-slate-50" href={`https://wa.me/${whatsapp}`} rel="noreferrer" target="_blank">
                    <MessageCircle className="h-4 w-4" />
                    WhatsApp HR
                  </a>
                ) : null}
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
