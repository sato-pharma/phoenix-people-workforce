import { Customer360HubPage } from "@/components/customer-360/hub-detail-page";

export const dynamic = "force-dynamic";

export default async function Customer360DoctorPage({ params }: { params: Promise<{ hubId: string }> }) {
  const { hubId } = await params;
  return <Customer360HubPage kind="doctor" hubId={hubId} />;
}
