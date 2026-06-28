import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PortalMonthlySalesRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period } = await searchParams;
  const target = period ? `/employee-portals/sales?period=${encodeURIComponent(period)}` : "/employee-portals/sales";
  redirect(target);
}
