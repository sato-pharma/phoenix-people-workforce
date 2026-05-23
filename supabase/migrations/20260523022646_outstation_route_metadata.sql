alter table public.outstation_expense_requests
  add column if not exists route_alternatives_json jsonb not null default '[]'::jsonb,
  add column if not exists selected_route_index integer,
  add column if not exists selected_route_reason text,
  add column if not exists route_error text;

update public.outstation_expense_requests
set
  route_alternatives_json = case
    when route_alternatives_json is null
      or jsonb_typeof(route_alternatives_json) <> 'array'
      or route_alternatives_json = '[]'::jsonb
    then case
      when route_polyline is not null and btrim(route_polyline) <> '' then jsonb_build_array(
        jsonb_build_object(
          'distanceKm', distance_from_residence_km,
          'durationInTrafficMinutes', null,
          'durationMinutes', duration_minutes,
          'encodedPolyline', route_polyline,
          'index', 0,
          'isSelected', true,
          'summary', 'Persisted selected route'
        )
      )
      else '[]'::jsonb
    end
    else route_alternatives_json
  end,
  selected_route_index = case
    when selected_route_index is null
      and route_polyline is not null
      and btrim(route_polyline) <> ''
    then 0
    else selected_route_index
  end,
  selected_route_reason = case
    when selected_route_reason is null
      and route_polyline is not null
      and btrim(route_polyline) <> ''
    then 'fastest_duration'
    else selected_route_reason
  end;

alter table public.outstation_expense_requests
  alter column route_alternatives_json set default '[]'::jsonb,
  alter column route_alternatives_json set not null;

notify pgrst, 'reload schema';
