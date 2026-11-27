import assert from "node:assert/strict";

import {
  masterMobile,
  planEmployeeMasterSync,
  type MasterSyncEmployee,
  type MasterSyncMember,
} from "../src/lib/medical-insurance/master-sync.ts";

// Owner, 27 Nov 2026: "synchronize from medical insurance module to employee master the needed data for employee
// master". These pin what the register may write into the Employee Master: the insurer's card number always, the
// identity ONLY where the master is blank, a difference on both sides never — and never the card-received answer
// or an amount. Invented names and numbers only (NAMES AND NATIONAL IDS NEVER GO IN THE REPO).

function member(overrides: Partial<MasterSyncMember>): MasterSyncMember {
  return {
    birthDate: "1990-04-08",
    certificateNumber: "50000001",
    coverageEnd: null,
    coverageStart: "2026-11-22",
    gender: "F",
    hrId: "T-1",
    memberType: "employee",
    nationalId: "29004080100011",
    phone: "1001234567",
    ...overrides,
  };
}

function employee(overrides: Partial<MasterSyncEmployee>): MasterSyncEmployee {
  return {
    birthDate: "1990-04-08",
    gender: "female",
    hrId: "T-1",
    medicalInsuranceNumber: "50000001",
    mobileNumber: "01001234567",
    name: "Test Employee",
    nationalId: "29004080100011",
    ...overrides,
  };
}

export async function runMedicalInsuranceMasterSyncTests() {
  // Everything already agrees: nothing is written and nothing is listed.
  {
    const plan = planEmployeeMasterSync({ employees: [employee({})], members: [member({})] });
    assert.deepEqual(plan.updates, [], "a master that already agrees with the register is left alone");
    assert.deepEqual(plan.differences, [], "and nothing is listed as differing");
  }

  // The card number: a blank one is filled, an old one (MetLife's 4 digits) is replaced, both guarded on what was read.
  {
    const plan = planEmployeeMasterSync({
      employees: [
        employee({ hrId: "T-1", medicalInsuranceNumber: null, name: "A Blank Card" }),
        employee({ hrId: "T-2", medicalInsuranceNumber: "1115", name: "B Old Card" }),
        employee({ hrId: "T-3", medicalInsuranceNumber: "", name: "C Empty Card" }),
      ],
      members: [member({ hrId: "T-1" }), member({ certificateNumber: "50000002", hrId: "T-2" }), member({ certificateNumber: " 50000003 ", hrId: "T-3" })],
    });
    assert.deepEqual(
      plan.updates.map((update) => update.changes),
      [
        [{ field: "medical_insurance_number", from: null, to: "50000001", why: "blank" }],
        [{ field: "medical_insurance_number", from: "1115", to: "50000002", why: "replaced" }],
        [{ field: "medical_insurance_number", from: "", to: "50000003", why: "blank" }],
      ],
      "the register's card number is the Employee Master's, and each write carries the exact value it replaces",
    );
  }

  // Identity is filled ONLY where the master is blank, in the master's own spelling.
  {
    const plan = planEmployeeMasterSync({
      employees: [employee({ birthDate: null, gender: null, mobileNumber: "  ", nationalId: null })],
      members: [member({ gender: "M", phone: "1123456789" })],
    });
    assert.deepEqual(
      plan.updates[0]?.changes.map((change) => [change.field, change.to]),
      [["national_id", "29004080100011"], ["birth_date", "1990-04-08"], ["gender", "male"], ["mobile_number", "01123456789"]],
      "a blank national ID, birth date, gender and mobile take the register's, gender as male/female and the mobile with its leading zero",
    );
  }

  // A value on BOTH sides that differs is listed and never written — the master is not overwritten.
  {
    const plan = planEmployeeMasterSync({
      employees: [employee({ birthDate: "1991-01-01", gender: "male", mobileNumber: "01009999999", nationalId: "29101010100022" })],
      members: [member({})],
    });
    assert.deepEqual(plan.updates, [], "no identity field the master already holds is ever written");
    assert.deepEqual(
      plan.differences.map((difference) => [difference.field, difference.master, difference.register]),
      [
        ["national_id", "29101010100022", "29004080100011"],
        ["birth_date", "1991-01-01", "1990-04-08"],
        ["gender", "male", "female"],
        ["mobile_number", "01009999999", "01001234567"],
      ],
      "each disagreement is listed for a person to settle",
    );
  }

  // The same mobile written another way is the same mobile, and a second number after a dash does not count against it.
  {
    const plan = planEmployeeMasterSync({
      employees: [employee({ mobileNumber: "0100 123 4567 - 0225555555" })],
      members: [member({ phone: "1001234567" })],
    });
    assert.deepEqual(plan.differences, [], "01001234567 written with spaces and a landline after it is not a difference");
  }

  // Only the employee's own row feeds them: a spouse or child row with the same HR id never does, and an open row beats an ended one.
  {
    const plan = planEmployeeMasterSync({
      employees: [employee({ medicalInsuranceNumber: null })],
      members: [
        member({ certificateNumber: "50000009", memberType: "spouse" }),
        member({ certificateNumber: "50000008", coverageEnd: "2026-11-30", coverageStart: "2026-12-01" }),
        member({ certificateNumber: "50000007" }),
      ],
    });
    assert.deepEqual(plan.updates[0]?.changes, [{ field: "medical_insurance_number", from: null, to: "50000007", why: "blank" }], "the open employee row's card number, never a relative's or an ended row's");
  }

  // Someone with no register row is untouched, and the register's blanks never empty the master.
  {
    const plan = planEmployeeMasterSync({
      employees: [employee({ hrId: "T-9", medicalInsuranceNumber: null }), employee({ hrId: "T-1" })],
      members: [member({ birthDate: null, certificateNumber: null, gender: null, nationalId: "123", phone: null })],
    });
    assert.deepEqual(plan.updates, [], "no register row, or a blank or malformed register value, writes nothing");
    assert.deepEqual(plan.differences, [], "and a malformed register value is not a difference either");
  }

  // Never anything but these five fields: the card-received answer, its date and every amount are not the register's.
  {
    const plan = planEmployeeMasterSync({
      employees: [employee({ birthDate: null, gender: null, medicalInsuranceNumber: null, mobileNumber: null, nationalId: null })],
      members: [member({})],
    });
    const fields = new Set(plan.updates.flatMap((update) => update.changes.map((change) => change.field)));
    assert.deepEqual([...fields].sort(), ["birth_date", "gender", "medical_insurance_number", "mobile_number", "national_id"], "only the card number and the four identity fields");
  }

  assert.equal(masterMobile("1012345678"), "01012345678", "the insurer's ten digits gain the leading zero");
  assert.equal(masterMobile("01512345678"), "01512345678", "an eleven-digit mobile stays as it is");
  assert.equal(masterMobile("0225555555"), null, "a landline is not a mobile");
}
