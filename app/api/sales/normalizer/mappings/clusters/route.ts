import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadBrickCentroids } from "@/lib/sales/normalizer/brick-centroids";
import { clusterUnknownCustomers, type ClusterUnknown } from "@/lib/sales/normalizer/customer-clusters";
import { resolvePharmacyGeo } from "@/lib/sales/normalizer/pharmacy-geocode";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Cluster view for the normalizer's unknown customers: groups by cached geocode (governorate,
// markaz), falls back to territory text, and pre-narrows candidate bricks per cluster by
// centroid distance. Zero AI cost — geocoding is cache-dominated (live misses are capped inside
// resolvePharmacyGeo).

const MAX_UNKNOWNS = 500;

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as { unknowns?: ClusterUnknown[] };
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, MAX_UNKNOWNS);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { clusters: [] } });

    const [geoByKey, centroids] = await Promise.all([
      resolvePharmacyGeo(unknowns.map((u) => ({ address: u.rawAddress ?? "", name: u.rawName ?? u.raw }))),
      loadBrickCentroids(),
    ]);
    const clusters = clusterUnknownCustomers(unknowns, geoByKey, centroids);
    return NextResponse.json({ success: true, data: { clusters } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Clustering failed.") }, { status: 500 });
  }
}
