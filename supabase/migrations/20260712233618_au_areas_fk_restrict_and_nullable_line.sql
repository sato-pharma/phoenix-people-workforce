-- Incident-proofing (root cause of the July-7 ~70-rep data loss): every area_id FK was
-- ON DELETE SET NULL, so deleting an area silently blanked dependents. Flip all to
-- ON DELETE RESTRICT so a delete that still has references ERRORS instead of nulling.
-- Also make areas.line_id nullable so the 42 canonical areas can be line-independent.
alter table public.coaching_reports  drop constraint coaching_reports_area_id_fkey;
alter table public.coaching_reports  add  constraint coaching_reports_area_id_fkey  foreign key (area_id) references public.areas(id) on update cascade on delete restrict;
alter table public.employee_history  drop constraint employee_history_area_id_fkey;
alter table public.employee_history  add  constraint employee_history_area_id_fkey  foreign key (area_id) references public.areas(id) on delete restrict;
alter table public.employees         drop constraint employees_area_id_fkey;
alter table public.employees         add  constraint employees_area_id_fkey         foreign key (area_id) references public.areas(id) on delete restrict;
alter table public.job_offers        drop constraint job_offers_area_id_fkey;
alter table public.job_offers        add  constraint job_offers_area_id_fkey        foreign key (area_id) references public.areas(id) on update cascade on delete restrict;
alter table public.marketing_customers  drop constraint marketing_customers_area_id_fkey;
alter table public.marketing_customers  add  constraint marketing_customers_area_id_fkey  foreign key (area_id) references public.areas(id) on update cascade on delete restrict;
alter table public.marketing_pharmacies drop constraint marketing_pharmacies_area_id_fkey;
alter table public.marketing_pharmacies add  constraint marketing_pharmacies_area_id_fkey foreign key (area_id) references public.areas(id) on update cascade on delete restrict;
alter table public.marketing_requests   drop constraint marketing_requests_area_id_fkey;
alter table public.marketing_requests   add  constraint marketing_requests_area_id_fkey   foreign key (area_id) references public.areas(id) on update cascade on delete restrict;
alter table public.position_vacancies   drop constraint position_vacancies_area_id_fkey;
alter table public.position_vacancies   add  constraint position_vacancies_area_id_fkey   foreign key (area_id) references public.areas(id) on delete restrict;
alter table public.positions            drop constraint positions_area_id_fkey;
alter table public.positions            add  constraint positions_area_id_fkey            foreign key (area_id) references public.areas(id) on delete restrict;

alter table public.areas alter column line_id drop not null;
