"use client";

import { Mail, Phone, MapPin, Calendar, Briefcase, Shield } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";

type EmployeeProfileCardProps = {
  employee: EmployeeDirectoryRow;
};

export function EmployeeProfileCard({ employee }: EmployeeProfileCardProps) {
  const sections = [
    {
      title: "Contact Information",
      icon: Mail,
      items: [
        { label: "Work Email", value: employee.workEmail },
        { label: "Personal Email", value: employee.personalEmail },
        { label: "Phone (Work)", value: employee.mobileNumber },
      ],
    },
    {
      title: "Personal Information",
      icon: Shield,
      items: [
        { label: "Full Name", value: employee.fullName },
        { label: "Arabic Name", value: employee.nameAr },
        { label: "Birth Date", value: employee.birthDate },
        { label: "National ID", value: employee.nationalIdNumber },
      ],
    },
    {
      title: "Employment Details",
      icon: Briefcase,
      items: [
        { label: "Job Title", value: employee.jobTitle },
        { label: "Employee Type", value: employee.employeeType },
        { label: "Hire Date", value: employee.hireDate },
        { label: "Manager", value: employee.managerName },
        { label: "Line", value: employee.lineName },
        { label: "Area", value: employee.areaName },
        { label: "Status", value: employee.employmentStatus },
      ],
    },
    {
      title: "Emergency Contact",
      icon: Phone,
      items: [
        { label: "Name", value: employee.emergencyContactName },
        { label: "Phone", value: employee.emergencyContactPhone },
      ],
    },
    {
      title: "Address Information",
      icon: MapPin,
      items: [
        { label: "Address (from ID)", value: employee.addressFromIdCard },
        { label: "Residence Address", value: employee.residenceAddress },
        { label: "City", value: employee.residenceCity },
        { label: "Area", value: employee.residenceArea },
      ],
    },
    {
      title: "Compensation Information",
      icon: Calendar,
      items: [
        { label: "HR ID", value: employee.hrId },
        { label: "CRM ID", value: employee.crmId },
        { label: "Education", value: employee.education },
        { label: "Salary Payment Mode", value: employee.salaryPaymentMode },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <Card className="border-slate-200 bg-white p-6">
        <h1 className="text-2xl font-bold text-slate-900">{employee.fullName}</h1>
        {employee.nameAr && <p className="mt-1 text-lg text-slate-600">{employee.nameAr}</p>}
        <p className="mt-2 text-sm text-slate-600">{employee.jobTitle}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
            {employee.employmentStatus || "Active"}
          </span>
          {employee.lineName && (
            <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">
              {employee.lineName}
            </span>
          )}
          {employee.areaName && (
            <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
              {employee.areaName}
            </span>
          )}
        </div>
      </Card>

      {sections.map((section) => (
        <Card key={section.title} className="border-slate-200 bg-white p-6">
          <div className="mb-4 flex items-center gap-2">
            <section.icon className="h-5 w-5 text-slate-600" />
            <h2 className="text-lg font-bold text-slate-900">{section.title}</h2>
          </div>
          <div className="space-y-3">
            {section.items
              .filter(({ value }) => value)
              .map(({ label, value }) => (
                <div key={label} className="flex justify-between border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
                  <span className="text-sm font-medium text-slate-600">{label}</span>
                  <span className="text-sm text-slate-900">{value}</span>
                </div>
              ))}
            {section.items.every(({ value }) => !value) && (
              <p className="text-sm text-slate-400">No information available</p>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
