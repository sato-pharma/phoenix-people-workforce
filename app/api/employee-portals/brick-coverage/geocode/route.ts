import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { geocodeAddressForApi } from "@/lib/geo-intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BrickCoverageGeocodeInput = {
  area?: string | null;
  brick?: string | null;
  lineLabel?: string | null;
};

type NormalizedBrickCoverageGeocodeInput = {
  area: string;
  brick: string;
  lineLabel: string;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function buildAddress(point: BrickCoverageGeocodeInput) {
  return [point.brick, point.area, point.lineLabel, "Egypt"]
    .map(text)
    .filter(Boolean)
    .join(", ");
}

function sourceKeyFor(addressText: string) {
  const digest = createHash("sha1").update(addressText).digest("hex");
  return `brick_coverage:${digest}`;
}

function normalizePoint(input: unknown): NormalizedBrickCoverageGeocodeInput {
  const record =
    input && typeof input === "object"
      ? input as Record<string, unknown>
      : {};

  return {
    area: text(record.area),
    brick: text(record.brick),
    lineLabel: text(record.lineLabel),
  };
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "expenses", "read");

    if (access.role !== "National Sales Manager") {
      return NextResponse.json(
        { error: "forbidden", message: "Brick coverage geocoding is only available to NSM users." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const rawPoints: unknown[] = Array.isArray(body.points) ? body.points : [];
    const points = rawPoints
      .slice(0, 150)
      .map(normalizePoint)
      .filter((point) => point.brick);

    const results: Array<{
      area: string;
      brick: string;
      lat: number | null;
      lng: number | null;
    }> = [];

    for (const point of points) {
      const addressText = buildAddress(point);
      const location = await geocodeAddressForApi({
        addressText,
        area: point.area || null,
        label: point.brick,
        line: point.lineLabel || null,
        sourceKey: sourceKeyFor(addressText),
        sourceType: "custom",
      }).catch(() => null);

      results.push({
        area: point.area,
        brick: point.brick,
        lat: location?.lat ?? null,
        lng: location?.lng ?? null,
      });
    }

    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to geocode brick coverage points.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "brick_coverage_geocode_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
