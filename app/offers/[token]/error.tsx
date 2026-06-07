"use client";

// Candidate-facing error boundary for the public offer links
// (/offers/[token]/{accept,reject,negotiate,details}). Without this, an
// unexpected throw (e.g. a transient DB error in getOfferDecisionPreview)
// falls through to the root app/error.tsx, which shows an internal
// "This workspace view stopped unexpectedly" message to an external job
// candidate. The expected expired/invalid-token case is already handled
// gracefully by the returned preview (offer: null + message); this boundary
// only covers genuine failures. Raw error text is intentionally not shown.

export default function OfferLinkError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen bg-[#F8FAFC] px-4 py-10 text-slate-950">
      <section className="mx-auto max-w-xl">
        <div className="rounded-lg bg-[#0F172A] px-6 py-7 text-white shadow-[0_18px_50px_rgba(15,23,42,0.14)] sm:px-8">
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-orange-300">
            Phoenix Workforce
          </p>
          <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl">
            We couldn&apos;t load this offer
          </h1>
          <p className="mt-3 text-sm leading-6 text-white/70">
            Something went wrong while opening your offer link. This is usually
            temporary — please try again in a moment.
          </p>
        </div>

        <div className="space-y-4 py-6">
          <p className="text-sm leading-6 text-slate-600">
            If the problem continues, your link may have expired. Please reply to
            the HR team member who shared it with you, or reach us at the address
            below and we&apos;ll send a fresh link.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => reset()}
              className="rounded-lg bg-orange-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-orange-700"
            >
              Try again
            </button>
            <a
              href="mailto:hr@satopharma.com"
              className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-800 transition hover:bg-slate-50"
            >
              Contact HR
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
