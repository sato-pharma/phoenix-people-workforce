import { PhoenixCrmTouchTrail } from "@/components/phoenix-crm/touch-trail-collector";

// The admin twin of `app/employee-portals/field-crm/layout.tsx`: the same touch trail over the
// manager's and Super Admin's side of Phoenix CRM, mounted once for the whole subtree.
//
// IT COVERS THIS SIDE TOO ON PURPOSE. A manager entering a visit for a rep, or a Super Admin working
// a validation review, is a pair of hands on the module exactly as a rep is — and `actor_hr_id` is
// resolved from the session, so a row always says WHOSE hands rather than whose work it was about.
// Both incidents of 3 Oct were diagnosed from the rep's side; the next one may not be.
//
// Renders nothing, changes nothing, and deleting it turns the trail off for the admin side alone.
export default function AdminFieldCrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PhoenixCrmTouchTrail />
      {children}
    </>
  );
}
