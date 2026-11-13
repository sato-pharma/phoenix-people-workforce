alter table public.geo_trip_routes
  add column if not exists route_polyline text;
