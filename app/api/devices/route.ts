import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createDevice,
  deviceErrorMessage,
  deviceRegisterErrorStatus,
  getDeviceRegisterData,
  isDeviceCategory,
  isDeviceRegisterSchemaMissing,
  isMarkableDeviceStatus,
  isReturnCondition,
  issueDevice,
  markDevice,
  parseAmount,
  reassignPlaceholder,
  reconcileDevice,
  reserveDevice,
  returnDevice,
  revokeReservation,
  setAssignmentItemValues,
  writeOffDevice,
} from "@/lib/devices/service";
import { isDevelopment } from "@/lib/env";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Gated on `company_devices`, its own resource — see the note on the union in
 * `src/lib/auth/permissions.ts` for why it is not `employees`.
 *
 * The POST carries five actions and each asserts separately: registering a device is `create`,
 * everything that moves custody or a status is `update`. The page hides the controls a viewer
 * cannot use, but that is UX — this file is the security boundary.
 */
function deviceApiError(error: unknown) {
  if (isForbiddenError(error)) return { message: deviceErrorMessage(error), status: 403 };
  if (isDeviceRegisterSchemaMissing(error)) {
    return {
      message: isDevelopment ? deviceErrorMessage(error) : "The device register is not ready.",
      status: 409,
    };
  }
  /**
   * Every custody rule in the database raises rather than returns — one holder per device, a
   * settlement capped at البند (10)'s agreed value, a damaged return that must say what was
   * damaged. Those are the CALLER being wrong, not the server failing, and each message is written
   * to be read by the person who pressed the button. Answering 500 would bury a usable sentence
   * under a generic failure and send somebody looking at logs for a working guard.
   */
  const message = deviceErrorMessage(error);
  return { message, status: deviceRegisterErrorStatus(message) };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "read");
    return NextResponse.json(await getDeviceRegisterData());
  } catch (error) {
    const { message, status } = deviceApiError(error);
    return NextResponse.json({ error: "device_register_load_failed", message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const payload = (await request.json()) as {
      action?:
        | "register"
        | "issue"
        | "price_items"
        | "return"
        | "mark"
        | "write_off"
        | "reserve"
        | "reassign_placeholder"
        | "revoke"
        | "reconcile";
      device?: Record<string, unknown>;
      deviceId?: string;
      assignmentId?: string;
      employeeHrId?: string;
      placeholderName?: string;
      newName?: string;
      declarationNo?: string | null;
      handoverPlace?: string | null;
      issuedOn?: string | null;
      condition?: string;
      shortfallNote?: string | null;
      settlementEgp?: unknown;
      returnedOn?: string | null;
      status?: string;
      reason?: string | null;
      note?: string | null;
      /** Keyed by the custody template's item number. A blank or absent key means not handed over. */
      itemValuesEgp?: Record<string, unknown> | null;
    };

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    if (payload.action === "register") {
      await assertPermission(access, "company_devices", "create");
      const device = payload.device ?? {};
      const assetTag = String(device.assetTag ?? "").trim();
      if (!assetTag || !isDeviceCategory(device.category)) {
        return NextResponse.json(
          { error: "missing_device", message: "An asset tag and a device category are required." },
          { status: 400 },
        );
      }
      const deviceId = await createDevice(
        {
          assetTag,
          category: device.category,
          manufacturer: (device.manufacturer as string) ?? null,
          model: (device.model as string) ?? null,
          serialNumber: (device.serialNumber as string) ?? null,
          imei: (device.imei as string) ?? null,
          deviceName: (device.deviceName as string) ?? null,
          processor: (device.processor as string) ?? null,
          installedRam: (device.installedRam as string) ?? null,
          systemType: (device.systemType as string) ?? null,
          windowsDeviceId: (device.windowsDeviceId as string) ?? null,
          windowsProductId: (device.windowsProductId as string) ?? null,
          simNumber: (device.simNumber as string) ?? null,
          lineNumber: (device.lineNumber as string) ?? null,
          estimatedValueEgp: parseAmount(device.estimatedValueEgp),
          purchasedOn: (device.purchasedOn as string) ?? null,
          note: (device.note as string) ?? null,
        },
        actor,
      );
      return NextResponse.json({ ...(await getDeviceRegisterData()), deviceId });
    }

    if (payload.action === "issue") {
      await assertPermission(access, "company_devices", "update");
      if (!payload.deviceId || !payload.employeeHrId) {
        return NextResponse.json(
          { error: "missing_issue", message: "A device and an employee are required to record a handover." },
          { status: 400 },
        );
      }
      await issueDevice(
        {
          deviceId: payload.deviceId,
          employeeHrId: payload.employeeHrId,
          declarationNo: payload.declarationNo ?? null,
          handoverPlace: payload.handoverPlace ?? null,
          issuedOn: payload.issuedOn ?? null,
          itemValuesEgp: payload.itemValuesEgp ?? null,
        },
        actor,
      );
      return NextResponse.json(await getDeviceRegisterData());
    }

    // Pricing the items on a handover that is already open. Gated on `update`, the same permission
    // as issuing, because it writes the figures البند (10) caps a wage deduction at — it is the
    // money on the custody record, not a note about it.
    if (payload.action === "price_items") {
      await assertPermission(access, "company_devices", "update");
      if (!payload.assignmentId) {
        return NextResponse.json(
          { error: "missing_assignment", message: "A custody record is required to price its items." },
          { status: 400 },
        );
      }
      await setAssignmentItemValues(
        {
          assignmentId: payload.assignmentId,
          itemValuesEgp: payload.itemValuesEgp ?? null,
        },
        actor,
      );
      return NextResponse.json(await getDeviceRegisterData());
    }

    if (payload.action === "return") {
      await assertPermission(access, "company_devices", "update");
      if (!payload.assignmentId || !isReturnCondition(payload.condition)) {
        return NextResponse.json(
          {
            error: "missing_return",
            message: "A custody record and a condition (good, damaged or incomplete) are required.",
          },
          { status: 400 },
        );
      }
      await returnDevice(
        {
          assignmentId: payload.assignmentId,
          condition: payload.condition,
          shortfallNote: payload.shortfallNote ?? null,
          settlementEgp: parseAmount(payload.settlementEgp),
          returnedOn: payload.returnedOn ?? null,
          note: payload.note ?? null,
        },
        actor,
      );
      return NextResponse.json(await getDeviceRegisterData());
    }

    if (payload.action === "mark") {
      await assertPermission(access, "company_devices", "update");
      if (!payload.deviceId || !isMarkableDeviceStatus(payload.status)) {
        return NextResponse.json(
          {
            error: "missing_status",
            message:
              "A device and a status are required. A device becomes assigned by being issued, never by being marked.",
          },
          { status: 400 },
        );
      }
      await markDevice(
        { deviceId: payload.deviceId, status: payload.status, reason: payload.reason ?? null },
        actor,
      );
      return NextResponse.json(await getDeviceRegisterData());
    }

    /**
     * Closing a custody record without the device coming back.
     *
     * `update`, not `delete` — and the distinction is the point. This ENDS a debt البند (10)
     * created; it does not remove the record that the debt existed, who owed it or who decided to
     * stop pursuing it. HR Operations holds no `delete` on this resource at all.
     */
    if (payload.action === "write_off") {
      await assertPermission(access, "company_devices", "update");
      const reason = String(payload.reason ?? "").trim();
      if (!payload.assignmentId || !reason) {
        return NextResponse.json(
          {
            error: "missing_write_off",
            message: "A custody record and a written reason are required to write one off.",
          },
          { status: 400 },
        );
      }
      await writeOffDevice(
        {
          assignmentId: payload.assignmentId,
          reason,
          settlementEgp: parseAmount(payload.settlementEgp),
        },
        actor,
      );
      return NextResponse.json(await getDeviceRegisterData());
    }

    // Earmark an in-stock device for a not-yet-hired holder. `update` (it moves custody), like issue.
    if (payload.action === "reserve") {
      await assertPermission(access, "company_devices", "update");
      const placeholderName = String(payload.placeholderName ?? "").trim();
      if (!payload.deviceId || !placeholderName) {
        return NextResponse.json(
          { error: "missing_reserve", message: "A device and the name it is being held for are required." },
          { status: 400 },
        );
      }
      await reserveDevice(
        {
          deviceId: payload.deviceId,
          placeholderName,
          declarationNo: payload.declarationNo ?? null,
          handoverPlace: payload.handoverPlace ?? null,
          note: payload.note ?? null,
        },
        actor,
      );
      return NextResponse.json(await getDeviceRegisterData());
    }

    if (payload.action === "reassign_placeholder") {
      await assertPermission(access, "company_devices", "update");
      const newName = String(payload.newName ?? "").trim();
      if (!payload.assignmentId || !newName) {
        return NextResponse.json(
          { error: "missing_reassign", message: "A reservation and a new name are required." },
          { status: 400 },
        );
      }
      await reassignPlaceholder({ assignmentId: payload.assignmentId, newName }, actor);
      return NextResponse.json(await getDeviceRegisterData());
    }

    if (payload.action === "revoke") {
      await assertPermission(access, "company_devices", "update");
      if (!payload.assignmentId) {
        return NextResponse.json(
          { error: "missing_revoke", message: "A reservation is required to revoke it." },
          { status: 400 },
        );
      }
      await revokeReservation({ assignmentId: payload.assignmentId, reason: payload.reason ?? null }, actor);
      return NextResponse.json(await getDeviceRegisterData());
    }

    // Day one: bind the reservation to the hired employee, creating the real signed custody.
    if (payload.action === "reconcile") {
      await assertPermission(access, "company_devices", "update");
      if (!payload.assignmentId || !payload.employeeHrId) {
        return NextResponse.json(
          {
            error: "missing_reconcile",
            message: "A reservation and the employee it is being handed to are required.",
          },
          { status: 400 },
        );
      }
      await reconcileDevice(
        {
          assignmentId: payload.assignmentId,
          employeeHrId: payload.employeeHrId,
          declarationNo: payload.declarationNo ?? null,
          handoverPlace: payload.handoverPlace ?? null,
          issuedOn: payload.issuedOn ?? null,
        },
        actor,
      );
      return NextResponse.json(await getDeviceRegisterData());
    }

    return NextResponse.json(
      { error: "unknown_action", message: "Unknown device register action." },
      { status: 400 },
    );
  } catch (error) {
    const { message, status } = deviceApiError(error);
    return NextResponse.json({ error: "device_register_action_failed", message }, { status });
  }
}
