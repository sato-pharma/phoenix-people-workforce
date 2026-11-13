import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { findLeaverOnRegister } from "@/lib/mailbox-offboarding/service";

import type { MailboxEditFormReading } from "../driver";
import { createJoinerDriverFromEnv } from "../sweep-deps";
import type { RobotActor } from "./actor";

/**
 * The LIVE body of `POST /api/mailbox-offboarding/edit-form-controls`, after its access checks, its
 * register check and its rate limit — ONE implementation, run by the website while the robot service
 * is switched off and by `/api/internal/mailbox-robot/edit-form-controls` on the robot service once it
 * is on (audit REC-075). It signs the console administrator in, opens ONE leaver's Edit form, reads it
 * and leaves it keeping nothing.
 *
 * 🔴 THE REGISTER IS ASKED AGAIN HERE, before a browser is built. The website already refused anyone
 * who is not a leaver on the register, but on the robot service the address arrives in a forwarded
 * body, and only a leaver's row may ever be opened.
 */
export async function runEditFormControlsAction(input: { actor: RobotActor; address: unknown }): Promise<NextResponse> {
  const { actor } = input;
  try {
    const asked = typeof input.address === "string" ? input.address.trim().toLowerCase() : "";
    const leaver = asked.includes("@") ? await findLeaverOnRegister(asked) : null;
    if (!leaver) {
      return NextResponse.json(
        {
          message: "That address is not a leaver on the mailbox register, so nothing was opened.",
          success: false,
        },
        { status: 404 },
      );
    }

    const driver = await createJoinerDriverFromEnv();
    let reading: MailboxEditFormReading;
    try {
      try {
        reading = await driver.captureMailboxEditForm({ address: leaver.workEmail });
      } finally {
        // Closed whatever happened, and BEFORE the audit: a leaked Chromium holds a signed-in
        // administrator session for longer than the request.
        await driver.close().catch(() => {});
      }
    } catch (error) {
      // A run that threw is recorded too — the app-password capture's first live run left no row at
      // all because its throw sailed past the audit, and the card's text was the only account.
      await writeAuditLog({
        actorLoginId: actor.loginId ?? null,
        entityId: leaver.taskId,
        entityType: "mailbox_offboarding",
        newValues: {
          address: leaver.workEmail,
          failed: true,
          reached: false,
          why: clientSafeErrorMessage(error, "The Edit form could not be read."),
        },
        summary: `The Edit-form capture for ${leaver.employeeName || leaver.workEmail} failed before it could read the form`,
      });
      throw error;
    }

    await writeAuditLog({
      actorLoginId: actor.loginId ?? null,
      entityId: leaver.taskId,
      entityType: "mailbox_offboarding",
      newValues: {
        // The reading carries labels, states and LENGTHS only — never a field's value — so storing
        // it is exactly as safe as showing it, and it answers the question without another run.
        ...reading,
        failed: false,
      },
      summary: reading.reached
        ? `Read ${reading.fields.length} control(s) on the Edit form of ${leaver.employeeName || leaver.workEmail}, left with ${reading.leftWith ?? "nothing"}`
        : `Could not read the Edit form of ${leaver.employeeName || leaver.workEmail}`,
    });

    return NextResponse.json({
      result: { ...reading, employeeName: leaver.employeeName },
      success: true,
    });
  } catch (error) {
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The Edit form could not be read."), success: false },
      { status: 500 },
    );
  }
}
