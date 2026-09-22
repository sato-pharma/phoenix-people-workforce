// Daily Deductions module: access gating. Same audiences as the month module — the
// two surfaces are two views of the same money — so this delegates to
// src/lib/deductions/permissions.ts rather than defining a second, driftable list.
// Super Admin computes and publishes; the company-wide READ audience is the month
// module's read actors (Super Admin / CEO / Finance Manager / HR Operations).

import type { AccessContext } from "@/lib/auth/permissions";
import {
  isDeductionsPublishActor,
  isDeductionsReadActor,
} from "@/lib/deductions/permissions.ts";

export function isDailyDeductionsPublishActor(access: Pick<AccessContext, "role">): boolean {
  return isDeductionsPublishActor(access);
}

export function assertDailyDeductionsPublishActor(access: Pick<AccessContext, "role">): void {
  if (!isDailyDeductionsPublishActor(access)) {
    throw new Error("Forbidden: only Super Admin can compute or publish the daily deductions tally.");
  }
}

export function isDailyDeductionsReadActor(access: Pick<AccessContext, "role">): boolean {
  return isDeductionsReadActor(access);
}

export function assertDailyDeductionsReadActor(access: Pick<AccessContext, "role">): void {
  if (!isDailyDeductionsReadActor(access)) {
    throw new Error("Forbidden: you do not have access to the Daily Deductions module.");
  }
}
