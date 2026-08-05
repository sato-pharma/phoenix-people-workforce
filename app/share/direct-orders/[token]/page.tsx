import type { Metadata } from "next";

import { SharedDirectOrderReport } from "@/components/direct-orders/shared-report-view";

export const dynamic = "force-dynamic";

// A published report must never be indexed: a crawled copy would outlive the revoke switch,
// which would defeat the point of having one.
export const metadata: Metadata = {
  title: "Direct Orders — Phoenix",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The public live report (owner request, 2026-08-05).
 *
 * Deliberately OUTSIDE the admin shell and outside any session check: the recipient has no
 * Phoenix account. The passcode is the gate, and it is verified server-side by
 * /api/share/direct-orders/[token]/live — this page holds no data until that call succeeds.
 */
export default async function SharedDirectOrderReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <SharedDirectOrderReport token={token} />
      </div>
    </main>
  );
}
