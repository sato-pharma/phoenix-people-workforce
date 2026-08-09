import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildBrickCentroids, getBrickCentroidCoverage } from "@/lib/sales/normalizer/brick-centroids";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Brick centroid cache management for god-mode geo validation.
// GET  → coverage stats ({ totalBricks, cached, success, mismatch }).
// POST → run one build pass (field-GPS enrichment + up to 600 geocodes); re-invoke to continue.

async function requireNormalizerAccess(request: Request) {
  const access = await resolveAccessContext(request);
  if (access.role !== "Super Admin" && access.scope !== "system") {
    throw new Error("Forbidden: normalizer access requires Super Admin.");
  }
  await assertPermission(access, "sales", "import");
  return access;
}

export async function GET(request: Request) {
  try {
    await requireNormalizerAccess(request);
    const coverage = await getBrickCentroidCoverage();
    return NextResponse.json({ success: true, data: coverage });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Coverage check failed.") }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await requireNormalizerAccess(request);
    const result = await buildBrickCentroids();
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Centroid build failed.") }, { status: 500 });
  }
}
