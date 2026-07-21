import { NextResponse } from "next/server";

import { TerritoryAccessError } from "@/lib/sales/territory/service";

// Re-exported for route.ts convenience — the role gate itself lives with the domain service
// (src/lib/sales/territory/service.ts), not here, so the page and every API route agree.
export { isTerritoryDrilldownRole } from "@/lib/sales/territory/service";

export function jsonError(error: unknown, fallbackMessage: string) {
  if (error instanceof TerritoryAccessError) {
    return NextResponse.json({ success: false, error: "forbidden", message: error.message }, { status: 403 });
  }
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (message.toLowerCase().startsWith("forbidden:")) {
    return NextResponse.json({ success: false, error: "forbidden", message }, { status: 403 });
  }
  return NextResponse.json({ success: false, error: "server_error", message }, { status: 500 });
}
