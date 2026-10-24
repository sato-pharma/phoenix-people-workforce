import { Suspense } from "react";

import { DoubleVisitFocusSection } from "@/components/employee-portal/dashboards/double-visit-focus-section";
import { MmSectionSkeleton } from "@/components/employee-portal/dashboards/mm-intel-sections";
import type { DoubleVisitPortalFocus } from "@/lib/double-visit-analytics/types";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";

/**
 * The double-visit focus — trend, scope coverage, probation watchlist — as ONE promise, whether the
 * snapshot streamed it or not.
 *
 * The landing page asks for `streamDvFocus`, so for a District, Regional or National Sales Manager,
 * a Product Manager and a Group Product Manager it arrives on `snapshot.dvFocusCard` STILL RUNNING:
 * it walks every double visit in the company since the trend's first month, and the identity band,
 * pending actions and every section above it paint without waiting for that walk. Every other caller
 * hands over a whole snapshot, and this resolves at once to `snapshot.dvFocus`. The read never
 * rejects, so the boundary needs no error fallback.
 */
export function dvFocusOf(snapshot: PortalHomeSnapshot): Promise<DoubleVisitPortalFocus | null> {
  if (snapshot.dvFocusCard) return snapshot.dvFocusCard;
  return Promise.resolve(snapshot.dvFocus);
}

async function AwaitDoubleVisitFocus({ focus }: { focus: Promise<DoubleVisitPortalFocus | null> }) {
  return <DoubleVisitFocusSection focus={await focus} />;
}

/** The double-visit focus under its own Suspense, with a visible loading panel while it runs. */
export function StreamedDoubleVisitFocus({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  return (
    <Suspense fallback={<MmSectionSkeleton title="Your Double-Visit Trend" />}>
      <AwaitDoubleVisitFocus focus={dvFocusOf(snapshot)} />
    </Suspense>
  );
}
