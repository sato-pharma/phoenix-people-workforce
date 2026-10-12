import { z } from 'zod';
import { identitySchema,Denied,Unavailable,type Identity } from '../src/contracts.mts';
import { isEmploymentAccessRevoked } from '../src/phoenix-policy.mjs';
import type { Config } from '../src/config.mts';
import type { createSourceTransport } from './transport.mts';
const account=z.object({auth_user_id:z.string().uuid(),login_id:z.string(),role:z.string(),hr_id:z.string().nullable(),is_active:z.boolean(),is_test_persona:z.boolean(),session_version:z.number().int(),force_password_reset:z.boolean()});
const authStatus=z.object({id:z.string().uuid(),deleted:z.boolean(),banned_until:z.string().nullable()});
export function createSourceAuthorization(transport:ReturnType<typeof createSourceTransport>,owner:Config['owner']){
 return async(subject:string):Promise<Identity|null>=>{
  if(subject!==owner.subject)throw new Denied();
  const proof=transport.proof(['app_auth_users','rpc/phoenix_mcp_auth_status','role_permission_overrides','user_module_locks']);
  const result=await proof.collect(async()=>{
   const rows=await transport.json('app_auth_users?'+new URLSearchParams({select:'auth_user_id,login_id,role,hr_id,is_active,is_test_persona,session_version,force_password_reset',auth_user_id:'eq.'+subject}));
   if(!Array.isArray(rows)||rows.length!==1)throw new Denied();
   const a=account.parse(rows[0]);
   const statuses=await transport.json('rpc/phoenix_mcp_auth_status?'+new URLSearchParams({p_subject:subject}));
   if(!Array.isArray(statuses)||statuses.length!==1)throw new Denied();
   const status=authStatus.parse(statuses[0]);
   if(status.id!==subject||status.deleted||a.auth_user_id!==subject||a.login_id!==owner.loginId||a.role!==owner.role||!a.is_active||a.is_test_persona||a.force_password_reset)throw new Denied();
   if(status.banned_until!==null&&(!Number.isFinite(Date.parse(status.banned_until))||Date.parse(status.banned_until)>Date.now()))throw new Denied();
   let employmentStatus:string|null=null,lastWorkingDate:string|null=null;
   if(a.hr_id){
    const employees=await transport.json('employees?'+new URLSearchParams({select:'hr_id,employment_status,last_working_date',hr_id:'ilike.'+a.hr_id.replace(/[%_*]/g,'')}));
    if(!Array.isArray(employees)||employees.length!==1)throw new Denied();
    const e=z.object({hr_id:z.string(),employment_status:z.string(),last_working_date:z.string().nullable()}).parse(employees[0]);
    if(e.hr_id.toLowerCase()!==a.hr_id.toLowerCase())throw new Denied();
    employmentStatus=e.employment_status;lastWorkingDate=e.last_working_date;
   }
   const permissions=z.array(z.object({role_name:z.string(),resource:z.string(),action:z.string(),is_allowed:z.boolean()})).parse(await transport.json('role_permission_overrides?select=role_name,resource,action,is_allowed'));
   const locks=z.array(z.object({login_id:z.string(),hr_id:z.string().nullable(),module_key:z.string(),unlock_at:z.string().nullable(),released_at:z.string().nullable()})).parse(await transport.json('user_module_locks?select=login_id,hr_id,module_key,unlock_at,released_at&released_at=is.null'));
   const todayCairo=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   if(isEmploymentAccessRevoked({employmentStatus,lastWorkingDate,todayCairo}))throw new Denied();
   for(const lock of locks)if(lock.unlock_at&&!Number.isFinite(Date.parse(lock.unlock_at)))throw new Unavailable();
   return identitySchema.parse({subject,loginId:a.login_id,hrId:a.hr_id,role:a.role,active:a.is_active,sessionVersion:a.session_version,employmentStatus,lastWorkingDate,testPersona:a.is_test_persona,
    permissions:permissions.filter(p=>p.role_name===a.role&&p.action==='read').map(p=>({resource:p.resource,allowed:p.is_allowed})),
    locks:locks.filter(l=>l.released_at===null&&(!l.unlock_at||Date.parse(l.unlock_at)>Date.now())&&(l.login_id.toLowerCase()===a.login_id.toLowerCase()||(a.hr_id&&l.hr_id?.toLowerCase()===a.hr_id.toLowerCase()))).map(l=>l.module_key),
   });
  });
  return result.value;
 };
}
