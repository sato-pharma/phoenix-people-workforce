import { RetiredTouchTrailCleanup } from "@/components/phoenix-crm/retired-touch-trail-cleanup";

// The admin twin of `app/employee-portals/field-crm/layout.tsx`. It used to mount the Phoenix CRM
// touch trail over the manager's and Super Admin's side of the module; the trail was RETIRED on the
// owner's word on 1 November 2026 ("retire and delete all its traces"), and what is left is the same
// one-release cleanup of the trail's old browser queue. Renders nothing, changes nothing. Delete this
// layout, its portal twin and `RetiredTouchTrailCleanup` in the release after this one ships
// (tests/admin-group-has-no-portal-shell.test.ts lists this layout by name — drop it there too).
export default function AdminFieldCrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <RetiredTouchTrailCleanup />
      {children}
    </>
  );
}
