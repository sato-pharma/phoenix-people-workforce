// Production-shaped, synthetic PostgREST responses. Unknown reads fail, never become [].
import assert from 'node:assert/strict';
import { config,subject } from './fixtures.mts';
export function sourceFixture(){
 const lines=['Anti Infective','CNS','Pedia'];
 const employee=(id,title)=>({hr_id:id,full_name:'Synthetic '+id,job_title:title,employment_status:'active',organogram_visible:true,manager_hr_id:null,department_id:1,line_id:2,area_id:1,position_id:1,region_name:'Fixture Region',departments:{name:'Sales'},lines:{name:'CNS'},areas:{name:'Fixture Area'},positions:{title},last_working_date:null});
 const seat=(id,parent,tier,occupant,area)=>({seat_id:id,parent_seat_id:parent,seat_tier:tier,line_code:'CNS',line_id:2,line_name:'CNS',region_code:'R1',region_name:'Fixture Region',area_code:area,area_name:area,is_other_pseudo_dm:false,occupant_hr_id:occupant,is_vacant:!occupant});
 const tables={
  app_auth_users:[{auth_user_id:subject,login_id:config.owner.loginId,role:config.owner.role,hr_id:null,is_active:true,is_test_persona:false,session_version:1,force_password_reset:false}],
  'rpc/phoenix_mcp_auth_status':[{id:subject,deleted:false,banned_until:null}],role_permission_overrides:[],user_module_locks:[],
  employees:[employee('MANAGER','District Sales Manager'),employee('REP','Medical Representative')],
  au_v_org_tree:[seat('DM',null,'DM','MANAGER',null),seat('REP','DM','REP','REP','A1'),seat('EMPTY','DM','REP',null,'A2')],
  teams:[],position_vacancies:[],offers:[],departments:[{id:1,name:'Sales'}],lines:lines.map((name,i)=>({id:i+1,name,code:name})),areas:[{id:1,name:'Fixture Area',code:'A1'}],positions:[{id:1,title:'Medical Representative'}],
  au_v_line_area_map_all:[],au_v_line_area_map:[],au_v_regions:[],source_of_sales_import_rows:[],
  monthly_closing_publications:lines.map((line,i)=>({id:i+1,line,normalized_line:line.toLowerCase(),period:'2026-06',published_at:'2026-07-01T00:00:00Z',unpublished_at:null})),
  source_of_sales_products:lines.map((line,i)=>({product_code:'P'+i,product_name:'Synthetic product '+i,line,normalized_line:line.toLowerCase(),active:true,factory_price:10,family:line,family_code:line})),
  source_of_sales_import_batches:[{period:'2026-06',status:'validated'}],
  source_of_sales_areas:[{area_code:'A1',area_name:'Fixture Area',region_code:'R1',active:true}],
  source_of_sales_regions:[{region_code:'R1',region_name:'Fixture Region',active:true}],
  source_of_sales_area_regions:[{area_code:'A1',region_code:'R1'}],
  source_of_sales_product_price_history:[],
  'rpc/phx_closing_distributor_product':lines.flatMap((line,i)=>[{line,product_code:'P'+i,area_code:'A1',region_code:'R1',distributor_code:'FIXTURE',units:10,value:100},{line,product_code:'P'+i,area_code:'A1',region_code:'R1',distributor_code:'Office',units:5,value:50}]),
  'rpc/phx_monthly_closing_direct':lines.map((line,i)=>({line,product_code:'P'+i,area_code:'A1',region_code:'R1',sales_units:2,sales_value:20})),
  'rpc/phx_monthly_targets':[],
 };
 let version='fixture-1',failure='',partial='',requests=[];
 const request=async(input,init)=>{
  assert.equal(init?.method,'GET','every source request must use a DB read-only transaction');
  const url=new URL(String(input)),resource=url.pathname.slice('/rest/v1/'.length);requests.push(resource);
  if(resource==='rpc/phoenix_mcp_source_watermark')return Response.json({version,observedAt:new Date(Date.now()).toISOString()});
  if(resource===failure)return new Response('Unavailable',{status:503});
  if(!(resource in tables))throw Error('Unconfigured fixture resource: '+resource);
  let rows=structuredClone(tables[resource]);
  for(const [key,value] of url.searchParams){
   if(value.startsWith('eq.'))rows=rows.filter(r=>String(r[key])===value.slice(3));
   if(value==='is.null')rows=rows.filter(r=>r[key]==null);
   if(value.startsWith('ilike.'))rows=rows.filter(r=>String(r[key]).toLowerCase()===value.slice(6).toLowerCase());
   if(key==='p_line')rows=rows.filter(r=>!r.line||r.line===value);
  }
  const total=rows.length,start=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??total);
  rows=rows.slice(start,start+limit);if(resource===partial&&rows.length)rows.pop();
  return Response.json(rows,{headers:{'content-range':rows.length?`${start}-${start+rows.length-1}/${total}`:`*/${total}`}});
 };
 return {tables,request,requests,setFailure:r=>{failure=r;},setPartial:r=>{partial=r;},change:()=>{version+='x';}};
}
