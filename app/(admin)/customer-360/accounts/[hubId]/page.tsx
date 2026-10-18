import { Customer360HubPage } from "@/components/customer-360/hub-detail-page";

export const dynamic = "force-dynamic";

export default async function Customer360AccountPage({ params }: { params: Promise<{ hubId: string }> }) {
  const { hubId } = await params;
  return <Customer360HubPage kind="account" hubId={hubId} />;
}
