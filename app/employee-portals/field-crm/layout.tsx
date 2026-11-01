import { RetiredTouchTrailCleanup } from "@/components/phoenix-crm/retired-touch-trail-cleanup";

// This layout used to mount the Phoenix CRM touch trail once over the rep's whole subtree (owner,
// 2026-10-03). The trail was RETIRED on the owner's word on 1 November 2026 ("retire and delete all
// its traces"): it cost one request on every screen change and one every 30 s for every open tab, and
// its table had grown to 2.8 million rows and 1.2 GB — a quarter of the production database — while
// nothing read it.
//
// What is left is a one-release cleanup: the reps' phones still hold queued batches under the trail's
// localStorage key, and `RetiredTouchTrailCleanup` removes that key once, rendering nothing. Delete
// this layout, its admin twin and that component in the release after this one ships.
export default function FieldCrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <RetiredTouchTrailCleanup />
      {children}
    </>
  );
}
