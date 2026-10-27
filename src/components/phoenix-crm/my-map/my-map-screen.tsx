"use client";

/**
 * Phoenix CRM — My map: every validated customer place on the reader's territories, in its list's colour
 * (owner, 2026-10-27: "give a color for the AM pins and for the PM pins … whenever the rep validate one more
 * place, you will add it in the map").
 *
 * The page hands over everything once (`loadMyMap`); the lists, the filters, the search and the grouping all
 * run here, so a filter never waits on the server. The map is the territory's own, fitted to its pins — never
 * an outline of the country.
 *
 * 🔴 FRESH ON RETURN, WITH NO POLLING. Coming back to the tab refreshes the page's data at most once every 30
 * seconds, so a customer validated a minute ago is on the map the next time he looks.
 *
 * 🔴 AM, PM AND PHARMACIES ARE THREE FIGURES. Every count on this screen is read per list
 * (`myMapPerListText`), never added into one.
 *
 * 🔴 THE LIST FOLLOWS THE MAP. With no search, the list under the map holds the customers in the part of the
 * map on screen; a search lists every match wherever it is, and the map fits itself to them once the typing
 * pauses, not on every letter.
 *
 * A tapped pin's card opens straight under the map and is scrolled just into view, so on a phone the tap is
 * answered where his thumb is, and the map stays on screen above it.
 */

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { countText, plural } from "@/components/phoenix-crm/format";
import { MyMapCanvas, type DrawnPin, type MapView } from "@/components/phoenix-crm/my-map/my-map-canvas";
import { MyMapList, type MyMapListRow } from "@/components/phoenix-crm/my-map/my-map-list";
import { MyMapPinCard } from "@/components/phoenix-crm/my-map/my-map-pin-card";
import {
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmEmpty,
  CrmField,
  CrmNote,
  CrmPanel,
  CrmSearchField,
  CrmSelect,
  CrmStat,
  CrmStatGrid,
  type CrmChoiceOption,
} from "@/components/phoenix-crm/ui";
import { insideBounds } from "@/lib/phoenix-crm/my-map-geometry";
import {
  countMyMap,
  MY_MAP_LAYER_COLOUR,
  MY_MAP_LAYER_LABEL,
  MY_MAP_LAYERS,
  MY_MAP_TIER_COLOUR,
  myMapPerListText,
  type MyMapCustomer,
  type MyMapLayer,
  type MyMapPin,
  type MyMapView,
} from "@/lib/phoenix-crm/my-map-rules";
import { cn } from "@/lib/utils";

type ColourBy = "list" | "visits";
type Show = "all" | "new" | "notVisited" | "today";

const REFRESH_AT_MOST_EVERY_MS = 30_000;
/** How long the typing must pause before the search is applied and the map fitted to it. */
const SEARCH_SETTLES_AFTER_MS = 250;

const SCOPE_TITLE: Record<MyMapView["scope"], string> = {
  rep: "Your territory",
  district: "Your team's territories",
  manager: "The territories under you",
  company: "Every territory",
};

const COLOUR_OPTIONS: ReadonlyArray<CrmChoiceOption<ColourBy>> = [
  { value: "list", label: "Their list", note: "AM, PM and pharmacies" },
  { value: "visits", label: "This month's visits", note: "Against each grade" },
];

/** The search and up to three pickers share one row, as wide as the fields there are — never an empty column. */
const FILTER_GRID: Record<number, string | undefined> = {
  1: undefined,
  2: "sm:grid-cols-2",
  3: "md:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

function matchesSearch(needle: string, pin: MyMapPin, customer: MyMapCustomer): boolean {
  if (!needle) return true;
  return (
    customer.name.toLowerCase().includes(needle) ||
    (pin.brick?.toLowerCase().includes(needle) ?? false) ||
    (pin.label?.toLowerCase().includes(needle) ?? false)
  );
}

/** A pin as the legend draws it; `mark` is the tick or number the map writes on the pin itself. */
function Swatch({ colour, hollow = false, mark, ring }: { colour: string; hollow?: boolean; mark?: string; ring?: string }) {
  if (mark) {
    return (
      <span
        aria-hidden
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-phx-2xs font-black leading-none text-white"
        style={{ backgroundColor: colour, outline: "1px solid #cbd5e1" }}
      >
        {mark}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 shrink-0 border-2"
      style={{ backgroundColor: hollow ? "#ffffff" : colour, borderColor: ring ?? (hollow ? colour : "#ffffff"), outline: "1px solid #cbd5e1" }}
    />
  );
}

function Legend({ colourBy, planShown }: { colourBy: ColourBy; planShown: boolean }) {
  const items: Array<{ key: string; swatch: ReactNode; text: string }> =
    colourBy === "list"
      ? MY_MAP_LAYERS.map((layer) => ({ key: layer, swatch: <Swatch colour={MY_MAP_LAYER_COLOUR[layer]} />, text: MY_MAP_LAYER_LABEL[layer] }))
      : [
          { key: "tier-0", swatch: <Swatch colour={MY_MAP_TIER_COLOUR[0]} hollow />, text: "Not visited this month" },
          { key: "tier-1", swatch: <Swatch colour={MY_MAP_TIER_COLOUR[1]} />, text: "Behind its grade" },
          { key: "tier-2", swatch: <Swatch colour={MY_MAP_TIER_COLOUR[2]} />, text: "On its grade, or a pharmacy visited" },
        ];
  items.push({ key: "new", swatch: <Swatch colour="#ffffff" ring="#0f172a" />, text: "Validated this week" });
  if (planShown) items.push({ key: "plan", swatch: <Swatch colour="#64748b" mark="✓" />, text: "In today's plan" });
  items.push({ key: "group", swatch: <Swatch colour="#1e293b" mark="3" />, text: "Several places together — tap to zoom in" });
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-slate-100 pt-3" aria-label="What the colours mean">
      {items.map((item) => (
        <li className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-slate-600" key={item.key}>
          {item.swatch}
          <span className="break-words">{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function MyMapScreen({ browserKey, view }: { browserKey: string; view: MyMapView }) {
  const router = useRouter();
  const [layers, setLayers] = useState<ReadonlySet<MyMapLayer>>(() => new Set(MY_MAP_LAYERS));
  const [colourBy, setColourBy] = useState<ColourBy>("list");
  const [show, setShow] = useState<Show>("all");
  const [manager, setManager] = useState("");
  const [rep, setRep] = useState("");
  const [line, setLine] = useState("");
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; lat: number; lon: number; nonce: number } | null>(null);
  const [mapView, setMapView] = useState<MapView | null>(null);
  const [settledQuery, setSettledQuery] = useState("");
  const needle = settledQuery.trim().toLowerCase();
  const mapTopRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const scrollToCard = useRef(false);
  const focusNonce = useRef(0);
  const lastRefresh = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledQuery(query), SEARCH_SETTLES_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // A pin tapped on the map: bring its card just into view. A row's "Show on map" scrolls to the map instead.
  useEffect(() => {
    if (!pickedId || !scrollToCard.current) return;
    scrollToCard.current = false;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [pickedId]);

  useEffect(() => {
    lastRefresh.current = Date.now();
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefresh.current < REFRESH_AT_MOST_EVERY_MS) return;
      lastRefresh.current = now;
      router.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [router]);

  const planShown = (view.scope === "rep" || view.scope === "district") && view.planRead;
  const showManagers = (view.scope === "manager" || view.scope === "company") && view.managers.length > 0;
  const lines = useMemo(
    () => [...new Set(view.territories.map((territory) => territory.line).filter((name): name is string => Boolean(name)))].sort((left, right) => left.localeCompare(right)),
    [view.territories],
  );
  const showLines = (view.scope === "manager" || view.scope === "company") && lines.length > 1;

  const territoryChoices = useMemo(() => {
    const underManager = manager === "" ? null : new Set(view.managers[Number(manager)]?.territories ?? []);
    return view.territories
      .map((territory, index) => ({ index, territory }))
      .filter(({ index, territory }) => (underManager ? underManager.has(index) : true) && (line === "" || territory.line === line));
  }, [line, manager, view.managers, view.territories]);

  const showReps = territoryChoices.length > 1 || rep !== "";
  const filterFields = 1 + Number(showManagers) + Number(showLines) + Number(showReps);
  const filtered = layers.size !== MY_MAP_LAYERS.length || show !== "all" || manager !== "" || rep !== "" || line !== "" || query.trim() !== "";

  const shownTerritories = useMemo(() => {
    const ids = new Set(territoryChoices.map((choice) => choice.index));
    if (rep === "") return ids;
    const one = Number(rep);
    return ids.has(one) ? new Set([one]) : new Set<number>();
  }, [rep, territoryChoices]);

  // Territory and search only: what each "Show" option would hold.
  const scoped = useMemo(
    () =>
      view.pins.filter((pin) => {
        const customer = view.customers[pin.customer];
        return Boolean(customer) && shownTerritories.has(customer.territory) && matchesSearch(needle, pin, customer);
      }),
    [needle, shownTerritories, view.customers, view.pins],
  );
  const scopedCounts = useMemo(() => countMyMap(scoped, view.customers), [scoped, view.customers]);

  // Everything but the lists: what each list toggle would add.
  const beforeLayers = useMemo(
    () =>
      scoped.filter((pin) => {
        const customer = view.customers[pin.customer];
        if (show === "new") return customer.isNew;
        if (show === "notVisited") return customer.tier === 0;
        if (show === "today") return customer.plannedToday;
        return true;
      }),
    [scoped, show, view.customers],
  );
  const layerCounts = useMemo(() => countMyMap(beforeLayers, view.customers), [beforeLayers, view.customers]);

  const shownPins = useMemo(() => beforeLayers.filter((pin) => layers.has(pin.layer)), [beforeLayers, layers]);
  const counts = useMemo(() => countMyMap(shownPins, view.customers), [shownPins, view.customers]);

  const drawn = useMemo<DrawnPin[]>(
    () =>
      shownPins.map((pin) => {
        const customer = view.customers[pin.customer];
        const byVisits = colourBy === "visits";
        return {
          id: pin.id,
          lat: pin.lat,
          lon: pin.lon,
          fill: byVisits ? MY_MAP_TIER_COLOUR[customer.tier] : MY_MAP_LAYER_COLOUR[pin.layer],
          hollow: byVisits && customer.tier === 0,
          isNew: customer.isNew,
          planned: planShown && customer.plannedToday,
          title: customer.name,
        };
      }),
    [colourBy, planShown, shownPins, view.customers],
  );

  const fitKey = JSON.stringify([[...layers].sort(), show, manager, rep, line, needle]);

  const rows = useMemo<MyMapListRow[]>(() => {
    const inView = needle || !mapView ? shownPins : shownPins.filter((pin) => insideBounds(pin, mapView.bounds));
    const seen = new Set<number>();
    const out: MyMapListRow[] = [];
    for (const pin of inView) {
      if (seen.has(pin.customer)) continue;
      seen.add(pin.customer);
      const customer = view.customers[pin.customer];
      out.push({ customer, pin, territory: view.territories[customer.territory] ?? null });
    }
    return out.sort(
      (left, right) => Number(right.customer.plannedToday) - Number(left.customer.plannedToday) || left.customer.name.localeCompare(right.customer.name),
    );
  }, [mapView, needle, shownPins, view.customers, view.territories]);

  // Only a pin still on the map keeps its card open: turning its list off, or filtering it away, closes it.
  const picked = useMemo(() => (pickedId ? shownPins.find((pin) => pin.id === pickedId) ?? null : null), [pickedId, shownPins]);
  const pickedCustomer = picked ? view.customers[picked.customer] : null;

  const pickFromMap = (pinId: string | null) => {
    scrollToCard.current = pinId !== null;
    setPickedId(pinId);
  };

  const showOptions: Array<CrmChoiceOption<Show>> = [
    { value: "all", label: "All customers", note: myMapPerListText(scopedCounts.customers) },
    { value: "new", label: "New this week", note: myMapPerListText(scopedCounts.newThisWeek) },
    { value: "notVisited", label: "Not visited this month", note: myMapPerListText(scopedCounts.notVisited) },
  ];
  if (planShown) showOptions.push({ value: "today", label: "Today's plan", note: myMapPerListText(scopedCounts.plannedToday) });

  const toggleLayer = (layer: MyMapLayer) => {
    setLayers((current) => {
      const next = new Set(current);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  };

  // Every list back on, every customer, every manager, rep and line, and no search — applied at once, not after the pause.
  const showEverything = () => {
    setLayers(new Set(MY_MAP_LAYERS));
    setShow("all");
    setManager("");
    setRep("");
    setLine("");
    setQuery("");
    setSettledQuery("");
  };

  const showOnMap = (pinId: string) => {
    const pin = view.pins.find((candidate) => candidate.id === pinId);
    if (!pin) return;
    focusNonce.current += 1;
    scrollToCard.current = false;
    setPickedId(pin.id);
    setFocus({ id: pin.id, lat: pin.lat, lon: pin.lon, nonce: focusNonce.current });
    mapTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (view.unavailable) {
    return (
      <CrmNote tone="warn" title="My map could not be read just now">
        The customers on your territories did not load, so nothing is drawn rather than an empty map. Refresh in a minute.
      </CrmNote>
    );
  }

  const notes = (
    <>
      {view.planNote ? (
        <CrmNote tone="info" title="Today's plan">
          {view.planNote}
        </CrmNote>
      ) : null}
      {view.plannedWithoutPin > 0 ? (
        <CrmNote tone="neutral">
          {`${plural(view.plannedWithoutPin, "customer", "customers")} in today's plan ${view.plannedWithoutPin === 1 ? "is" : "are"} not validated yet, so ${view.plannedWithoutPin === 1 ? "has" : "have"} no pin.`}
        </CrmNote>
      ) : null}
      {view.unplaced > 0 ? (
        <CrmNote tone="neutral">
          {`${plural(view.unplaced, "place", "places")} of validated customers ${view.unplaced === 1 ? "has" : "have"} no point yet, so ${view.unplaced === 1 ? "it is" : "they are"} counted here and not drawn.`}
        </CrmNote>
      ) : null}
    </>
  );

  if (view.pins.length === 0) {
    return (
      <div className="grid min-w-0 gap-4">
        {notes}
        <CrmPanel eyebrow="My map" title={SCOPE_TITLE[view.scope]}>
          <CrmEmpty message="Each customer is drawn here as soon as they are validated." title="No validated customer on these territories yet" />
        </CrmPanel>
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      {notes}
      <CrmPanel
        description="Every validated customer place, in its list's colour. Tap a pin for directions from where you are."
        eyebrow="My map"
        title={SCOPE_TITLE[view.scope]}
      >
        <CrmBlock>
          <CrmStatGrid>
            <CrmStat label="AM customers" note={plural(counts.places.AM, "AM pin", "AM pins")} value={countText(counts.customers.AM)} />
            <CrmStat label="PM customers" note={plural(counts.places.PM, "PM pin", "PM pins")} value={countText(counts.customers.PM)} />
            <CrmStat label="Pharmacies" note={plural(counts.places.Pharmacy, "pharmacy pin", "pharmacy pins")} value={countText(counts.customers.Pharmacy)} />
            <CrmStat
              label="New this week"
              note="Validated in the last 7 days"
              tone={counts.newThisWeek.AM + counts.newThisWeek.PM + counts.newThisWeek.Pharmacy > 0 ? "good" : "neutral"}
              value={myMapPerListText(counts.newThisWeek)}
            />
          </CrmStatGrid>
        </CrmBlock>

        <CrmBlock
          actions={
            filtered ? (
              <CrmButton onClick={showEverything} size="sm" variant="ghost">
                <RotateCcw aria-hidden className="h-4 w-4" />
                Show everything
              </CrmButton>
            ) : null
          }
          className="border-t border-slate-100"
          title="What the map shows"
        >
          <div className="grid min-w-0 gap-3">
            <div aria-label="Lists on the map" className="grid grid-cols-1 gap-1.5 sm:grid-cols-3" role="group">
              {MY_MAP_LAYERS.map((layer) => {
                const on = layers.has(layer);
                return (
                  <button
                    aria-pressed={on}
                    className={cn(
                      "flex min-h-11 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-none border px-3 py-2 text-left text-sm font-black transition",
                      on ? "border-slate-900 bg-white text-slate-950" : "border-slate-200 bg-slate-50 text-slate-400 hover:border-slate-300",
                    )}
                    key={layer}
                    onClick={() => toggleLayer(layer)}
                    type="button"
                  >
                    <Swatch colour={on ? MY_MAP_LAYER_COLOUR[layer] : "#e2e8f0"} />
                    <span className="min-w-0 flex-1 break-words">{MY_MAP_LAYER_LABEL[layer]}</span>
                    <span className="break-words text-xs font-semibold text-slate-500">{on ? plural(layerCounts.places[layer], "pin", "pins") : "Hidden"}</span>
                  </button>
                );
              })}
            </div>
            <CrmChoice
              className={showOptions.length === 3 ? "[&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1" : undefined}
              columns={showOptions.length === 4 ? 4 : 3}
              label="Which customers"
              onChange={setShow}
              options={showOptions}
              value={show}
            />
            <CrmChoice columns={2} label="Colour the pins by" onChange={setColourBy} options={COLOUR_OPTIONS} value={colourBy} />
            <div className={cn("grid min-w-0 gap-3", FILTER_GRID[filterFields])}>
              <CrmSearchField id="my-map-search" label="Find a customer or brick" onChange={setQuery} placeholder="Name, brick or place" value={query} />
              {showManagers ? (
                <CrmField htmlFor="my-map-manager" label="Manager">
                  <CrmSelect
                    id="my-map-manager"
                    onChange={(event) => {
                      setManager(event.target.value);
                      setRep("");
                    }}
                    value={manager}
                  >
                    <option value="">Every manager</option>
                    {view.managers.map((entry, index) => (
                      <option key={`${entry.name}-${index}`} value={String(index)}>
                        {`${entry.name} · ${entry.title}`}
                      </option>
                    ))}
                  </CrmSelect>
                </CrmField>
              ) : null}
              {showLines ? (
                <CrmField htmlFor="my-map-line" label="Line">
                  <CrmSelect
                    id="my-map-line"
                    onChange={(event) => {
                      setLine(event.target.value);
                      setRep("");
                    }}
                    value={line}
                  >
                    <option value="">Every line</option>
                    {lines.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </CrmSelect>
                </CrmField>
              ) : null}
              {showReps ? (
                <CrmField htmlFor="my-map-rep" label={view.scope === "rep" ? "Territory" : "Rep"}>
                  <CrmSelect id="my-map-rep" onChange={(event) => setRep(event.target.value)} value={rep}>
                    <option value="">{view.scope === "rep" ? "Every territory" : "Every rep"}</option>
                    {territoryChoices.map(({ index, territory }) => (
                      <option key={index} value={String(index)}>
                        {view.scope === "rep" ? territory.name : `${territory.people} · ${territory.name}`}
                      </option>
                    ))}
                  </CrmSelect>
                </CrmField>
              ) : null}
            </div>
          </div>
        </CrmBlock>

        <CrmBlock className="border-t border-slate-100">
          <div className="min-w-0 scroll-mt-4" ref={mapTopRef}>
            {shownPins.length === 0 ? (
              <CrmNote className="mb-3" tone="neutral" title="No pin matches what is picked">
                <p>Clear the search, choose All customers, or turn a list back on.</p>
                <CrmButton className="mt-2" onClick={showEverything} size="sm">
                  <RotateCcw aria-hidden className="h-4 w-4" />
                  Show everything
                </CrmButton>
              </CrmNote>
            ) : null}
            <MyMapCanvas
              browserKey={browserKey}
              fitKey={fitKey}
              focus={focus}
              onPick={pickFromMap}
              onView={setMapView}
              pickedId={pickedId}
              pins={drawn}
            />
            {picked && pickedCustomer ? (
              <div className="mt-3 min-w-0 scroll-mt-4" ref={cardRef}>
                <MyMapPinCard
                  customer={pickedCustomer}
                  onClose={() => setPickedId(null)}
                  pin={picked}
                  showTerritory={view.scope !== "rep"}
                  territory={view.territories[pickedCustomer.territory] ?? null}
                />
              </div>
            ) : null}
            <Legend colourBy={colourBy} planShown={planShown} />
          </div>
        </CrmBlock>
      </CrmPanel>

      <CrmPanel
        description={
          needle
            ? `Every customer matching the search, wherever they are: ${myMapPerListText(counts.customers)}.`
            : "The customers in the part of the map on screen. Move or zoom the map and the list follows."
        }
        title={needle ? "Customers matching the search" : "Customers on this part of the map"}
      >
        <MyMapList key={fitKey} onShow={showOnMap} rows={rows} showTerritory={view.scope !== "rep"} />
      </CrmPanel>
    </div>
  );
}
