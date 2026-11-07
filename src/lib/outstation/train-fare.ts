import { TRAIN_AC2_LOWEST_FARES, TRAIN_FARES_COLLECTED_FOR, TRAIN_STATIONS } from "@/lib/outstation/train-fares-data";
import type { OutstationNoTicketFare } from "@/lib/outstation/types";

/**
 * The fixed fare of a "No ticket" trip (owner, 2026-11-07): the LOWEST second-class AC (ثانية مكيفة) fare
 * of a direct train from the station nearest the employee's home to the station nearest the destination,
 * paid for the trip there AND back (× 2). Nobody types it and nobody can change it — the server sets it.
 *
 * When those two stations have no direct AC 2 train between them, the nearest pair of stations that does
 * is used instead (owner: "find the nearest station and calculate based on it"): the pair whose stations
 * lie closest, together, to the home and to the destination. When the nearest pair has a fare it is that
 * pair, so the fallback only ever moves to the next-closest stations.
 *
 * Pure and client-safe: the wizard shows the same figure the server will store.
 */

export type TrainStation = {
  arabicName: string;
  index: number;
  latitude: number;
  longitude: number;
  name: string;
};

export type GeoPoint = { latitude: number; longitude: number };

export type NoTicketFare =
  | {
      collectedFor: string;
      /** Distance in km from the home to the boarding station, and from the destination to the alighting one. */
      fromStationKm: number;
      fromStation: TrainStation;
      /** True when the nearest stations had no direct AC 2 train and the next-closest pair was used. */
      nearestHadNoTrain: boolean;
      oneWayFare: number;
      status: "priced";
      toStationKm: number;
      toStation: TrainStation;
      /** There and back: oneWayFare × 2. */
      totalFare: number;
    }
  | { reason: string; status: "unavailable" };

export const NO_TICKET_TRIP_LEGS = 2;

const STATIONS: TrainStation[] = TRAIN_STATIONS.map(([, name, arabicName, latitude, longitude], index) => ({
  arabicName,
  index,
  latitude,
  longitude,
  name,
}));

const FARES = new Map<string, number>(TRAIN_AC2_LOWEST_FARES.map(([from, to, fare]) => [`${from}>${to}`, fare]));

export function trainStations(): readonly TrainStation[] {
  return STATIONS;
}

export function trainFareBetween(fromIndex: number, toIndex: number): number | null {
  return FARES.get(`${fromIndex}>${toIndex}`) ?? null;
}

export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isUsablePoint(point: GeoPoint | null | undefined): point is GeoPoint {
  return (
    !!point &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    !(point.latitude === 0 && point.longitude === 0)
  );
}

function nearestStation(point: GeoPoint): { km: number; station: TrainStation } {
  let best = { km: Number.POSITIVE_INFINITY, station: STATIONS[0] };
  for (const station of STATIONS) {
    const km = distanceKm(point, station);
    if (km < best.km) best = { km, station };
  }
  return best;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function resolveNoTicketFare(input: {
  destination: GeoPoint | null | undefined;
  home: GeoPoint | null | undefined;
}): NoTicketFare {
  if (!isUsablePoint(input.home)) {
    return { reason: "Your home location is not on file, so the train fare cannot be worked out. Choose Fuel or Ticket.", status: "unavailable" };
  }
  if (!isUsablePoint(input.destination)) {
    return { reason: "Capture where you are first — the train fare is worked out from the destination.", status: "unavailable" };
  }
  const home = input.home;
  const destination = input.destination;

  const nearestHome = nearestStation(home);
  const nearestDestination = nearestStation(destination);
  if (nearestHome.station.index === nearestDestination.station.index) {
    return {
      reason: `Your home and this destination are nearest the same station (${nearestHome.station.name}), so there is no train fare. Choose Fuel or Ticket.`,
      status: "unavailable",
    };
  }

  let best: { cost: number; fare: number; from: TrainStation; fromKm: number; to: TrainStation; toKm: number } | null = null;
  for (const [fromIndex, toIndex, fare] of TRAIN_AC2_LOWEST_FARES) {
    const from = STATIONS[fromIndex];
    const to = STATIONS[toIndex];
    const fromKm = distanceKm(home, from);
    const toKm = distanceKm(destination, to);
    const cost = fromKm + toKm;
    if (
      !best ||
      cost < best.cost - 1e-9 ||
      // Equally close: the cheaper fare, then the lower station numbers, so the choice never depends on order.
      (Math.abs(cost - best.cost) <= 1e-9 && (fare < best.fare || (fare === best.fare && fromIndex * 100 + toIndex < best.from.index * 100 + best.to.index)))
    ) {
      best = { cost, fare, from, fromKm, to, toKm };
    }
  }
  if (!best) return { reason: "No train fare is on file.", status: "unavailable" };

  return {
    collectedFor: TRAIN_FARES_COLLECTED_FOR,
    fromStation: best.from,
    fromStationKm: round1(best.fromKm),
    nearestHadNoTrain:
      best.from.index !== nearestHome.station.index || best.to.index !== nearestDestination.station.index,
    oneWayFare: best.fare,
    status: "priced",
    toStation: best.to,
    toStationKm: round1(best.toKm),
    totalFare: best.fare * NO_TICKET_TRIP_LEGS,
  };
}

/** One line for the employee and the approver: "Cairo → Asyut · EGP 210 each way · EGP 420 there and back". */
export function describeNoTicketFare(fare: Extract<NoTicketFare, { status: "priced" }>): string {
  const money = (value: number) => `EGP ${value.toLocaleString("en-US")}`;
  return `${fare.fromStation.name} → ${fare.toStation.name} · second-class AC · ${money(fare.oneWayFare)} each way · ${money(fare.totalFare)} there and back`;
}

/** What the claim keeps: the stations, the distances to them and the fare — the approver reads this. */
export function noTicketFareRecord(fare: Extract<NoTicketFare, { status: "priced" }>): OutstationNoTicketFare {
  return {
    collectedFor: fare.collectedFor,
    fromStation: fare.fromStation.name,
    fromStationArabic: fare.fromStation.arabicName,
    fromStationKm: fare.fromStationKm,
    line: describeNoTicketFare(fare),
    nearestHadNoTrain: fare.nearestHadNoTrain,
    oneWayFare: fare.oneWayFare,
    toStation: fare.toStation.name,
    toStationArabic: fare.toStation.arabicName,
    toStationKm: fare.toStationKm,
    totalFare: fare.totalFare,
  };
}

/** Reads a stored no_ticket_fare column back; anything malformed reads as none. */
export function readNoTicketFare(value: unknown): OutstationNoTicketFare | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const num = (key: string) => (typeof row[key] === "number" && Number.isFinite(row[key]) ? (row[key] as number) : null);
  const str = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : "");
  const oneWayFare = num("oneWayFare");
  const totalFare = num("totalFare");
  if (oneWayFare == null || totalFare == null || !str("fromStation") || !str("toStation")) return null;
  return {
    collectedFor: str("collectedFor"),
    fromStation: str("fromStation"),
    fromStationArabic: str("fromStationArabic"),
    fromStationKm: num("fromStationKm") ?? 0,
    line: str("line"),
    nearestHadNoTrain: row.nearestHadNoTrain === true,
    oneWayFare,
    toStation: str("toStation"),
    toStationArabic: str("toStationArabic"),
    toStationKm: num("toStationKm") ?? 0,
    totalFare,
  };
}

/** "No ticket" cannot be priced for this trip — the employee chooses Fuel or Ticket. A 400, never a fault. */
export class NoTicketFareUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoTicketFareUnavailableError";
  }
}
