import type { Metadata } from "next";

import { SharedTerritoryView } from "@/components/territory-management/shared-territory-view";
import { getBrowserKey } from "@/lib/google-maps/server";

export const dynamic = "force-dynamic";

// A published territory must never be indexed: a crawled copy would outlive the revoke switch and
// the expiry, and with no passcode on this link those two are the only controls there are.
export const metadata: Metadata = {
  title: "Territory Preview — Phoenix",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The public territory preview (owner request, 2026-08-14).
 *
 * Deliberately OUTSIDE the admin shell and outside any session check: the recipient has no Phoenix
 * account, no username and no passcode. The token is the whole credential, and it is verified
 * server-side by /api/share/territory/[token]/… — this page holds no geography until that succeeds.
 */
export default async function SharedTerritoryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <SharedTerritoryView browserKey={getBrowserKey() || null} token={token} />
      </div>
    </main>
  );
}
