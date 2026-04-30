import { NextResponse } from "next/server";

import { updateSalesBatchStatus } from "@/lib/sales/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    action: string;
    id: string;
  }>;
};

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { action, id } = await context.params;

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json(
        { success: false, error: "Unsupported sales import action." },
        { status: 400 },
      );
    }

    const detail = await updateSalesBatchStatus(
      id,
      action === "approve" ? "approved" : "rejected",
      "admin",
      "Phoenix Admin",
    );

    if (!detail) {
      return NextResponse.json(
        { success: false, error: "Sales batch was not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: detail,
      message:
        action === "approve"
          ? "Sales batch approved."
          : "Sales batch rejected.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Sales import action failed.",
      },
      { status: 500 },
    );
  }
}
