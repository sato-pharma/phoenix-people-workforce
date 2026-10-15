import { cairoStamp, countText, dayLabelWithYear } from "@/components/phoenix-crm/format";
import type { VisitReportField, VisitReportValue } from "@/lib/phoenix-crm/visit-report-fields";

/** A blank is shown as a dash, never as a zero: the screen must not read "nobody did" into "nothing recorded". */
export const VISIT_REPORT_BLANK = "—";

/** One field's value as the screen prints it. Instants are Cairo; counts carry their unit. */
export function formatVisitReportValue(field: Pick<VisitReportField, "format">, value: VisitReportValue | undefined): string {
  if (value === null || value === undefined || value === "") return VISIT_REPORT_BLANK;
  switch (field.format) {
    case "yesno":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "date":
      return typeof value === "string" ? dayLabelWithYear(value) : String(value);
    case "datetime":
      return typeof value === "string" ? cairoStamp(value) : String(value);
    case "coordinate":
      return typeof value === "number" ? value.toFixed(6) : String(value);
    case "meters":
      return typeof value === "number" ? `${countText(value)} m` : String(value);
    case "km":
      return typeof value === "number" ? `${value.toFixed(1)} km` : String(value);
    case "seconds":
      return typeof value === "number" ? `${countText(value)} s` : String(value);
    case "minutes":
      return typeof value === "number" ? `${countText(value)} min` : String(value);
    case "decimal":
      return typeof value === "number" ? value.toFixed(1) : String(value);
    case "integer":
      return typeof value === "number" ? countText(value) : String(value);
    default:
      return String(value);
  }
}
