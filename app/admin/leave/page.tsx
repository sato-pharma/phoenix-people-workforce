import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminLeaveRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const nextParams = new URLSearchParams();
  const requestId = firstParam(params.requestId);
  const status = firstParam(params.status);

  if (requestId) nextParams.set("requestId", requestId);
  if (status) nextParams.set("status", status);

  redirect(`/leave-management/vacation-report${nextParams.toString() ? `?${nextParams.toString()}` : ""}`);
}
