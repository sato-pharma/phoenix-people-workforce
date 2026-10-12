/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic PostgREST rows have no fixed schema */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { reconcileVacancyRowsAgainstOccupancy,seatKeysOfActiveEmployees,stripRestrictedColumns } from '../src/phoenix-policy.mjs';
import type { Loaders } from '../src/source-collect.mts';

// A synthetic PHOENIX SOURCE: a real PostgreSQL database with production-shaped tables and the real
// watermark function, fronted by a minimal PostgREST-compatible HTTP server (filters, limit/offset,
// Content-Range, the row cap, RPCs, injectable faults). The stand-in loaders below read it through the
// real global fetch exactly the way Phoenix's loaders do, INCLUDING their habits: a read-through cache
// that serves stale on failure, an employee read whose failure is logged and swallowed, a soft-failing
// lookup. Only synthetic data; nothing here reaches a real environment.
const DDL=`
create schema au;
create table public.employees(hr_id text primary key,full_name text,job_title text,employment_status text,manager_hr_id text,last_working_date date,organogram_visible boolean default true,updated_at timestamptz default now());
create table public.departments(id int primary key,name text,updated_at timestamptz default now());
create table public.lines(id int primary key,name text,updated_at timestamptz default now());
create table public.areas(id int primary key,name text,updated_at timestamptz default now());
create table public.positions(id int primary key,title text,updated_at timestamptz default now());
create table public.teams(id int primary key,name text,updated_at timestamptz default now());
create table public.position_vacancies(id bigint primary key,status text,position_title text,job_title text,department_name text,line_name text,area_name text,manager_hr_id text,updated_at timestamptz default now());
create table public.offers(id uuid primary key default gen_random_uuid(),updated_at timestamptz default now());
create table public.app_auth_users(login_id text primary key,updated_at timestamptz default now());
create table au.seats(seat_id text primary key,parent_seat_id text,seat_tier text,line_name text,area_name text,is_other_pseudo_dm boolean default false);
create table au.occupancy_history(occupancy_id bigserial primary key,seat_id text,occupant_hr_id text,effective_to date,created_at timestamptz default now());
create table au.canonical_areas(area_code text primary key);
create table au.regions(region_code text primary key);
create table au.lines(line_code text primary key);
create table au.line_area_map(line_code text,area_code text,effective_from date,primary key(line_code,area_code,effective_from));
create view public.au_v_org_tree as select s.seat_id,s.parent_seat_id,s.seat_tier,s.line_name,s.area_name,s.is_other_pseudo_dm,o.occupant_hr_id,(o.occupant_hr_id is null) as is_vacant from au.seats s left join au.occupancy_history o on o.seat_id=s.seat_id and o.effective_to is null;
create table public.monthly_closing_publications(id uuid primary key default gen_random_uuid(),line text,normalized_line text,period text,published_at timestamptz default now(),unpublished_at timestamptz);
create table public.monthly_closing_locks(id uuid primary key default gen_random_uuid(),locked_at timestamptz default now());
create table public.source_of_sales_import_batches(id uuid primary key default gen_random_uuid(),updated_at timestamptz default now());
create table public.source_of_sales_import_rows(id bigserial primary key,created_at timestamptz default now(),invoice_period text);
create table public.source_of_sales_fact_rollup(id bigserial primary key,created_at timestamptz default now(),period text,line text,area_code text,channel text,units numeric,value numeric);
create table public.source_of_sales_channel_customer_rollup(id bigserial primary key,period text);
create table public.source_of_sales_distributor_product_rollup(id bigserial primary key,period text);
create table public.source_of_sales_customer_map(id bigserial primary key,updated_at timestamptz default now());
create table public.source_of_sales_bricks(brick_id text primary key,updated_at timestamptz default now());
create table public.source_of_sales_regions(region_code text primary key,updated_at timestamptz default now());
create table public.source_of_sales_areas(area_code text primary key,updated_at timestamptz default now());
create table public.source_of_sales_distributors(distributor_code text primary key,updated_at timestamptz default now());
create table public.source_of_sales_products(product_code text primary key,updated_at timestamptz default now());
create table public.source_of_sales_product_price_history(product_code text,effective_period text,created_at timestamptz default now(),primary key(product_code,effective_period));
create table au.monthly_targets(id uuid primary key default gen_random_uuid(),period text,line_code text,target_value numeric,updated_at timestamptz default now());
create table au.monthly_store_split_net(period text,line_code text,area_code text,product_code text,computed_at timestamptz default now(),primary key(period,line_code,area_code,product_code));
create table au.direct_region_allocation(line_code text,sos_region_code text,target_region_code text,updated_at timestamptz default now(),primary key(line_code,sos_region_code,target_region_code));
create table public.unwatched_notes(id int primary key,body text);
`;
const READABLE=new Set(['employees','departments','lines','areas','positions','teams','position_vacancies','offers','au_v_org_tree','monthly_closing_publications','unwatched_notes','source_of_sales_fact_rollup']);

export async function createSourceHost(pg:{connect:(db:string)=>postgres.Sql;exec:(q:string)=>Promise<void>},opts:{cap?:number}={}){
 await pg.exec('create database phoenix_src');
 const db=pg.connect('phoenix_src');
 // Supabase provides service_role; a bare cluster does not.
 await pg.exec("do $$ begin if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$");
 await db.unsafe(DDL).simple();
 await db.unsafe(readFileSync('proposal/source-watermark.sql','utf8')).simple();
 const faults=new Map<string,'500'|'reset'>();
 const hooks:{onRead?:(relation:string)=>Promise<void>|void}={};
 const cap=opts.cap??1000;
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url!,'http://source');
   const m=/^\/rest\/v1\/(rpc\/)?([a-z_0-9]+)$/.exec(url.pathname);
   if(!m){res.writeHead(404).end('{}');return;}
   const [,isRpc,rel]=m;
   await hooks.onRead?.(rel);
   const fault=faults.get(rel);
   if(fault==='reset'){req.socket.destroy();return;}
   if(fault==='500'){res.writeHead(500,{'content-type':'application/json'}).end('{"message":"synthetic failure"}');return;}
   let rows:readonly unknown[];
   let offset=0;
   if(isRpc){
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);
    const args=JSON.parse(Buffer.concat(chunks).toString()||'{}');
    if(rel==='phoenix_mcp_source_watermark')rows=await db`select source,rows,stamp,digest from public.phoenix_mcp_source_watermark(${args.p_sources}::text[],${args.p_period??null})`;
    else if(rel==='phx_closing_customers')rows=await db`select line,area_code,channel,units,value from public.source_of_sales_fact_rollup where period=${args.p_period} and line=${args.p_line}`;
    else if(rel==='phx_monthly_targets')rows=await db`select line_code,target_value from au.monthly_targets where period=${args.p_period}`;
    else{res.writeHead(404).end('{}');return;}
   }else{
    if(!READABLE.has(rel)){res.writeHead(404).end('{}');return;}
    const conds:string[]=[];const vals:string[]=[];
    for(const [k,v] of url.searchParams){
     if(['select','order','limit','offset'].includes(k))continue;
     if(!/^[a-z_]+$/.test(k))throw Error('bad column');
     if(v==='is.null')conds.push(`${k} is null`);else if(v.startsWith('eq.')){vals.push(v.slice(3));conds.push(`${k}::text = $${vals.length}`);}
    }
    offset=Number(url.searchParams.get('offset')??0);
    const limit=Math.min(Number(url.searchParams.get('limit')??cap),cap);
    rows=await db.unsafe(`select to_jsonb(t) as j from (select * from public.${rel} ${conds.length?'where '+conds.join(' and '):''} order by 1 offset ${offset} limit ${limit}) t`,vals).then(r=>r.map(x=>x.j));
   }
   const range=rows.length?`${offset}-${offset+rows.length-1}/*`:'*/0';
   res.writeHead(200,{'content-type':'application/json','content-range':range}).end(JSON.stringify(rows));
  }catch(error){res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({message:String(error)}));}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const rest=async(path:string)=>{const r=await fetch(`${base}/rest/v1/${path}`);if(!r.ok)throw new Error(`source read failed: ${r.status}`);return await r.json() as Record<string,any>[];};
 // Same shape as supabase-js's rpc(): { data, error }.
 const client={rpc:async(name:string,args:unknown)=>{const r=await fetch(`${base}/rest/v1/rpc/${name}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)});return r.ok?{data:await r.json(),error:null}:{data:null,error:{message:'rpc failed'}};}};

 // ---- Stand-in loaders, with Phoenix's real habits -------------------------------------------
 const state={clock:()=>Date.now(),directoryCache:null as null|{at:number;data:Record<string,any>[]}};
 const pageAll=async(path:string)=>{const out:Record<string,any>[]=[];for(let o=0;;o+=500){const page=await rest(`${path}${path.includes('?')?'&':'?'}limit=500&offset=${o}`);out.push(...page);if(page.length<500)return out;}};
 const loaders:Loaders&{invalidate():void;unpagedOrganization():Promise<{organogramRows:unknown[]}>}={
  invalidate(){state.directoryCache=null;},
  async employees(){
   // getEmployeeDirectory: 30s cache, and on a failed load it serves what it has.
   if(state.directoryCache&&state.clock()-state.directoryCache.at<30000)return state.directoryCache.data.map(toEmployee);
   try{
    const data=await pageAll('employees');
    await Promise.all(['departments','lines','areas','positions','teams'].map(t=>rest(t)));
    state.directoryCache={at:state.clock(),data};return data.map(toEmployee);
   }catch(error){if(state.directoryCache)return state.directoryCache.data.map(toEmployee);throw error;}
  },
  async organization(){return {organogramRows:await buildOrganization(()=>pageAll('au_v_org_tree'))};},
  async unpagedOrganization(){return {organogramRows:await buildOrganization(()=>rest('au_v_org_tree'))};},
  async vacancies(){
   const org=await buildOrganization(()=>pageAll('au_v_org_tree'));
   const raw=(await rest('position_vacancies')).map(v=>({id:Number(v.id),status:v.status,jobTitle:v.job_title,positionTitle:v.position_title,departmentName:v.department_name,lineName:v.line_name,areaName:v.area_name,managerHrId:v.manager_hr_id}));
   return {rows:reconcileVacancyRowsAgainstOccupancy(raw,seatKeysOfActiveEmployees(org))};
  },
  async lines(){return ['CNS'];},
  async publication(line,period){
   const rows=await rest(`monthly_closing_publications?normalized_line=eq.${line.toLowerCase()}&period=eq.${period}&unpublished_at=is.null`);
   if(rows.length>1)throw new Error('ambiguous publication');
   return rows[0]?{publishedAt:new Date(rows[0].published_at).toISOString(),revision:String(rows[0].id)}:null;
  },
  async closing(line,period){
   const facts=await client.rpc('phx_closing_customers',{p_line:line,p_period:period});if(facts.error)throw new Error('closing failed');
   const targets=await client.rpc('phx_monthly_targets',{p_period:period});if(targets.error)throw new Error('targets failed');
   const sum=(rows:any[])=>rows.reduce((t,r)=>t+Number(r.value),0);
   const all=facts.data as any[];
   // The engine's grand total is the distributor-fed sales; the COMPANY total adds direct orders. The
   // Office channel is already spread over areas inside `all`, so it is counted once.
   const grand=sum(all.filter(r=>r.channel!=='direct')),company=sum(all);
   const target=(targets.data as any[]).reduce((t,r)=>t+Number(r.target_value),0);
   const cell=(salesValue:number)=>({salesUnits:0,salesValue,targetUnits:0,targetValue:target,achievementPct:target?salesValue/target*100:0});
   const matrix={line,period,availableLines:[line],availablePeriods:[period],columns:[],regions:[],grandTotal:{kind:'grandTotal',cells:[],rowTotal:cell(grand)},companyTotal:{kind:'companyTotal',cells:[],rowTotal:cell(company)}};
   return {line,selectedPeriod:period,awaitingPublish:false,matrix:stripRestrictedColumns(matrix)};
  },
 };
 // Phoenix's organogram seat source: an ACTING_DM is emitted ONCE from its acting seat and the same
 // person's own REP seat is dropped; the per-line "Others" pseudo-DM holds no people.
 async function buildOrganization(read:()=>Promise<Record<string,any>[]>){
  const tree=await read();
  // Employee master joined for names. A failed read is logged and swallowed, as the real source does.
  let names=new Map<string,string>();
  try{names=new Map((await pageAll('employees')).map(e=>[String(e.hr_id).toLowerCase(),e.full_name as string]));}catch{console.error('organogram: the employee master could not be read');}
  try{await rest('teams');}catch{/* fails soft, as in Phoenix */}
  const acting=new Set(tree.filter(s=>s.seat_tier==='ACTING_DM'&&s.occupant_hr_id).map(s=>String(s.occupant_hr_id).toLowerCase()));
  const dropped=(s:Record<string,any>)=>s.is_other_pseudo_dm||(s.seat_tier==='REP'&&s.occupant_hr_id&&acting.has(String(s.occupant_hr_id).toLowerCase()));
  const nodeKey=(s:Record<string,any>)=>s.occupant_hr_id?String(s.occupant_hr_id).trim():s.seat_id as string;
  const bySeat=new Map(tree.map(s=>[s.seat_id as string,s]));
  const title:Record<string,string>={NSM:'National Sales Manager',RM:'Regional Manager',DM:'District Manager',ACTING_DM:'District Manager',REP:'Medical Rep'};
  const parentKey=(s:Record<string,any>):string|null=>{let p=s.parent_seat_id?bySeat.get(s.parent_seat_id):undefined;while(p&&dropped(p))p=p.parent_seat_id?bySeat.get(p.parent_seat_id):undefined;return p?nodeKey(p):null;};
  return tree.filter(s=>!dropped(s)).map(s=>({hrId:nodeKey(s),seatId:s.seat_id,managerHrId:parentKey(s),jobTitle:title[s.seat_tier],positionTitle:title[s.seat_tier],
   fullName:s.occupant_hr_id?(names.get(String(s.occupant_hr_id).toLowerCase())??String(s.occupant_hr_id)):null,displayName:s.occupant_hr_id?(names.get(String(s.occupant_hr_id).toLowerCase())??String(s.occupant_hr_id)):'Vacant',
   departmentName:'Sales',lineName:s.line_name,areaName:s.area_name,type:s.occupant_hr_id?'employee':'vacancy'}));
 }
 function toEmployee(e:Record<string,any>){return {hrId:e.hr_id,managerHrId:e.manager_hr_id,fullName:e.full_name,jobTitle:e.job_title,positionTitle:null,nodeType:null,recordType:null,businessType:null,employeeType:null,employmentStatus:e.employment_status,organogramVisible:e.organogram_visible,department:'Sales',line:'CNS'};}

 return {db,base,faults,hooks,client,state,loaders,rest,
  async close(){await new Promise(r=>server.close(r));server.closeAllConnections?.();await db.end({timeout:2});}};
}
