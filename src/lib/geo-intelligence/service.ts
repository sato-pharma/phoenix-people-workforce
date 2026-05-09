import * as XLSX from "xlsx";

import { normalizeHrIdForAccess, type AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  getBrowserKey,
  googleDistanceMatrix,
  googleGeocodeAddress,
  hasGoogleServerKey,
} from "@/lib/geo-intelligence/google";
import type {
  GeoBrickCoverageStatus,
  GeoBrickImportRow,
  GeoBrickRecord,
  GeoDashboardData,
  GeoDashboardFilters,
  GeoExpenseImportRow,
  GeoImportSummary,
  GeoLocationRecord,
  GeoMarker,
  GeoTripRouteRecord,
  GeoTripStatus,
  GeoSourceType,
} from "@/lib/geo-intelligence/types";

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function lower(value: unknown) {
  return text(value).toLowerCase();
}

function normalizeToken(value: unknown) {
  return lower(value).replace(/[^a-z0-9]+/g, "");
}

function numberValue(value: unknown) {
  const normalized = text(value).replace(/[,\s]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toISOString();
}

function headerKey(row: Record<string, unknown>, aliases: string[]) {
  const keys = Object.keys(row);
  const aliasSet = new Set(aliases.map((alias) => normalizeToken(alias)));
  return (
    keys.find((key) => aliasSet.has(normalizeToken(key))) ??
    null
  );
}

function monthKeyFromDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const match = String(value).match(/\d{4}-\d{2}/);
    return match?.[0] ?? null;
  }

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function splitBrickDetails(value: string) {
  return value
    .replace(/[؛]/g, ";")
    .replace(/[،]/g, ",")
    .replace(/\\/g, ";")
    .replace(/\//g, ";")
    .split(/[;,\n\r]+/g)
    .map((part) => part.trim())
    .map((part) => part.replace(/^[-–—\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function coverageStatusForBrick(row: GeoBrickImportRow): GeoBrickCoverageStatus {
  if (!row.employeeHrId && !row.employeeName) return "unassigned";
  return "covered";
}

function costPerKm() {
  const parsed = Number(process.env.GEO_COST_PER_KM ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

async function buildEmployeeLookups() {
  const directory = await getEmployeeDirectory().catch(() => null);
  const byHrId = new Map<string, { name: string; line: string | null; area: string | null }>();
  const byName = new Map<string, { hrId: string; name: string; line: string | null; area: string | null }>();

  directory?.employees.forEach((employee) => {
    const canonicalHrId = normalizeHrIdForAccess(employee.hrId);
    if (canonicalHrId) {
      byHrId.set(canonicalHrId, {
        area: employee.areaName ?? null,
        line: employee.lineName ?? null,
        name: employee.fullName,
      });
    }

    const nameToken = normalizeToken(employee.fullName);
    if (nameToken) {
      byName.set(nameToken, {
        area: employee.areaName ?? null,
        hrId: employee.hrId,
        line: employee.lineName ?? null,
        name: employee.fullName,
      });
    }
  });

  return { byHrId, byName };
}

async function cachedGeocode(params: {
  addressText: string;
  area?: string | null;
  city?: string | null;
  label: string;
  line?: string | null;
  sourceKey: string;
  sourceType: GeoSourceType;
}) {
  const supabase = getSupabaseAdmin();
  const addressText = text(params.addressText);
  if (!addressText) return null;

  const { data: existing } = await supabase
    .from("geo_locations")
    .select("*")
    .eq("source_type", params.sourceType)
    .eq("source_key", params.sourceKey)
    .maybeSingle();

  if (existing?.latitude != null && existing?.longitude != null) {
    return {
      lat: Number(existing.latitude),
      lng: Number(existing.longitude),
    };
  }

  const { data: cachedByAddress } = await supabase
    .from("geo_locations")
    .select("*")
    .eq("address_text", addressText)
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .limit(1)
    .maybeSingle();

  if (cachedByAddress?.latitude != null && cachedByAddress?.longitude != null) {
    await supabase.from("geo_locations").upsert(
      {
        address_text: addressText,
        area: params.area ?? null,
        city: params.city ?? null,
        geocode_provider: cachedByAddress.geocode_provider ?? "google",
        geocode_status: "cached",
        label: params.label,
        latitude: cachedByAddress.latitude,
        line: params.line ?? null,
        longitude: cachedByAddress.longitude,
        source_key: params.sourceKey,
        source_type: params.sourceType,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source_type,source_key" },
    );

    return {
      lat: Number(cachedByAddress.latitude),
      lng: Number(cachedByAddress.longitude),
    };
  }

  if (!hasGoogleServerKey()) {
    await supabase.from("geo_locations").upsert(
      {
        address_text: addressText,
        area: params.area ?? null,
        city: params.city ?? null,
        geocode_provider: "google",
        geocode_status: "pending_key",
        label: params.label,
        line: params.line ?? null,
        source_key: params.sourceKey,
        source_type: params.sourceType,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source_type,source_key" },
    );
    return null;
  }

  const location = await googleGeocodeAddress(addressText);
  await supabase.from("geo_locations").upsert(
    {
      address_text: addressText,
      area: params.area ?? null,
      city: params.city ?? null,
      geocode_provider: "google",
      geocode_status: location ? "success" : "failed",
      label: params.label,
      latitude: location?.lat ?? null,
      line: params.line ?? null,
      longitude: location?.lng ?? null,
      source_key: params.sourceKey,
      source_type: params.sourceType,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "source_type,source_key" },
  );

  return location;
}

export async function parseBrickWorkbook(file: File, lineOverride?: string | null) {
  const workbook = XLSX.read(await file.arrayBuffer(), { cellDates: true, type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("Brick workbook has no readable sheets.");
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheetName], {
    defval: "",
    raw: false,
  });
  if (rows.length === 0) {
    return [];
  }

  const sample = rows[0] ?? {};
  const hrIdKey = headerKey(sample, ["hr id", "hr_id", "employee hr id", "employee id", "code"]);
  const areaKey = headerKey(sample, ["area", "district", "territory", "brick area"]);
  const lineKey = headerKey(sample, ["line", "business line", "product line"]);
  const brickKey = headerKey(sample, ["brick", "brick name", "bricks in details", "details"]);
  const employeeKey = headerKey(sample, ["employee", "employee name", "medical rep", "specialist"]);
  const lineFallback = text(lineOverride) || text(file.name.split(" ")[0]) || "Pedia";
  const employees = await buildEmployeeLookups();
  const parsed: GeoBrickImportRow[] = [];

  rows.forEach((row, index) => {
    const area = text(areaKey ? row[areaKey] : "");
    const line = text(lineKey ? row[lineKey] : "") || lineFallback;
    const hrIdRaw = text(hrIdKey ? row[hrIdKey] : "");
    const canonicalHrId = normalizeHrIdForAccess(hrIdRaw);
    const employeeLookup = canonicalHrId ? employees.byHrId.get(canonicalHrId) : null;
    const employeeNameFromSheet = text(employeeKey ? row[employeeKey] : "");
    const employeeName =
      employeeNameFromSheet ||
      employeeLookup?.name ||
      null;
    const brickValue = text(brickKey ? row[brickKey] : "");
    if (!area && !brickValue) return;

    const brickNames = brickValue ? splitBrickDetails(brickValue) : [];
    const values = brickNames.length > 0 ? brickNames : [brickValue].filter(Boolean);

    values.forEach((brickName, brickIndex) => {
      const brickCode = `${normalizeToken(line)}-${normalizeToken(area)}-${normalizeToken(brickName)}-${canonicalHrId ?? "na"}-${index}-${brickIndex}`;
      parsed.push({
        area,
        brickCode,
        brickName,
        employeeHrId: canonicalHrId ?? (hrIdRaw || null),
        employeeName,
        line,
      });
    });
  });

  const deduped = new Map<string, GeoBrickImportRow>();
  parsed.forEach((row) => {
    const key = `${normalizeToken(row.line)}::${normalizeToken(row.area)}::${normalizeToken(row.brickName)}::${normalizeHrIdForAccess(row.employeeHrId) ?? "na"}`;
    if (!deduped.has(key)) {
      deduped.set(key, row);
    }
  });

  return Array.from(deduped.values());
}

export async function parseExpenseWorkbook(
  file: File,
  monthOverride?: string | null,
): Promise<GeoExpenseImportRow[]> {
  const workbook = XLSX.read(await file.arrayBuffer(), { cellDates: true, type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("Expenses workbook has no readable sheets.");
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheetName], {
    defval: "",
    raw: false,
  });
  if (rows.length === 0) {
    return [];
  }

  const sample = rows[0] ?? {};
  const hrIdKey = headerKey(sample, ["hr id", "hr_id", "employee id", "employee code", "column2", "code"]);
  const employeeKey = headerKey(sample, ["specialist", "employee", "employee name", "medical rep"]);
  const dateKey = headerKey(sample, ["date", "trip date"]);
  const fromKey = headerKey(sample, ["from", "origin", "trip origin"]);
  const toKey = headerKey(sample, ["to", "destination", "trip destination"]);
  const totalKey = headerKey(sample, ["total", "amount", "claimed amount", "travel cost"]);
  const monthKey = headerKey(sample, ["month", "period", "source month"]);
  const lookups = await buildEmployeeLookups();

  return rows
    .map((row) => {
      const employeeNameRaw = text(employeeKey ? row[employeeKey] : "");
      const employeeLookup = lookups.byName.get(normalizeToken(employeeNameRaw));
      const hrIdRaw = text(hrIdKey ? row[hrIdKey] : "");
      const canonicalHrId = normalizeHrIdForAccess(hrIdRaw) ?? employeeLookup?.hrId ?? null;
      return {
        claimedAmount: numberValue(totalKey ? row[totalKey] : ""),
        employeeHrId: canonicalHrId,
        employeeName: employeeNameRaw || employeeLookup?.name || "Unknown Employee",
        fromText: text(fromKey ? row[fromKey] : ""),
        sourceFileMonth:
          text(monthKey ? row[monthKey] : "") ||
          monthOverride ||
          monthKeyFromDate(isoDate(dateKey ? row[dateKey] : "")),
        toText: text(toKey ? row[toKey] : ""),
        tripDate: isoDate(dateKey ? row[dateKey] : ""),
      };
    })
    .filter((row) => row.fromText || row.toText || row.claimedAmount > 0);
}

export async function validateTripRoute(input: GeoExpenseImportRow) {
  const fromCoords = await cachedGeocode({
    addressText: input.fromText,
    label: input.fromText || "Trip origin",
    sourceKey: `${input.employeeHrId ?? normalizeToken(input.employeeName)}::${input.tripDate ?? "na"}::from::${normalizeToken(input.fromText)}`,
    sourceType: "trip_origin",
  });

  const toCoords = await cachedGeocode({
    addressText: input.toText,
    label: input.toText || "Trip destination",
    sourceKey: `${input.employeeHrId ?? normalizeToken(input.employeeName)}::${input.tripDate ?? "na"}::to::${normalizeToken(input.toText)}`,
    sourceType: "trip_destination",
  });

  const distance = fromCoords && toCoords
    ? await googleDistanceMatrix(fromCoords, toCoords)
    : { distanceMeters: null, durationSeconds: null };

  const km = distance.distanceMeters ? distance.distanceMeters / 1000 : 0;
  const expectedAmount = km * costPerKm();
  const varianceAmount = input.claimedAmount - expectedAmount;
  const variancePercent = expectedAmount > 0 ? (varianceAmount / expectedAmount) * 100 : 0;

  let status: GeoTripStatus = "normal";
  const absoluteVariancePercent = Math.abs(variancePercent);
  if (absoluteVariancePercent > 50) status = "high_risk";
  else if (absoluteVariancePercent > 20) status = "review_required";

  return {
    claimedAmount: input.claimedAmount,
    employeeHrId: input.employeeHrId,
    employeeName: input.employeeName,
    expectedAmount,
    fromLat: fromCoords?.lat ?? null,
    fromLng: fromCoords?.lng ?? null,
    fromText: input.fromText,
    googleDistanceMeters: distance.distanceMeters,
    googleDurationSeconds: distance.durationSeconds,
    sourceFileMonth: input.sourceFileMonth,
    status,
    toLat: toCoords?.lat ?? null,
    toLng: toCoords?.lng ?? null,
    toText: input.toText,
    tripDate: input.tripDate,
    varianceAmount,
    variancePercent,
  };
}

export async function importBricksWorkbook(params: {
  file: File;
  line?: string | null;
}): Promise<GeoImportSummary> {
  const rows = await parseBrickWorkbook(params.file, params.line);
  const supabase = getSupabaseAdmin();
  const issues: string[] = [];

  if (rows.length === 0) {
    return { inserted: 0, issues: ["No brick rows detected."], processed: 0 };
  }

  const line = rows[0]?.line ?? text(params.line) ?? "Pedia";
  await supabase.from("geo_bricks").delete().ilike("line", line);

  const inserts: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const geocoded = await cachedGeocode({
      addressText: [row.brickName, row.area, row.line, "Egypt"].filter(Boolean).join(", "),
      area: row.area,
      label: row.brickName,
      line: row.line,
      sourceKey: row.brickCode,
      sourceType: "brick",
    });

    if (!geocoded) {
      issues.push(`Unable to geocode brick: ${row.brickName}`);
    }

    inserts.push({
      area: row.area,
      brick_code: row.brickCode,
      brick_name: row.brickName,
      coverage_status: coverageStatusForBrick(row),
      employee_hr_id: row.employeeHrId,
      employee_name: row.employeeName,
      latitude: geocoded?.lat ?? null,
      line: row.line,
      longitude: geocoded?.lng ?? null,
      updated_at: new Date().toISOString(),
    });
  }

  const { error } = await supabase.from("geo_bricks").insert(inserts);
  if (error) {
    throw new Error(error.message);
  }

  return {
    inserted: inserts.length,
    issues,
    processed: rows.length,
  };
}

export async function importExpensesWorkbook(params: {
  file: File;
  sourceFileMonth?: string | null;
}): Promise<GeoImportSummary> {
  const rows = await parseExpenseWorkbook(params.file, params.sourceFileMonth);
  const supabase = getSupabaseAdmin();
  const issues: string[] = [];

  if (rows.length === 0) {
    return { inserted: 0, issues: ["No expense trip rows detected."], processed: 0 };
  }

  const month = rows[0]?.sourceFileMonth ?? params.sourceFileMonth ?? null;
  if (month) {
    await supabase.from("geo_trip_routes").delete().eq("source_file_month", month);
  }

  const inserts: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const validated = await validateTripRoute(row);
    if (!validated.fromLat || !validated.toLat) {
      issues.push(
        `Missing coordinates for ${validated.employeeName ?? "Unknown"}: ${validated.fromText} -> ${validated.toText}`,
      );
    }

    inserts.push({
      claimed_amount: validated.claimedAmount,
      employee_hr_id: validated.employeeHrId,
      employee_name: validated.employeeName,
      expected_amount: validated.expectedAmount,
      from_lat: validated.fromLat,
      from_lng: validated.fromLng,
      from_text: validated.fromText,
      google_distance_meters: validated.googleDistanceMeters,
      google_duration_seconds: validated.googleDurationSeconds,
      source_file_month: validated.sourceFileMonth,
      status: validated.status,
      to_lat: validated.toLat,
      to_lng: validated.toLng,
      to_text: validated.toText,
      trip_date: validated.tripDate,
      updated_at: new Date().toISOString(),
      variance_amount: validated.varianceAmount,
      variance_percent: validated.variancePercent,
    });
  }

  const { error } = await supabase.from("geo_trip_routes").insert(inserts);
  if (error) {
    throw new Error(error.message);
  }

  return {
    inserted: inserts.length,
    issues,
    processed: rows.length,
  };
}

function routeRow(row: Record<string, unknown>): GeoTripRouteRecord {
  return {
    claimedAmount: numberValue(row.claimed_amount),
    createdAt: text(row.created_at),
    employeeHrId: text(row.employee_hr_id) || null,
    employeeName: text(row.employee_name) || null,
    expectedAmount: numberValue(row.expected_amount),
    fromLat: row.from_lat != null ? Number(row.from_lat) : null,
    fromLng: row.from_lng != null ? Number(row.from_lng) : null,
    fromText: text(row.from_text),
    googleDistanceMeters: row.google_distance_meters != null ? Number(row.google_distance_meters) : null,
    googleDurationSeconds: row.google_duration_seconds != null ? Number(row.google_duration_seconds) : null,
    id: Number(row.id),
    sourceFileMonth: text(row.source_file_month) || null,
    status: text(row.status) as GeoTripStatus,
    toLat: row.to_lat != null ? Number(row.to_lat) : null,
    toLng: row.to_lng != null ? Number(row.to_lng) : null,
    toText: text(row.to_text),
    tripDate: text(row.trip_date) || null,
    updatedAt: text(row.updated_at),
    varianceAmount: numberValue(row.variance_amount),
    variancePercent: numberValue(row.variance_percent),
  };
}

function brickRow(row: Record<string, unknown>): GeoBrickRecord {
  return {
    area: text(row.area) || null,
    brickCode: text(row.brick_code),
    brickName: text(row.brick_name),
    coverageStatus: text(row.coverage_status) as GeoBrickCoverageStatus,
    createdAt: text(row.created_at),
    employeeHrId: text(row.employee_hr_id) || null,
    employeeName: text(row.employee_name) || null,
    id: Number(row.id),
    latitude: row.latitude != null ? Number(row.latitude) : null,
    line: text(row.line) || null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    updatedAt: text(row.updated_at),
  };
}

function defaultFilters(input: GeoDashboardFilters): Required<GeoDashboardFilters> {
  return {
    area: input.area ?? "",
    employeeHrId: input.employeeHrId ?? "",
    line: input.line ?? "",
    month: input.month ?? "",
    status: (input.status ?? "") as Required<GeoDashboardFilters>["status"],
  };
}

function unique(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => text(value)).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

async function vacancyMarkersForAreas(bricks: GeoBrickRecord[]) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("position_vacancies")
    .select("id,region_name,manager_hr_id,manager_name,status,areas(name),lines(name)")
    .eq("status", "open")
    .limit(300);

  const areaCoordinates = new Map<string, { lat: number; lng: number; line: string | null }>();
  bricks.forEach((brick) => {
    if (!brick.area || brick.latitude == null || brick.longitude == null) return;
    const key = normalizeToken(brick.area);
    if (!areaCoordinates.has(key)) {
      areaCoordinates.set(key, {
        lat: brick.latitude,
        line: brick.line,
        lng: brick.longitude,
      });
    }
  });

  const markers: GeoMarker[] = [];
  for (const item of (data ?? []) as Array<Record<string, unknown>>) {
    const areaName = text((item.areas as { name?: string } | null)?.name ?? item.region_name);
    let coords = areaCoordinates.get(normalizeToken(areaName));
    if (!coords && areaName) {
      const geocoded = await cachedGeocode({
        addressText: [areaName, text((item.lines as { name?: string } | null)?.name), "Egypt"].filter(Boolean).join(", "),
        area: areaName,
        label: `Vacancy ${areaName}`,
        line: text((item.lines as { name?: string } | null)?.name) || null,
        sourceKey: `vacancy-${item.id}`,
        sourceType: "vacancy",
      });
      if (geocoded) {
        coords = {
          lat: geocoded.lat,
          line: text((item.lines as { name?: string } | null)?.name) || null,
          lng: geocoded.lng,
        };
      }
    }

    if (!coords) continue;
    markers.push({
      area: areaName || null,
      employeeHrId: text(item.manager_hr_id) || null,
      employeeName: text(item.manager_name) || null,
      id: `vacancy-${item.id}`,
      label: areaName || `Vacancy ${item.id}`,
      latitude: coords.lat,
      line: coords.line ?? null,
      longitude: coords.lng,
      meta: "Open vacancy",
      source: "vacancy",
      status: "vacant",
    });
  }

  return markers;
}

export async function getGeoDashboardData(
  _access: AccessContext,
  filtersInput: GeoDashboardFilters = {},
): Promise<GeoDashboardData> {
  const filters = defaultFilters(filtersInput);
  const supabase = getSupabaseAdmin();

  const { data: brickData } = await supabase
    .from("geo_bricks")
    .select("*")
    .order("line", { ascending: true })
    .order("area", { ascending: true })
    .order("brick_name", { ascending: true });

  const { data: routeData } = await supabase
    .from("geo_trip_routes")
    .select("*")
    .order("trip_date", { ascending: false })
    .limit(5000);

  let bricks = ((brickData ?? []) as Array<Record<string, unknown>>).map(brickRow);
  let routes = ((routeData ?? []) as Array<Record<string, unknown>>).map(routeRow);

  if (filters.line) {
    bricks = bricks.filter((row) => text(row.line) === filters.line);
  }
  if (filters.area) {
    bricks = bricks.filter((row) => text(row.area) === filters.area);
  }
  if (filters.employeeHrId) {
    bricks = bricks.filter((row) => text(row.employeeHrId) === filters.employeeHrId);
    routes = routes.filter((row) => text(row.employeeHrId) === filters.employeeHrId);
  }
  if (filters.month) {
    routes = routes.filter((row) => text(row.sourceFileMonth) === filters.month);
  }
  if (filters.status) {
    routes = routes.filter((row) => row.status === filters.status);
  }

  const employeeOptions = unique(
    bricks.map((brick) => brick.employeeHrId).concat(routes.map((route) => route.employeeHrId)),
  ).map((hrId) => ({
    hrId,
    name:
      bricks.find((brick) => brick.employeeHrId === hrId)?.employeeName ??
      routes.find((route) => route.employeeHrId === hrId)?.employeeName ??
      hrId,
  }));

  const kpis = {
    coveredBricks: bricks.filter((brick) => brick.coverageStatus === "covered").length,
    highRiskTrips: routes.filter((route) => route.status === "high_risk").length,
    totalClaimedExpenses: routes.reduce((sum, route) => sum + route.claimedAmount, 0),
    totalExpectedExpenses: routes.reduce((sum, route) => sum + route.expectedAmount, 0),
    totalMappedBricks: bricks.filter((brick) => brick.latitude != null && brick.longitude != null).length,
    totalTrips: routes.length,
    totalVariance: routes.reduce((sum, route) => sum + route.varianceAmount, 0),
    vacantBricks: bricks.filter((brick) => brick.coverageStatus !== "covered").length,
  };

  const varianceByEmployee = employeeOptions
    .map((employee) => ({
      label: employee.name,
      value: routes
        .filter((route) => route.employeeHrId === employee.hrId)
        .reduce((sum, route) => sum + route.varianceAmount, 0),
    }))
    .filter((row) => row.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 12);

  const varianceByArea = unique(bricks.map((brick) => brick.area))
    .map((area) => ({
      label: area,
      value: routes
        .filter((route) =>
          bricks.some((brick) => brick.employeeHrId && brick.employeeHrId === route.employeeHrId && text(brick.area) === area),
        )
        .reduce((sum, route) => sum + route.varianceAmount, 0),
    }))
    .filter((row) => row.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 12);

  const tripsByDestinationCity = unique(routes.map((route) => route.toText))
    .map((destination) => ({
      label: destination,
      value: routes.filter((route) => route.toText === destination).length,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

  const lineOptions = unique(bricks.map((brick) => brick.line));
  const coverageByLine = lineOptions.map((line) => ({
    covered: bricks.filter((brick) => brick.line === line && brick.coverageStatus === "covered").length,
    label: line,
    vacant: bricks.filter((brick) => brick.line === line && brick.coverageStatus !== "covered").length,
  }));

  const months = unique(routes.map((route) => route.sourceFileMonth));
  const highRiskTripsOverTime = months.map((month) => ({
    label: month,
    value: routes.filter((route) => route.sourceFileMonth === month && route.status === "high_risk").length,
  }));

  const territoryMarkers: GeoMarker[] = bricks
    .filter((brick) => brick.latitude != null && brick.longitude != null)
    .map((brick) => ({
      area: brick.area,
      employeeHrId: brick.employeeHrId,
      employeeName: brick.employeeName,
      id: `brick-${brick.id}`,
      label: brick.brickName,
      latitude: Number(brick.latitude),
      line: brick.line,
      longitude: Number(brick.longitude),
      meta: brick.employeeName ? `Assigned to ${brick.employeeName}` : "Unassigned brick",
      source: "brick",
      status: brick.coverageStatus,
    }));

  const routeMarkers: GeoMarker[] = routes.flatMap((route) => {
    const items: GeoMarker[] = [];
    if (route.fromLat != null && route.fromLng != null) {
      items.push({
        area: null,
        employeeHrId: route.employeeHrId,
        employeeName: route.employeeName,
        id: `origin-${route.id}`,
        label: route.fromText,
        latitude: route.fromLat,
        line: null,
        longitude: route.fromLng,
        meta: "Trip origin",
        source: "trip_origin",
        status: route.status,
      });
    }
    if (route.toLat != null && route.toLng != null) {
      items.push({
        area: null,
        employeeHrId: route.employeeHrId,
        employeeName: route.employeeName,
        id: `destination-${route.id}`,
        label: route.toText,
        latitude: route.toLat,
        line: null,
        longitude: route.toLng,
        meta: "Trip destination",
        source: "trip_destination",
        status: route.status,
      });
    }
    return items;
  });

  const vacancies = await vacancyMarkersForAreas(bricks);

  return {
    anomalies: routes
      .filter((route) => route.status !== "normal")
      .sort((a, b) => Math.abs(b.variancePercent) - Math.abs(a.variancePercent)),
    browserKeyConfigured: getBrowserKey().trim().length > 0,
    bricks,
    chartData: {
      coverageByLine,
      highRiskTripsOverTime,
      tripsByDestinationCity,
      varianceByArea,
      varianceByEmployee,
    },
    expenseRoutes: routes,
    filterOptions: {
      areas: unique(bricks.map((brick) => brick.area)),
      employees: employeeOptions,
      lines: lineOptions,
      months,
      statuses: ["normal", "review_required", "high_risk"],
    },
    filters,
    kpis,
    serverKeyConfigured: hasGoogleServerKey(),
    territoryMarkers: [...territoryMarkers, ...routeMarkers, ...vacancies],
  };
}

export async function geocodeAddressForApi(input: {
  addressText: string;
  area?: string | null;
  city?: string | null;
  label?: string | null;
  line?: string | null;
  sourceKey?: string | null;
  sourceType?: GeoSourceType;
}) {
  const location = await cachedGeocode({
    addressText: input.addressText,
    area: input.area ?? null,
    city: input.city ?? null,
    label: input.label ?? input.addressText,
    line: input.line ?? null,
    sourceKey: input.sourceKey ?? normalizeToken(input.addressText),
    sourceType: input.sourceType ?? "custom",
  });

  return location;
}
