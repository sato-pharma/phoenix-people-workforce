import { getSupabaseAdmin } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

/**
 * Health check: Verify resignation data integrity in real-time
 * GET /api/health/resignations
 */
export async function GET(_request: NextRequest) {
  const supabase = getSupabaseAdmin();

  try {
    // Find corrupted records
    const { data: resignations } = await supabase
      .from("employee_resignations")
      .select("employee_hr_id,status")
      .in("status", ["approved", "completed"]);

    const resignedHrIds = new Set(
      (resignations ?? []).map((r: any) => r.employee_hr_id?.trim().toUpperCase()),
    );

    if (resignedHrIds.size === 0) {
      return NextResponse.json({
        status: "healthy",
        resignedEmployeeCount: 0,
      });
    }

    const { data: employees } = await supabase
      .from("employees")
      .select("hr_id,employment_status")
      .in("hr_id", Array.from(resignedHrIds));

    const corrupted = (employees ?? []).filter(
      (e: any) => e.employment_status !== "resigned" && e.employment_status !== "terminated",
    );

    if (corrupted.length > 0) {
      return NextResponse.json(
        {
          status: "error",
          message: `${corrupted.length} resigned employees have incorrect employment_status`,
          details: corrupted.map((e: any) => ({
            hrId: e.hr_id,
            currentStatus: e.employment_status,
          })),
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      status: "healthy",
      resignedEmployeeCount: resignedHrIds.size,
      message: "All resigned employees have correct status",
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
