import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  deleteProductAlias,
  deleteTerritoryAlias,
  listProductAliases,
  listTerritoryAliases,
  upsertProductAlias,
  upsertTerritoryAlias,
} from "@/lib/sales/normalizer/mapping";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function actor(access: Awaited<ReturnType<typeof resolveAccessContext>>): string {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function fail(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

// GET — product aliases (per distributor) + territory aliases (global) for the Mapping Database.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const distributor = new URL(request.url).searchParams.get("distributor")?.trim() ?? "";
    if (!distributor) return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    const [products, territories] = await Promise.all([listProductAliases(distributor), listTerritoryAliases()]);
    return NextResponse.json({ success: true, products, territories });
  } catch (error) {
    return fail(error, "Failed to load aliases.");
  }
}

// POST — single-row upsert/delete for a product or territory alias.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const body = (await request.json().catch(() => ({}))) as {
      type?: "product" | "territory";
      action?: "upsert" | "delete";
      distributorCode?: string;
      raw?: string;
      code?: string; // product code or brick id
      normalizedAlias?: string;
    };
    const actorLoginId = actor(access);
    if (body.type === "product") {
      if (body.action === "delete") {
        await deleteProductAlias({ actorLoginId, distributorCode: String(body.distributorCode ?? ""), normalizedAlias: String(body.normalizedAlias ?? "") });
      } else {
        await upsertProductAlias({ actorLoginId, distributorCode: String(body.distributorCode ?? ""), raw: String(body.raw ?? ""), productCode: String(body.code ?? "") });
      }
    } else if (body.type === "territory") {
      if (body.action === "delete") {
        await deleteTerritoryAlias({ actorLoginId, normalizedAlias: String(body.normalizedAlias ?? ""), targetCode: String(body.code ?? "") });
      } else {
        await upsertTerritoryAlias({ actorLoginId, raw: String(body.raw ?? ""), brickId: String(body.code ?? "") });
      }
    } else {
      return NextResponse.json({ success: false, error: "type must be 'product' or 'territory'." }, { status: 400 });
    }
    return NextResponse.json({ success: true, message: body.action === "delete" ? "Mapping deleted." : "Mapping saved." });
  } catch (error) {
    return fail(error, "Failed to save alias.");
  }
}
