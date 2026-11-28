import { TRAIN_AC2_BY_TRAIN, TRAIN_AC2_BY_TRAIN_COLLECTED_FOR, TRAIN_AC2_BY_TRAIN_STATIONS } from "@/lib/outstation/train-fares-by-train-data";
import { TRAIN_STATIONS } from "@/lib/outstation/train-fares-data";
import { distanceKm, type GeoPoint } from "@/lib/outstation/train-fare";

/**
 * A District Manager's train ticket is paid up to the second-class AC (ثانية مكيفة) fare of the train he
 * took (owner, 28 Nov 2026, District Manager expense rules): the railway's own fare for THAT train between
 * the two stations, read from the fare sweep of the Egyptian National Railways booking site, because one
 * route's AC 2 fares differ by train (Cairo → Asyut: 210, 250, 290 or 350).
 *
 *  - The ticket's train number and stations were read (ticket-scan.ts) and that train runs the pair: its fare.
 *  - The stations were read but not the train, or the train is not in the sweep: the route's HIGHEST AC 2
 *    fare — he is never paid less than a train he could have taken.
 *  - Nothing usable was read: the highest AC 2 fare between the stations nearest his home and the
 *    destination; when those two have no direct train, the nearest pair that does (as the No ticket fare).
 *  - Nothing at all (no home on file): no cap — never refused for the system's own gap.
 *
 * A leg with two tickets (a change of train) is capped at the sum of the two. Pure; server-side only (the
 * per-train table is large and the phone never needs it).
 */

type Station = { arabic: string; english: string; index: number; latitude: number; longitude: number; site: string };

const STATIONS: Station[] = TRAIN_STATIONS.map(([site, english, arabic, latitude, longitude], index) => ({
  arabic,
  english,
  index,
  latitude,
  longitude,
  site,
}));
const BY_SITE = new Map(STATIONS.map((station) => [station.site, station]));

/** "from>to" → train number → AC 2 fare in EGP; and "from>to" → the highest of them. Keys use TRAIN_STATIONS indexes. */
const TRAIN_FARES = new Map<string, Map<string, number>>();
const HIGHEST = new Map<string, number>();
for (const [from, to, packed] of TRAIN_AC2_BY_TRAIN) {
  const a = BY_SITE.get(TRAIN_AC2_BY_TRAIN_STATIONS[from] ?? "");
  const b = BY_SITE.get(TRAIN_AC2_BY_TRAIN_STATIONS[to] ?? "");
  if (!a || !b) continue;
  const key = `${a.index}>${b.index}`;
  const trains = TRAIN_FARES.get(key) ?? new Map<string, number>();
  for (const entry of packed.split(",")) {
    const [train, fare] = entry.split("=");
    const value = Number(fare);
    if (!train || !Number.isFinite(value) || value <= 0) continue;
    trains.set(train, Math.max(value, trains.get(train) ?? 0));
    HIGHEST.set(key, Math.max(value, HIGHEST.get(key) ?? 0));
  }
  TRAIN_FARES.set(key, trains);
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const asciiDigits = (value: string) => value.replace(ARABIC_DIGITS, (digit) => String((digit.charCodeAt(0) & 0xf) % 10));

/** Station words made comparable: Arabic letter forms unified, "ال", "محطة" and "station" dropped. */
export function stationWords(value: string): string {
  return asciiDigits(value)
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/محطه|station|stn\.?/g, " ")
    .replace(/(^|\s)ال/g, "$1")
    .replace(/(^|[\s-])el[\s-]/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Names a ticket may print for a station besides its own (Cairo's main station is "Misr" / Ramses). */
const ALIASES: Record<string, string[]> = {
  CAIRO: ["مصر", "رمسيس", "ramses", "ramsis", "misr"],
  "EL-GIZA": ["giza", "جيزه"],
  "SIDI GABER": ["سيديجابر", "sidigaber"],
};

const STATION_KEYS: Array<{ key: string; station: Station }> = STATIONS.flatMap((station) =>
  [station.site, station.english, station.arabic, ...(ALIASES[station.site] ?? [])]
    .map((name) => stationWords(name))
    .filter((key) => key.length >= 3)
    .map((key) => ({ key, station })),
).sort((a, b) => b.key.length - a.key.length);

/** The sweep's station a printed name stands for, or null. An exact name first, then the longest one inside it. */
export function matchTrainStation(printed: string | null | undefined): Station | null {
  const words = stationWords(String(printed ?? ""));
  if (words.length < 3) return null;
  const exact = STATION_KEYS.find((entry) => entry.key === words);
  if (exact) return exact.station;
  return STATION_KEYS.find((entry) => entry.key.length >= 4 && words.includes(entry.key))?.station ?? null;
}

function trainKey(value: unknown): string {
  return asciiDigits(String(value ?? ""))
    .replace(/[^0-9]/g, "")
    .replace(/^0+(?=.)/, "");
}

export type TrainFareCapSource = "train" | "route" | "nearest";

export type TrainFareCap = {
  fare: number;
  fromName: string;
  source: TrainFareCapSource;
  toName: string;
  trainNumber: string | null;
};

/** One read ticket's cap: that train's AC 2 fare, else the route's highest. Null when the stations are not known. */
export function ticketFareCap(ticket: { fromStation?: unknown; toStation?: unknown; trainNumber?: unknown }): TrainFareCap | null {
  const from = matchTrainStation(typeof ticket.fromStation === "string" ? ticket.fromStation : null);
  const to = matchTrainStation(typeof ticket.toStation === "string" ? ticket.toStation : null);
  if (!from || !to || from.index === to.index) return null;
  const key = `${from.index}>${to.index}`;
  const train = trainKey(ticket.trainNumber);
  const own = train ? TRAIN_FARES.get(key)?.get(train) : undefined;
  if (own) return { fare: own, fromName: from.english, source: "train", toName: to.english, trainNumber: train };
  const highest = HIGHEST.get(key);
  return highest ? { fare: highest, fromName: from.english, source: "route", toName: to.english, trainNumber: train || null } : null;
}

const usable = (point: GeoPoint | null | undefined): point is GeoPoint =>
  !!point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && !(point.latitude === 0 && point.longitude === 0);

/**
 * The highest AC 2 fare one way between the stations nearest the home and the destination — or, when those
 * two have no direct train, the pair of stations that does and lies closest to both (as the No ticket fare).
 */
export function nearestRouteFareCap(input: { destination: GeoPoint | null | undefined; home: GeoPoint | null | undefined }): TrainFareCap | null {
  if (!usable(input.home) || !usable(input.destination)) return null;
  const home = input.home;
  const destination = input.destination;
  let best: { cost: number; fare: number; from: Station; to: Station } | null = null;
  for (const [key, fare] of HIGHEST) {
    const [a, b] = key.split(">").map(Number);
    const from = STATIONS[a];
    const to = STATIONS[b];
    if (!from || !to) continue;
    const cost = distanceKm(home, from) + distanceKm(destination, to);
    if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) <= 1e-9 && fare > best.fare)) {
      best = { cost, fare, from, to };
    }
  }
  return best ? { fare: best.fare, fromName: best.from.english, source: "nearest", toName: best.to.english, trainNumber: null } : null;
}

export type DmTrainLegCheck = {
  cap: number;
  caps: TrainFareCap[];
  entered: number;
  leg: "go" | "return";
  /**
   * True when the cap rests only on the railway's own fare for the stations read off the ticket (its train,
   * or that route's dearest). False when any part is the nearest-route guess: the fare table has holes
   * (Zagazig, Minya al-Qamh and Port Said have no fares, and some routes were listed one way only), so a
   * guess is put to the approver as a flag, never refused.
   */
  refusable: boolean;
};

/**
 * The leg one read ticket belongs to. By DIRECTION, never by date: a ticket leaving the station nearer his
 * home is the trip there, one arriving there is the trip back — a same-day trip's two tickets share a date.
 * Only when its stations were not read (or no home is on file) does the date match decide (`matchedTo`).
 */
function legOfTicket(
  ticket: { fromStation?: unknown; matchedTo?: unknown; toStation?: unknown },
  home: GeoPoint | null | undefined,
): "go" | "return" | null {
  const from = matchTrainStation(typeof ticket.fromStation === "string" ? ticket.fromStation : null);
  const to = matchTrainStation(typeof ticket.toStation === "string" ? ticket.toStation : null);
  if (usable(home) && from && to && from.index !== to.index) {
    return distanceKm(home, from) <= distanceKm(home, to) ? "go" : "return";
  }
  if (ticket.matchedTo === "arrival") return "go";
  if (ticket.matchedTo === "departure") return "return";
  return null;
}

/**
 * The legs of a District Manager's train claim whose typed amount is above their cap. Each read ticket
 * counts on the leg its direction names (`legOfTicket`); a leg with none, or with a ticket whose stations
 * were not read, takes the nearest-route cap for that ticket. Empty when every leg fits.
 */
export function dmTrainFareOverCaps(input: {
  destination: GeoPoint | null | undefined;
  goAmount: number;
  home: GeoPoint | null | undefined;
  returnAmount: number;
  tickets: ReadonlyArray<{ fromStation?: unknown; matchedTo?: unknown; toStation?: unknown; trainNumber?: unknown }>;
}): DmTrainLegCheck[] {
  const nearest = nearestRouteFareCap({ destination: input.destination, home: input.home });
  const over: DmTrainLegCheck[] = [];
  for (const [leg, entered] of [
    ["go", input.goAmount],
    ["return", input.returnAmount],
  ] as const) {
    if (!(entered > 0)) continue;
    const onLeg = input.tickets.filter((ticket) => legOfTicket(ticket, input.home) === leg);
    const caps: TrainFareCap[] = [];
    let known = true;
    for (const ticket of onLeg.length > 0 ? onLeg : [{}]) {
      const cap = (onLeg.length > 0 ? ticketFareCap(ticket) : null) ?? nearest;
      if (!cap) {
        known = false;
        break;
      }
      caps.push(cap);
    }
    if (!known) continue;
    const cap = caps.reduce((sum, item) => sum + item.fare, 0);
    // Half a pound of slack for a fare typed with its piastres.
    if (entered > cap + 0.5) over.push({ cap, caps, entered, leg, refusable: caps.every((item) => item.source !== "nearest") });
  }
  return over;
}

/** The refusal a District Manager reads when a train leg is above its cap. */
export function dmTrainFareRefusal(over: ReadonlyArray<DmTrainLegCheck>): string | null {
  if (over.length === 0) return null;
  const money = (value: number) => `EGP ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const parts = over.map((check) => {
    const trains = check.caps
      .map((cap) =>
        cap.source === "train"
          ? `train ${cap.trainNumber}, ${cap.fromName} to ${cap.toName}`
          : cap.source === "route"
            ? `the dearest train from ${cap.fromName} to ${cap.toName}`
            : `the dearest train from ${cap.fromName} to ${cap.toName}, the stations nearest your home and this place`,
      )
      .join(" then ");
    const leg = check.leg === "go" ? "the trip there" : "the trip back";
    return `For ${leg} you entered ${money(check.entered)}; the most paid is ${money(check.cap)} (${trains}).`;
  });
  return (
    `A train ticket is paid up to the second-class AC fare of the train taken. ${parts.join(" ")} ` +
    `Enter that amount or less and submit again. Fares as the railway listed them for ${TRAIN_AC2_BY_TRAIN_COLLECTED_FOR}.`
  );
}

/**
 * The approver's flag for train legs above their cap that submit did not refuse: a cap that rests on a
 * nearest-route estimate (`refusable` false), or any leg of a claim that synced offline (no screen to refuse
 * it on). Stored on the claim (`dm_work_allowance.evidenceFlags`) and failed on Expense Approvals.
 */
export function dmTrainFareFlag(over: ReadonlyArray<DmTrainLegCheck>, options: { offline?: boolean } = {}): string | null {
  if (over.length === 0) return null;
  const money = (value: number) => `EGP ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const parts = over.map((check) => {
    const leg = check.leg === "go" ? "the trip there" : "the trip back";
    const route = check.caps
      .map((cap) => (cap.source === "train" ? `train ${cap.trainNumber}, ${cap.fromName} to ${cap.toName}` : `${cap.fromName} to ${cap.toName}`))
      .join(" then ");
    return `${money(check.entered)} for ${leg}, above ${money(check.cap)} (${route})`;
  });
  const why = options.offline
    ? "The claim synced offline, so it could not be refused when it was sent."
    : "The railway's fare for the stations on the ticket is not on file, so the most paid was estimated from the stations nearest the employee's home and the destination.";
  return `Train fare above the second-class AC fare: ${parts.join("; ")}. ${why} Check the ticket before approving.`;
}
