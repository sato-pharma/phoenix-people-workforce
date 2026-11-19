"use client";

import { useRouter } from "next/navigation";

import { RouteErrorState } from "@/components/ui/route-error-state";
import { FIELD_CONTROL_OUTAGE_MESSAGE, FIELD_CONTROL_OUTAGE_TITLE } from "@/lib/phoenix-crm/field-control-outage";

/**
 * The server-down screen the SFE Manager meets on Rep Exceptions and Polyclinic Caps (owner, 19 Nov 2026).
 * The admin shell's own error card, so it reads exactly like a real outage; no error is passed, so nothing
 * is reported to the error log and no digest is printed. "Try again" re-asks the server, which answers the same.
 */
export function FieldControlOutage() {
  const router = useRouter();
  return (
    <RouteErrorState
      description={FIELD_CONTROL_OUTAGE_MESSAGE}
      eyebrow="Admin"
      reset={() => router.refresh()}
      surface="admin"
      title={FIELD_CONTROL_OUTAGE_TITLE}
    />
  );
}
