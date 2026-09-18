import { redirect } from "next/navigation";

import { DeviceRegisterWorkspace } from "@/components/devices/device-register-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  deviceErrorMessage,
  getDeviceRegisterData,
  isDeviceRegisterSchemaMissing,
} from "@/lib/devices/service";
import type { DeviceRegisterData } from "@/lib/devices/types";

export const dynamic = "force-dynamic";

function devicePageError(error: unknown) {
  if (isDeviceRegisterSchemaMissing(error)) {
    return "The device register is not ready. Run the Supabase migration for company_devices and device_assignments.";
  }
  return deviceErrorMessage(error);
}

export default async function DeviceRegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "company_devices", "read"))) {
    redirect("/employee-portals");
  }

  // Read and write are separate gates: the CEO reads what the company owns and what has walked out
  // with a leaver, HR Operations records the handovers. The workspace hides every control when
  // these are false and the route handler asserts the same permissions again — the page check is
  // UX, the route is the security boundary.
  const canRecord = await canAccess(access, "company_devices", "update");
  const canRegister = await canAccess(access, "company_devices", "create");
  // Separate from `create` on purpose: the bulk door is its own action, so it can be withdrawn
  // without taking single-device registration with it. The three import routes assert the same.
  const canImport = await canAccess(access, "company_devices", "import");
  // Correcting a serial number or IMEI already in the register is Super Admin only — `approve`,
  // the action this resource reserves to him (owner decision, 2026-09-18). `/api/devices/identity`
  // asserts the same.
  const canCorrectIdentity = await canAccess(access, "company_devices", "approve");
  // `?correct=<entry>` is where Rep Tablets' "the register has a different IMEI" warning lands.
  const correct = (await searchParams).correct;
  const initialCorrectDeviceId =
    canCorrectIdentity && typeof correct === "string" && correct.trim() ? correct.trim() : null;

  let initialData: DeviceRegisterData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getDeviceRegisterData();
  } catch (error) {
    initialError = devicePageError(error);
  }

  return (
    <DeviceRegisterWorkspace
      canCorrectIdentity={canCorrectIdentity}
      canImport={canImport}
      canRecord={canRecord}
      canRegister={canRegister}
      initialCorrectDeviceId={initialCorrectDeviceId}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
