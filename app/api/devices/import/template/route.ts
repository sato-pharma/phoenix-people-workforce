import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { generateDeviceImportTemplate } from "@/lib/devices/bulk-import";
import { deviceErrorMessage } from "@/lib/devices/service";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The bulk-import template, as an .xlsx.
 *
 * Gated on `company_devices:import`, the same permission as the dry run and the commit rather than
 * on `read`. The template is not a report — it carries a dropdown of every employee's name, and it
 * is only useful to somebody who is about to import. A viewer who can read the register but not
 * write to it has no reason to hold a people list.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "import");

    // `?prefill=roster` puts one row per current employee in, holder already filled. The blank
    // template stays the default: pre-filling is right exactly once, when the fleet already out has
    // to be walked and written down, and wrong every time after that.
    const prefillRoster = new URL(request.url).searchParams.get("prefill") === "roster";
    const workbook = await generateDeviceImportTemplate({ prefillRoster });

    return new NextResponse(workbook as ArrayBuffer, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="device-custody-${prefillRoster ? "walk-the-fleet" : "import"}-${currentCairoDateOnlyIso()}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to import devices." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "device_import_template_failed", message: deviceErrorMessage(error) },
      { status: 500 },
    );
  }
}
