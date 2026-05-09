/* eslint-disable @typescript-eslint/no-require-imports */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const text = fs.readFileSync('F:/Phoenix Workforce/phoenix-workforce/.env.local','utf8');
const env = Object.fromEntries(text.split('\n').map((line) => line.trim()).filter(Boolean).filter((line) => line.includes('=') && !line.startsWith('#')).map((line) => {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1)];
}));

(async () => {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: users } = await sb.from('app_auth_users').select('login_id,hr_id,role').eq('is_active', true).order('login_id');

  let noPayroll=0,noSales=0,noAny=0;
  const noPayrollUsers=[];
  const noSalesUsers=[];
  const noAnyUsers=[];

  for (const u of users || []) {
    if (!u.hr_id) continue;
    const payrollCount = await sb.from('salary_records').select('id', { count: 'exact', head: true }).ilike('hr_id', String(u.hr_id).trim()).then((r)=>r.count ?? 0);
    const salesCount = await sb.from('sales_records').select('id', { count: 'exact', head: true }).eq('employee_hr_id', String(u.hr_id).trim()).then((r)=>r.count ?? 0);
    const issues = [];
    if (!payrollCount) noPayroll += 1, issues.push('payroll');
    if (!salesCount) noSales += 1, issues.push('sales');
    if (!payrollCount && !salesCount) noAny += 1, (noAnyUsers.push({login_id:u.login_id, role:u.role, hr_id:u.hr_id, issue:issues.join('+')}));
    if (!payrollCount) noPayrollUsers.push({login_id:u.login_id, role:u.role, hr_id:u.hr_id, payrollCount, salesCount});
    if (!salesCount) noSalesUsers.push({login_id:u.login_id, role:u.role, hr_id:u.hr_id, payrollCount, salesCount});
  }

  console.log('total active', users?.length || 0);
  console.log('no payroll', noPayroll, 'no sales', noSales, 'no both', noAny);
  console.log('examples no payroll', noPayrollUsers.slice(0, 40));
})();
