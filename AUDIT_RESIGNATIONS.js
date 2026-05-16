#!/usr/bin/env node

/**
 * Resignation Data Integrity Audit - Standalone Script
 * Checks for employees marked as resigned but showing as active
 */

const fs = require('fs');
const path = require('path');

// Load .env.local
require('dotenv').config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing Supabase credentials in .env.local');
  process.exit(1);
}

const supabaseClient = require('@supabase/supabase-js');
const { createClient } = supabaseClient;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function auditResignationIntegrity() {
  console.log('🔍 Starting Resignation Data Integrity Audit...\n');

  try {
    // Step 1: Get all active resignations
    console.log('📋 Step 1: Fetching active resignation records...');
    const { data: resignations, error: resError } = await supabase
      .from('employee_resignations')
      .select('id,employee_hr_id,employee_name,status,effective_date,completed_at')
      .in('status', ['submitted', 'under_review', 'approved', 'completed']);

    if (resError) {
      console.error('❌ Error fetching resignations:', resError);
      return;
    }

    console.log(`✅ Found ${resignations.length} resignation records\n`);

    if (resignations.length === 0) {
      console.log('ℹ️  No resignation records found. Database may be empty.');
      return;
    }

    // Step 2: Extract HR IDs
    console.log('📋 Step 2: Extracting HR IDs from resignation records...');
    const resignedHrIds = Array.from(
      new Set(resignations.map(r => r.employee_hr_id?.trim().toUpperCase()).filter(Boolean))
    );
    console.log(`✅ Found ${resignedHrIds.length} unique resigned employee HR IDs\n`);

    // Step 3: Check employee statuses
    console.log('📋 Step 3: Checking employee employment status...');
    const { data: employees, error: empError } = await supabase
      .from('employees')
      .select('hr_id,full_name,employment_status,organogram_visible,payroll_eligible')
      .in('hr_id', resignedHrIds);

    if (empError) {
      console.error('❌ Error fetching employees:', empError);
      return;
    }

    console.log(`✅ Fetched ${employees.length} employee records\n`);

    // Step 4: Find corrupted records
    console.log('📋 Step 4: Analyzing data integrity...\n');
    const corrupted = [];
    const healthy = [];

    for (const emp of employees) {
      const resignation = resignations.find(r => r.employee_hr_id?.trim().toUpperCase() === emp.hr_id?.trim().toUpperCase());
      
      if (!resignation) continue;

      const issues = [];
      
      if (emp.employment_status === 'active' || emp.employment_status === 'on_leave') {
        issues.push(`employment_status is "${emp.employment_status}" (should be "resigned" or "terminated")`);
      }
      
      if (emp.organogram_visible === true) {
        issues.push(`organogram_visible is true (should be false)`);
      }
      
      if (emp.payroll_eligible === true) {
        issues.push(`payroll_eligible is true (should be false)`);
      }

      if (issues.length > 0) {
        corrupted.push({
          hrId: emp.hr_id,
          fullName: emp.full_name,
          currentStatus: emp.employment_status,
          resignationStatus: resignation.status,
          resignationEffectiveDate: resignation.effective_date,
          issues,
        });
      } else {
        healthy.push({
          hrId: emp.hr_id,
          fullName: emp.full_name,
        });
      }
    }

    // Step 5: Report results
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('AUDIT RESULTS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    if (corrupted.length === 0) {
      console.log('✅ ALL CLEAN: No data corruption detected!\n');
      console.log(`✅ ${healthy.length} resigned employees have correct status\n`);
      return;
    }

    console.log(`⚠️  CORRUPTION DETECTED: ${corrupted.length} employee(s) with inconsistent data\n`);

    console.log('CORRUPTED RECORDS:');
    console.log('─────────────────────────────────────────────────────────────\n');

    for (let i = 0; i < corrupted.length; i++) {
      const c = corrupted[i];
      console.log(`${i + 1}. ${c.fullName} (${c.hrId})`);
      console.log(`   Resignation Status: ${c.resignationStatus}`);
      console.log(`   Effective Date: ${c.resignationEffectiveDate}`);
      console.log(`   Current Employment Status: ${c.currentStatus}`);
      console.log(`   Issues:`);
      c.issues.forEach(issue => console.log(`     • ${issue}`));
      console.log();
    }

    console.log('─────────────────────────────────────────────────────────────\n');
    console.log(`📊 SUMMARY:`);
    console.log(`   Total Resignations: ${resignations.length}`);
    console.log(`   Healthy Records: ${healthy.length}`);
    console.log(`   Corrupted Records: ${corrupted.length}`);
    console.log(`   Corruption Rate: ${((corrupted.length / employees.length) * 100).toFixed(1)}%\n`);

    if (corrupted.length > 0) {
      console.log('🔧 REMEDIATION SCRIPT:');
      console.log('─────────────────────────────────────────────────────────────');
      console.log('Run this to fix all corrupted records:\n');
      console.log('npx ts-node ./FIX_RESIGNATIONS.ts\n');
    }

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run the audit
auditResignationIntegrity().then(() => {
  console.log('✅ Audit complete.\n');
  process.exit(0);
}).catch(err => {
  console.error('❌ Audit failed:', err);
  process.exit(1);
});
