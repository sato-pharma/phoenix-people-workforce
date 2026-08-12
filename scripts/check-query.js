/* eslint-disable @typescript-eslint/no-require-imports */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const text = fs.readFileSync('F:/Phoenix Workforce/phoenix-workforce/.env.local','utf8');
const lines = text.split('\n').map((line) => line.trim()).filter(Boolean).filter((line) => line.includes('=') && !line.startsWith('#'));
const env = Object.fromEntries(lines.map((line) => {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1)];
}));

(async () => {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const users = ['A-1', 'A-10', 'A-12', 'B-180'];
  for (const hr of users) {
    const payrollHr = await sb.from('salary_records').select('id', { count: 'exact', head: true }).ilike('hr_id', hr);
    const payrollCode = await sb.from('salary_records').select('id', { count: 'exact', head: true }).ilike('employee_code', hr);
    const sales = await sb.from('sales_records').select('id', { count: 'exact', head: true }).eq('employee_hr_id', hr);
    const expenses = await sb.from('outstation_expenses').select('id', { count: 'exact', head: true }).eq('hr_id', hr);
    console.log(hr, {
      payrollHr: payrollHr.count,
      payrollCode: payrollCode.count,
      sales,
      expenses: expenses.count,
    });
  }
})();
