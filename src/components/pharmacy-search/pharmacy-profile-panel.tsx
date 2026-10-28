"use client";

import { AlertTriangle, Building2, ExternalLink, MapPin, Stethoscope } from "lucide-react";

import { AdminCallout, AdminInsightChip } from "@/components/admin/admin-design-system";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { codeOrWords } from "@/lib/format/code-label";
import {
  phoenixCodeFromProfileId,
  type NearbyDoctor,
  type NearbyHospital,
  type PharmacyProfile,
} from "@/lib/pharmacy-search/types";

const COORDINATE_SOURCE_LABEL: Record<NonNullable<PharmacyProfile["coordinates"]>["source"], string> = {
  brick_centroid: "Centre of its brick — not the pharmacy itself",
  geocode_cache: "Previously geocoded address",
  google_lookup: "Google, looked up just now",
  marketing_capture: "Captured on site by a rep",
};

const headerCell = "break-words px-3 py-2 text-left text-xs font-black uppercase tracking-[0.12em] text-slate-500";
const bodyCell = "break-words px-3 py-2 text-sm font-semibold text-slate-700";

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-slate-200 bg-white px-4 py-6 text-center text-sm font-semibold text-slate-500">
      {children}
    </div>
  );
}

function SectionTitle({ icon, subtitle, title }: { icon: React.ReactNode; subtitle: string; title: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-slate-200/80 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="text-orange-500">{icon}</span>
        <h3 className="text-sm font-black tracking-tight text-slate-900">{title}</h3>
      </div>
      <p className="text-xs font-semibold leading-5 text-slate-500">{subtitle}</p>
    </div>
  );
}

/** "1.2 km" or "Same brick" — never a bare number, and never a fake zero for an unknown. */
function distanceLabel(distanceKm: number | null): string {
  return distanceKm == null ? "Same brick" : `${distanceKm.toFixed(2)} km`;
}

/**
 * How we know where a hospital is. This is the difference between "a rep stood here" and "it is
 * somewhere in this district", and the reader has to be able to tell them apart at a glance —
 * a measured 0.49 km and an unmeasured "same brick" look nothing alike in usefulness.
 */
const HOSPITAL_PROXIMITY_LABEL: Record<NearbyHospital["proximity"], string> = {
  checkin: "Rep check-in",
  geocoded: "Geocoded address",
  google: "Google",
  same_brick: "Same brick, no coordinates",
};

function TerritoryStrip({ profile }: { profile: PharmacyProfile }) {
  const { territory } = profile;
  const hasTerritory = Boolean(territory.brickId ?? territory.areaCode ?? territory.regionCode);

  if (!hasTerritory) {
    return (
      <AdminCallout tone="warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="font-semibold">
          No brick, area or region could be established for this pharmacy.
        </p>
      </AdminCallout>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <AdminInsightChip surface="light" tone="orange">
        Brick: {territory.brickName ?? territory.brickId ?? "Unknown"}
        {territory.brickName && territory.brickId ? ` (${territory.brickId})` : ""}
      </AdminInsightChip>
      <AdminInsightChip surface="light">Area: {territory.areaName ?? territory.areaCode ?? "Unknown"}</AdminInsightChip>
      <AdminInsightChip surface="light">Region: {territory.regionName ?? territory.regionCode ?? "Unknown"}</AdminInsightChip>
      {territory.blockCode ? <AdminInsightChip surface="light" tone="slate">Block: {territory.blockCode}</AdminInsightChip> : null}
      {profile.territoryDerivedFromKm != null ? (
        <AdminInsightChip surface="light" tone="slate">
          Derived by nearest brick centroid, {profile.territoryDerivedFromKm.toFixed(2)} km away
        </AdminInsightChip>
      ) : null}
    </div>
  );
}

function DoctorsSection({ doctors, radiusKm }: { doctors: NearbyDoctor[]; radiusKm: number }) {
  return (
    <section className="overflow-hidden border border-slate-200/90 bg-white/95">
      <SectionTitle
        icon={<Stethoscope className="h-4 w-4" />}
        subtitle={`Doctors our reps checked into within ${radiusKm} km, nearest first. Straight-line distance, not driving.`}
        title={`Doctors nearby (${doctors.length})`}
      />
      <PortalResponsiveDataList
        empty={
          <EmptyNote>
            No rep check-in within {radiusKm} km. Check-ins are a partial feed — this means no visit was
            recorded here, not that no doctor practises nearby.
          </EmptyNote>
        }
        getKey={(doctor, index) => `${doctor.name}-${index}`}
        items={doctors}
        renderCard={(doctor) => (
          <PortalRecordCard
            accent="sky"
            meta={doctor.speciality ?? "Speciality not recorded"}
            status={<span className="text-xs font-black text-orange-600">{distanceLabel(doctor.distanceKm)}</span>}
            title={doctor.name}
          >
            <PortalRecordFields
              fields={[
                { label: "Visits", value: doctor.visits },
                { label: "Last seen", value: doctor.lastSeenAddress ?? "Not recorded" },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[18%]" />
                <col className="w-[12%]" />
                <col className="w-[10%]" />
                <col className="w-[38%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className={headerCell}>Doctor</th>
                <th className={headerCell}>Speciality</th>
                <th className={headerCell}>Distance</th>
                <th className={headerCell}>Visits</th>
                <th className={headerCell}>Last seen at</th>
              </tr>
            </thead>
            <tbody>
              {doctors.map((doctor, index) => (
                <tr className="border-b border-slate-100" key={`${doctor.name}-${index}`}>
                  <td className={`${bodyCell} font-black text-slate-900`}>{doctor.name}</td>
                  <td className={bodyCell}>{doctor.speciality ?? "—"}</td>
                  <td className={`${bodyCell} font-black text-orange-600`}>{distanceLabel(doctor.distanceKm)}</td>
                  <td className={bodyCell}>{doctor.visits}</td>
                  <td className={bodyCell}>{doctor.lastSeenAddress ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </section>
  );
}

function HospitalsSection({ hospitals }: { hospitals: NearbyHospital[] }) {
  return (
    <section className="overflow-hidden border border-slate-200/90 bg-white/95">
      <SectionTitle
        icon={<Building2 className="h-4 w-4" />}
        subtitle="Hospitals our reps check into, hospitals we sell to in this brick, and any Google found around the point."
        title={`Hospitals nearby (${hospitals.length})`}
      />
      <PortalResponsiveDataList
        empty={<EmptyNote>No hospital found in this brick or within the search radius.</EmptyNote>}
        getKey={(hospital, index) => `${hospital.name}-${index}`}
        items={hospitals}
        renderCard={(hospital) => (
          <PortalRecordCard
            accent={hospital.origin === "google" ? "amber" : "emerald"}
            meta={hospital.address ?? "No address recorded"}
            status={<span className="text-xs font-black text-orange-600">{distanceLabel(hospital.distanceKm)}</span>}
            title={hospital.name}
          >
            <PortalRecordFields
              fields={[
                { label: "Source", value: hospital.origin === "google" ? "Google" : "Phoenix database" },
                { label: "Located by", value: HOSPITAL_PROXIMITY_LABEL[hospital.proximity] },
                ...(hospital.speciality ? [{ label: "CRM type", value: hospital.speciality }] : []),
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              <colgroup>
                <col className="w-[24%]" />
                <col className="w-[10%]" />
                <col className="w-[16%]" />
                <col className="w-[16%]" />
                <col className="w-[34%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className={headerCell}>Hospital</th>
                <th className={headerCell}>Distance</th>
                <th className={headerCell}>Located by</th>
                <th className={headerCell}>Source</th>
                <th className={headerCell}>Address</th>
              </tr>
            </thead>
            <tbody>
              {hospitals.map((hospital, index) => (
                <tr className="border-b border-slate-100" key={`${hospital.name}-${index}`}>
                  <td className={`${bodyCell} font-black text-slate-900`}>{hospital.name}</td>
                  <td className={`${bodyCell} font-black text-orange-600`}>{distanceLabel(hospital.distanceKm)}</td>
                  <td className={bodyCell}>{HOSPITAL_PROXIMITY_LABEL[hospital.proximity]}</td>
                  <td className={bodyCell}>{hospital.origin === "google" ? "Google" : "Phoenix database"}</td>
                  <td className={bodyCell}>{hospital.address ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </section>
  );
}

export function PharmacyProfilePanel({
  actions,
  profile,
  radiusKm,
}: {
  actions?: React.ReactNode;
  profile: PharmacyProfile;
  radiusKm: number;
}) {
  return (
    <div className="space-y-5">
      <section className="overflow-hidden border border-slate-200/90 bg-white/95 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-black tracking-tight text-slate-950">{profile.name}</h2>
              {profile.origin === "google" ? (
                <span className="border border-phx-warn-line bg-phx-warn-bg px-2.5 py-1 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-warn">
                  From Google — not in the database
                </span>
              ) : profile.origin === "phoenix" ? (
                // Three states, not two. A registered venue IS in the database, so the plain chip
                // below is not wrong — it is simply silent about the thing that matters here: this
                // record came from the direct-order desk rather than a distributor's customer file,
                // so its codes are what somebody typed and it may have no sales history at all.
                <span className="border border-phx-ok-line bg-phx-ok-bg px-2.5 py-1 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ok">
                  {phoenixCodeFromProfileId(profile.id) ?? "Registered in Phoenix"} — registered at the direct-order desk
                </span>
              ) : (
                <span className="border border-phx-ok-line bg-phx-ok-bg px-2.5 py-1 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ok">
                  In the Phoenix database
                </span>
              )}
            </div>
            <p className="text-sm font-semibold text-slate-600">{profile.address ?? "No address recorded."}</p>
            {profile.coordinates ? (
              <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                <MapPin className="h-3.5 w-3.5 text-orange-500" />
                {COORDINATE_SOURCE_LABEL[profile.coordinates.source]} · {profile.coordinates.latitude.toFixed(5)},{" "}
                {profile.coordinates.longitude.toFixed(5)}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {profile.googleMapsUrl ? (
              <a
                className="inline-flex items-center gap-1.5 border border-phx-line bg-white px-3 py-2 text-xs font-black text-phx-ink transition hover:border-phx-accent-line hover:text-phx-accent"
                href={profile.googleMapsUrl}
                rel="noreferrer noopener"
                target="_blank"
              >
                Open in Google Maps
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null}
            {actions}
          </div>
        </div>
        <div className="mt-4">
          <TerritoryStrip profile={profile} />
        </div>
      </section>

      {profile.warnings.length > 0 ? (
        <div className="space-y-2">
          {profile.warnings.map((warning) => (
            <AdminCallout key={warning} tone="warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="font-semibold">{warning}</p>
            </AdminCallout>
          ))}
        </div>
      ) : null}

      <section className="overflow-hidden border border-slate-200/90 bg-white/95">
        <SectionTitle
          icon={<Building2 className="h-4 w-4" />}
          subtitle="Every distributor that carries this pharmacy, with its own code for it."
          title={`Distributor codes (${profile.distributorCodes.length})`}
        />
        <PortalResponsiveDataList
          empty={<EmptyNote>No distributor code on record for this pharmacy.</EmptyNote>}
          getKey={(entry) => `${entry.distributorCode}-${entry.customerCode}`}
          items={profile.distributorCodes}
          renderCard={(entry) => (
            <PortalRecordCard
              accent={entry.fromReferenceList ? "slate" : "orange"}
              meta={entry.fromReferenceList ? "From the imported reference list" : "From the sales files"}
              title={entry.distributorName ?? codeOrWords(entry.distributorCode)}
            >
              <PortalRecordFields
                fields={[
                  { label: "Code", value: entry.customerCode },
                  { label: "Brick", value: entry.territory.brickName ?? entry.territory.brickId ?? "—" },
                  // The desktop table carries Area next to Brick and the card did not, so a phone
                  // answered two thirds of "brick, area and region" — the first thing this page is
                  // for. Region is deliberately absent from BOTH: it is derived from the area, and
                  // the pharmacy's own region already sits in the header above.
                  { label: "Area", value: entry.territory.areaName ?? "—" },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[24%]" />
                  <col className="w-[20%]" />
                  <col className="w-[16%]" />
                  <col className="w-[16%]" />
                  <col className="w-[24%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className={headerCell}>Distributor</th>
                  <th className={headerCell}>Its code for this pharmacy</th>
                  <th className={headerCell}>Brick</th>
                  <th className={headerCell}>Area</th>
                  <th className={headerCell}>Source</th>
                </tr>
              </thead>
              <tbody>
                {profile.distributorCodes.map((entry) => (
                  <tr className="border-b border-slate-100" key={`${entry.distributorCode}-${entry.customerCode}`}>
                    <td className={`${bodyCell} font-black text-slate-900`}>{entry.distributorName ?? codeOrWords(entry.distributorCode)}</td>
                    <td className={`${bodyCell} font-mono`}>{entry.customerCode}</td>
                    <td className={bodyCell}>{entry.territory.brickName ?? entry.territory.brickId ?? "—"}</td>
                    <td className={bodyCell}>{entry.territory.areaName ?? "—"}</td>
                    <td className={bodyCell}>
                      {entry.fromReferenceList ? "Imported reference list" : "Sales files"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </section>

      <DoctorsSection doctors={profile.nearbyDoctors} radiusKm={radiusKm} />
      <HospitalsSection hospitals={profile.hospitals} />

      {profile.sales.length > 0 ? (
        <section className="overflow-hidden border border-slate-200/90 bg-white/95">
          <SectionTitle
            icon={<Building2 className="h-4 w-4" />}
            subtitle="Units bought per period across every distributor code above, newest first."
            title="Sales history"
          />
          <PortalResponsiveDataList
            empty={<EmptyNote>No sales rows for this pharmacy.</EmptyNote>}
            getKey={(entry) => entry.period}
            items={profile.sales}
            renderCard={(entry) => (
              <PortalRecordCard accent="emerald" title={entry.period}>
                <PortalRecordFields
                  fields={[
                    { label: "Units", value: entry.units.toLocaleString("en-US") },
                    { label: "Products", value: entry.productCount },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[40%]" />
                    <col className="w-[30%]" />
                    <col className="w-[30%]" />
                  </colgroup>
                }
              >
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className={headerCell}>Period</th>
                    <th className={headerCell}>Units</th>
                    <th className={headerCell}>Products</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.sales.map((entry) => (
                    <tr className="border-b border-slate-100" key={entry.period}>
                      <td className={`${bodyCell} font-black text-slate-900`}>{entry.period}</td>
                      <td className={bodyCell}>{entry.units.toLocaleString("en-US")}</td>
                      <td className={bodyCell}>{entry.productCount}</td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        </section>
      ) : null}
    </div>
  );
}
