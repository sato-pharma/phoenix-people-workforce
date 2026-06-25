import { notFound } from "next/navigation";

import { IdentityCard } from "@/components/employee-portal/identity-card";
import { employeePortalDevPreviewData } from "@/lib/employee-portal/dev-preview-data";

export const metadata = { title: "Identity Banner Preview" };

// TEMP dev-only preview for polishing the identity banner in isolation.
export default function IdentityBannerPreviewPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  const withPhoto = {
    ...employeePortalDevPreviewData,
    employee: {
      ...employeePortalDevPreviewData.employee,
      fullName: "Nahed Tarek Hassan Omar Hattab",
      roleLabel: "Product Manager",
      photoUrl: "/people/nahed-hattab-reference.png",
    },
  };
  return (
    <main style={{ background: "#e6ebf1", minHeight: "100vh", padding: 32 }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <IdentityCard data={withPhoto} />
      </div>
    </main>
  );
}
