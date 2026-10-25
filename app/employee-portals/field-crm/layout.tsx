import { PhoenixCrmTouchTrail } from "@/components/phoenix-crm/touch-trail-collector";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

// This layout exists for ONE reason: to mount the Phoenix CRM touch trail once over the rep's whole
// subtree (owner, 2026-10-03: "every click or every touch on the touch screen for this module to be
// saved in a separate audit trail … anything touches him, automatically saved").
//
// 🔴 IT RENDERS NOTHING AND CHANGES NOTHING. `PhoenixCrmTouchTrail` returns null, adds no step to the
// rep's day and draws nothing on his screen — golden rule #1 holds exactly as it did before this file
// existed. The portal's own shell, title and chrome are the parent layout's and are untouched.
//
// Mounted HERE rather than in a page so it survives every in-module navigation: one page load keeps
// one session id and one clock, which is what lets a reader replay a rep's half-hour in order.
// Deleting this file turns the trail off for the rep's app and breaks nothing else.
//
// `test` is not passed: the session decides it server-side (`access.testPersona`), so a browser can
// never clear the flag by claiming it is real.
//
// `viewerHrId` is whose taps a held batch is (owner-scoped.ts): the access read is React-cached, so
// a page below that reads it too reuses the same answer rather than adding a second read.
export default async function FieldCrmLayout({ children }: { children: React.ReactNode }) {
  const access = await resolveAccessContextFromPage();
  return (
    <>
      <PhoenixCrmTouchTrail viewerHrId={access.hrId} />
      {children}
    </>
  );
}
