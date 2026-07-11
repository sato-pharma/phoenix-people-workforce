-- PostgreSQL cannot rename function input parameters with CREATE OR REPLACE.
-- The following migration recreates this RPC with corrected parameter names.

drop function if exists public.phx_resign_employee_and_open_vacancy(text,date,date,text,text,text,text,text,text);
