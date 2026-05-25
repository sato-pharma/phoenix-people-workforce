create table if not exists public.sales_area_region_codes (
  area_code text primary key,
  area_name text not null,
  normalized_area_name text not null,
  region_code text not null,
  region_name text not null,
  normalized_region_name text not null,
  source_file text not null default 'Area-Regions codes.xlsx',
  source_sheet text not null default 'Sheet1',
  source_row_number integer null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_area_region_codes_area_code_not_blank check (btrim(area_code) <> ''),
  constraint sales_area_region_codes_area_name_not_blank check (btrim(area_name) <> ''),
  constraint sales_area_region_codes_region_code_not_blank check (btrim(region_code) <> ''),
  constraint sales_area_region_codes_region_name_not_blank check (btrim(region_name) <> ''),
  constraint sales_area_region_codes_normalized_area_name_not_blank check (btrim(normalized_area_name) <> ''),
  constraint sales_area_region_codes_normalized_region_name_not_blank check (btrim(normalized_region_name) <> '')
);

create table if not exists public.sales_product_codes (
  product_code text primary key,
  product_name text not null,
  normalized_product_name text not null,
  factory_price numeric(14, 6) not null default 0,
  family text not null,
  family_code text not null,
  source text not null,
  line text not null,
  normalized_line text not null,
  source_file text not null default 'phoenix products.xlsx',
  source_sheet text not null default 'Products',
  source_row_number integer null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_product_codes_product_code_not_blank check (btrim(product_code) <> ''),
  constraint sales_product_codes_product_name_not_blank check (btrim(product_name) <> ''),
  constraint sales_product_codes_normalized_product_name_not_blank check (btrim(normalized_product_name) <> ''),
  constraint sales_product_codes_factory_price_non_negative check (factory_price >= 0),
  constraint sales_product_codes_family_not_blank check (btrim(family) <> ''),
  constraint sales_product_codes_family_code_not_blank check (btrim(family_code) <> ''),
  constraint sales_product_codes_source_not_blank check (btrim(source) <> ''),
  constraint sales_product_codes_line_not_blank check (btrim(line) <> ''),
  constraint sales_product_codes_normalized_line_not_blank check (btrim(normalized_line) <> '')
);

create table if not exists public.sales_distributor_codes (
  distributor_code text primary key,
  distributor_name text not null,
  normalized_distributor_name text not null,
  source_file text not null default 'phoenix products.xlsx',
  source_sheet text not null default 'Distrubutors',
  source_row_number integer null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_distributor_codes_code_not_blank check (btrim(distributor_code) <> ''),
  constraint sales_distributor_codes_name_not_blank check (btrim(distributor_name) <> ''),
  constraint sales_distributor_codes_normalized_name_not_blank check (btrim(normalized_distributor_name) <> '')
);

create unique index if not exists sales_area_region_codes_normalized_area_name_key
  on public.sales_area_region_codes (normalized_area_name);

create index if not exists sales_area_region_codes_region_code_idx
  on public.sales_area_region_codes (region_code);

create unique index if not exists sales_product_codes_normalized_product_name_key
  on public.sales_product_codes (normalized_product_name);

create index if not exists sales_product_codes_line_idx
  on public.sales_product_codes (normalized_line);

create index if not exists sales_product_codes_family_code_idx
  on public.sales_product_codes (family_code);

create unique index if not exists sales_distributor_codes_normalized_name_key
  on public.sales_distributor_codes (normalized_distributor_name);

insert into public.sales_area_region_codes (
  area_code,
  area_name,
  normalized_area_name,
  region_code,
  region_name,
  normalized_region_name,
  source_row_number
) values
  ('CA1', 'Heliopolis', lower('Heliopolis'), 'CA', 'Cairo', lower('Cairo'), 2),
  ('CA2', 'Nasr City', lower('Nasr City'), 'CA', 'Cairo', lower('Cairo'), 3),
  ('CA3', 'Cairo East 1', lower('Cairo East 1'), 'CA', 'Cairo', lower('Cairo'), 4),
  ('CA4', 'Cairo East 2', lower('Cairo East 2'), 'CA', 'Cairo', lower('Cairo'), 5),
  ('CA5', 'Down town', lower('Down town'), 'CA', 'Cairo', lower('Cairo'), 6),
  ('CA6', 'Cairo West', lower('Cairo West'), 'CA', 'Cairo', lower('Cairo'), 7),
  ('GZ1', 'Giza - Giza Centers', lower('Giza - Giza Centers'), 'GZ', 'Giza', lower('Giza'), 8),
  ('GZ2', 'Dokki - Mohandseen - Bolak', lower('Dokki - Mohandseen - Bolak'), 'GZ', 'Giza', lower('Giza'), 9),
  ('GZ3', 'Imbaba - Imbaba Centers', lower('Imbaba - Imbaba Centers'), 'GZ', 'Giza', lower('Giza'), 10),
  ('GZ4', 'Haram - Faisal', lower('Haram - Faisal'), 'GZ', 'Giza', lower('Giza'), 11),
  ('GZ5', 'Helwan-Maadi', lower('Helwan-Maadi'), 'GZ', 'Giza', lower('Giza'), 12),
  ('GZ6', 'Fayoum-Beni Suef', lower('Fayoum-Beni Suef'), 'GZ', 'Giza', lower('Giza'), 13),
  ('GZ7', 'October -Zayed', lower('October -Zayed'), 'GZ', 'Giza', lower('Giza'), 14),
  ('UE1', 'Minia 1', lower('Minia 1'), 'UE', 'Upper Egypt', lower('Upper Egypt'), 15),
  ('UE2', 'Minia 2', lower('Minia 2'), 'UE', 'Upper Egypt', lower('Upper Egypt'), 16),
  ('UE3', 'Assuit 1', lower('Assuit 1'), 'UE', 'Upper Egypt', lower('Upper Egypt'), 17),
  ('UE4', 'Assuit 2', lower('Assuit 2'), 'UE', 'Upper Egypt', lower('Upper Egypt'), 18),
  ('UE5', 'Sohag1', lower('Sohag1'), 'UE', 'Upper Egypt', lower('Upper Egypt'), 19),
  ('UE6', 'Sohag2', lower('Sohag2'), 'UE', 'Upper Egypt', lower('Upper Egypt'), 20),
  ('UE7', 'Qena 1', lower('Qena 1'), 'UE', 'Upper Egypt', lower('Upper Egypt'), 21),
  ('UE8', 'Qena 2', lower('Qena 2'), 'UE', 'Upper Egypt', lower('Upper Egypt'), 22),
  ('AB1', 'Alex East', lower('Alex East'), 'AB', 'Alex-BHR', lower('Alex-BHR'), 23),
  ('AB2', 'Alex Center', lower('Alex Center'), 'AB', 'Alex-BHR', lower('Alex-BHR'), 24),
  ('AB3', 'Alex West', lower('Alex West'), 'AB', 'Alex-BHR', lower('Alex-BHR'), 25),
  ('AB4', 'Behira 1', lower('Behira 1'), 'AB', 'Alex-BHR', lower('Alex-BHR'), 26),
  ('AB5', 'Behira 2', lower('Behira 2'), 'AB', 'Alex-BHR', lower('Alex-BHR'), 27),
  ('D11', 'Qalubeya', lower('Qalubeya'), 'D1', 'Delta (1)', lower('Delta (1)'), 28),
  ('D12', 'Menoufia 1', lower('Menoufia 1'), 'D1', 'Delta (1)', lower('Delta (1)'), 29),
  ('D13', 'Menoufia 2', lower('Menoufia 2'), 'D1', 'Delta (1)', lower('Delta (1)'), 30),
  ('D14', 'Gharbia 1 (Tanta)', lower('Gharbia 1 (Tanta)'), 'D1', 'Delta (1)', lower('Delta (1)'), 31),
  ('D15', 'Gharbia 2 (Mahalla)', lower('Gharbia 2 (Mahalla)'), 'D1', 'Delta (1)', lower('Delta (1)'), 32),
  ('D16', 'Kafr El-Sheikh 1', lower('Kafr El-Sheikh 1'), 'D1', 'Delta (1)', lower('Delta (1)'), 33),
  ('D17', 'Kafr El-Sheikh 2', lower('Kafr El-Sheikh 2'), 'D1', 'Delta (1)', lower('Delta (1)'), 34),
  ('D21', 'Dakahlia 1', lower('Dakahlia 1'), 'D2', 'Delta (2)', lower('Delta (2)'), 35),
  ('D22', 'Dakahlia 2', lower('Dakahlia 2'), 'D2', 'Delta (2)', lower('Delta (2)'), 36),
  ('D23', 'Dakahlia 3', lower('Dakahlia 3'), 'D2', 'Delta (2)', lower('Delta (2)'), 37),
  ('D24', 'Sharkia 1', lower('Sharkia 1'), 'D2', 'Delta (2)', lower('Delta (2)'), 38),
  ('D25', 'Sharkia 2', lower('Sharkia 2'), 'D2', 'Delta (2)', lower('Delta (2)'), 39),
  ('D26', 'Port said - Domiat', lower('Port said - Domiat'), 'D2', 'Delta (2)', lower('Delta (2)'), 40),
  ('OT1', 'North Sinai', lower('North Sinai'), 'OT', 'Others', lower('Others'), 41),
  ('OT2', 'Suez/ South Sinai', lower('Suez/ South Sinai'), 'OT', 'Others', lower('Others'), 42),
  ('OT3', 'Aswan', lower('Aswan'), 'OT', 'Others', lower('Others'), 43)
on conflict (area_code) do update set
  area_name = excluded.area_name,
  normalized_area_name = excluded.normalized_area_name,
  region_code = excluded.region_code,
  region_name = excluded.region_name,
  normalized_region_name = excluded.normalized_region_name,
  source_file = excluded.source_file,
  source_sheet = excluded.source_sheet,
  source_row_number = excluded.source_row_number,
  active = true,
  updated_at = now();

insert into public.sales_product_codes (
  product_code,
  product_name,
  normalized_product_name,
  factory_price,
  family,
  family_code,
  source,
  line,
  normalized_line,
  source_row_number
) values
  ('TE001', 'Tebofrtin drops', lower('Tebofrtin drops'), 53.28, 'Tebofortin', 'TE', 'Marcyl', 'CNS', lower('CNS'), 2),
  ('TE002', 'Tebofortine Forte 80', lower('Tebofortine Forte 80'), 97.69, 'Tebofortin', 'TE', 'Marcyl', 'CNS', lower('CNS'), 3),
  ('TE003', 'Tebofortine 40 mg', lower('Tebofortine 40 mg'), 71.05, 'Tebofortin', 'TE', 'Marcyl', 'CNS', lower('CNS'), 4),
  ('TE004', 'Tebofortin 240 mg max', lower('Tebofortin 240 mg max'), 150.9, 'Tebofortin', 'TE', 'Marcyl', 'CNS', lower('CNS'), 5),
  ('TE005', 'Tebofortin 120 mg Intens', lower('Tebofortin 120 mg Intens'), 124.342105, 'Tebofortin', 'TE', 'Marcyl', 'CNS', lower('CNS'), 6),
  ('RI001', 'Rispadex 3 mg UPA', lower('Rispadex 3 mg UPA'), 35.7, 'Rispadex', 'RI', 'Marcyl', 'CNS', lower('CNS'), 7),
  ('RI002', 'Rispadex 3 mg', lower('Rispadex 3 mg'), 36.72, 'Rispadex', 'RI', 'Marcyl', 'CNS', lower('CNS'), 8),
  ('RI003', 'Rispadex 1mg Syp', lower('Rispadex 1mg Syp'), 23.76, 'Rispadex', 'RI', 'Marcyl', 'CNS', lower('CNS'), 9),
  ('DO001', 'Dopaminict 1mg UPA', lower('Dopaminict 1mg UPA'), 35.7, 'Dopaminict', 'DO', 'Marcyl', 'CNS', lower('CNS'), 10),
  ('DO002', 'Dopaminect 1mg', lower('Dopaminect 1mg'), 36.45, 'Dopaminict', 'DO', 'Marcyl', 'CNS', lower('CNS'), 11),
  ('DO003', 'Dolabactin', lower('Dolabactin'), 54, 'Dolabactin', 'DO', 'Marcyl', 'CNS', lower('CNS'), 12),
  ('CO001', 'Conviban 50 mg', lower('Conviban 50 mg'), 36.72, 'Conviban', 'CO', 'Marcyl', 'CNS', lower('CNS'), 13),
  ('CO002', 'Conviban 25mg/ml Syp', lower('Conviban 25mg/ml Syp'), 37.8, 'Conviban', 'CO', 'Marcyl', 'CNS', lower('CNS'), 14),
  ('CO003', 'Conviban 25 mg', lower('Conviban 25 mg'), 28.08, 'Conviban', 'CO', 'Marcyl', 'CNS', lower('CNS'), 15),
  ('CO004', 'Conviban 100 mg', lower('Conviban 100 mg'), 36, 'Conviban', 'CO', 'Marcyl', 'CNS', lower('CNS'), 16),
  ('SA001', 'Saginko', lower('Saginko'), 126.72, 'Saginko', 'SA', 'Sato', 'Anti infective', lower('Anti infective'), 17),
  ('RO001', 'Royafloxacin', lower('Royafloxacin'), 60.7, 'Royafloxacin', 'RO', 'Sato', 'Anti infective', lower('Anti infective'), 18),
  ('IV001', 'Ivyronc', lower('Ivyronc'), 30.375, 'Ivyronc', 'IV', 'Sato', 'Pedia', lower('Pedia'), 19),
  ('GU001', 'Guamusin', lower('Guamusin'), 60.75, 'Guamusin', 'GU', 'Sato', 'Pedia', lower('Pedia'), 20),
  ('LA001', 'Lacto Advanced 1', lower('Lacto Advanced 1'), 225.06, 'Lacto', 'LA', 'Lacto', 'Pedia', lower('Pedia'), 21),
  ('LA002', 'Lacto Advanced 2', lower('Lacto Advanced 2'), 225.06, 'Lacto', 'LA', 'Lacto', 'Pedia', lower('Pedia'), 22)
on conflict (product_code) do update set
  product_name = excluded.product_name,
  normalized_product_name = excluded.normalized_product_name,
  factory_price = excluded.factory_price,
  family = excluded.family,
  family_code = excluded.family_code,
  source = excluded.source,
  line = excluded.line,
  normalized_line = excluded.normalized_line,
  source_file = excluded.source_file,
  source_sheet = excluded.source_sheet,
  source_row_number = excluded.source_row_number,
  active = true,
  updated_at = now();

insert into public.sales_distributor_codes (
  distributor_code,
  distributor_name,
  normalized_distributor_name,
  source_row_number
) values
  ('EG', 'EGD', lower('EGD'), 2),
  ('IS', 'Ibn sina', lower('Ibn sina'), 3),
  ('PS', 'overseas', lower('overseas'), 4),
  ('SF', 'sofico', lower('sofico'), 5),
  ('RM', 'ramco', lower('ramco'), 6),
  ('MC', 'mec', lower('mec'), 7),
  ('EP', 'epda', lower('epda'), 8),
  ('CP', 'chimipharm', lower('chimipharm'), 9)
on conflict (distributor_code) do update set
  distributor_name = excluded.distributor_name,
  normalized_distributor_name = excluded.normalized_distributor_name,
  source_file = excluded.source_file,
  source_sheet = excluded.source_sheet,
  source_row_number = excluded.source_row_number,
  active = true,
  updated_at = now();

alter table public.sales_area_region_codes enable row level security;
alter table public.sales_product_codes enable row level security;
alter table public.sales_distributor_codes enable row level security;

revoke all on table public.sales_area_region_codes from anon;
revoke all on table public.sales_product_codes from anon;
revoke all on table public.sales_distributor_codes from anon;

grant select on table public.sales_area_region_codes to authenticated;
grant select on table public.sales_product_codes to authenticated;
grant select on table public.sales_distributor_codes to authenticated;

grant select, insert, update, delete on table public.sales_area_region_codes to service_role;
grant select, insert, update, delete on table public.sales_product_codes to service_role;
grant select, insert, update, delete on table public.sales_distributor_codes to service_role;

drop policy if exists sales_area_region_codes_authenticated_read on public.sales_area_region_codes;
create policy sales_area_region_codes_authenticated_read
on public.sales_area_region_codes
for select
to authenticated
using (true);

drop policy if exists sales_product_codes_authenticated_read on public.sales_product_codes;
create policy sales_product_codes_authenticated_read
on public.sales_product_codes
for select
to authenticated
using (true);

drop policy if exists sales_distributor_codes_authenticated_read on public.sales_distributor_codes;
create policy sales_distributor_codes_authenticated_read
on public.sales_distributor_codes
for select
to authenticated
using (true);

notify pgrst, 'reload schema';
