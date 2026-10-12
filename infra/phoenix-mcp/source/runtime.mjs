import { createClient } from '@supabase/supabase-js';
export {rpcAll,toQueryError} from '../../../src/lib/supabase/server.ts';
let transport,client,origin,credential;
export function configureSource(t,url,key){transport=t;origin=url;credential=key;client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:t.fetch}});}
export const getSupabaseAdmin=()=>{if(!client)throw Error('Source not configured');return client;};
export const getSupabaseUserClient=()=>{throw Error('Unavailable in source');};
export const getRequiredEnv=name=>{if(name==='NEXT_PUBLIC_SUPABASE_URL')return origin;if(name==='SUPABASE_SERVICE_ROLE_KEY')return credential;throw Error('Unapproved source environment');};
export const getOptionalEnv=(name,fallback)=>name==='NEXT_PUBLIC_SUPABASE_URL'?origin:fallback;
export async function getSourceDirectory(){
 const rows=await transport.json('employees?'+new URLSearchParams({select:'hr_id,full_name,job_title,employment_status,organogram_visible,manager_hr_id,department_id,line_id,area_id,position_id,region_name,departments(name),lines(name),areas(name),positions(title)'}));
 const employees=rows.map(e=>({hrId:e.hr_id,fullName:e.full_name,jobTitle:e.job_title,employmentStatus:e.employment_status,organogramVisible:e.organogram_visible,managerHrId:e.manager_hr_id,
  department:e.departments?.name??null,departmentName:e.departments?.name??null,line:e.lines?.name??null,lineName:e.lines?.name??null,lineId:e.line_id,areaId:e.area_id,areaName:e.areas?.name??null,regionName:e.region_name,
  positionTitle:e.positions?.title??null,nodeType:null,recordType:null,businessType:null,employeeType:null}));
 return {employees};
}
