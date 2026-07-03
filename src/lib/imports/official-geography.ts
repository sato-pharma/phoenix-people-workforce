// Official Line + Area codes for the employee import pipeline.
//
// Historically employee.line_id / employee.area_id were resolved by auto-slugifying whatever raw
// text a spreadsheet contained (see org-rule-engine.ts createOrgCode) and silently CREATING a new
// lines/areas row the first time a spelling didn't match — the root cause of years of duplicate
// near-identical areas (e.g. "Cairo East", "Cairo East 2", "Cairo East 1,2 - Abbasia & Kobbah").
// public.lines.code / public.areas.code now hold the short business codes reconciled against the
// Sales geography master (PD/CS/AF; AB1/CA1/D16/...) instead of those auto-slugs. This module maps
// every historically-seen spelling variant (and the auto-slug computed from it) onto the ONE
// official code it represents, so the import can look a value up instead of ever auto-creating one.
// A raw value with no entry here is unofficial and must be BLOCKED, not guessed at.

/** classifyOrganizationRow already canonicalizes line text through org-rules.ts's lineRules before
 *  this sees it, so the slug space is small and stable: anti_inf | cns | office | pedia. */
export const OFFICIAL_LINE_CODE_BY_SLUG: Record<string, string> = {
  anti_inf: "AF",
  cns: "CS",
  office: "HO",
  pedia: "PD",
};

/** Slug (createOrgCode of the raw area text) -> official Sales-geography area_code. Includes every
 *  spelling variant reconciled in Area_Region_Line_Unification_Template_v2.xlsx. Deliberately does
 *  NOT include ambiguous/fictitious names (e.g. "Dakahlia 4", which different employees resolved to
 *  different real codes) — those must be blocked so the importer picks a real area explicitly. */
export const OFFICIAL_AREA_CODE_BY_SLUG: Record<string, string> = {
  // AB1 Alex East
  alex_east: "AB1",
  // AB2 Alex Center
  alex_center: "AB2",
  alex_center_2: "AB2",
  // AB3 Alex West
  alex_west: "AB3",
  alex_west_center1: "AB3",
  // AB4 Behira 1
  behira_1: "AB4",
  // AB5 Behira 2
  behira_2: "AB5",
  // CA1 Heliopolis
  heliopolis: "CA1",
  // CA2 Nasr City
  nasr_city: "CA2",
  nasr_city_5th_settlement: "CA2",
  // CA3 Cairo East 1
  cairo_east_1: "CA3",
  cairo_east: "CA3",
  cairo_east_1_2_abbasia_and_kobbah_east_2: "CA3",
  // CA4 Cairo East 2
  cairo_east_2: "CA4",
  cairo_east_3_4_5_east1: "CA4",
  // CA5 Down town
  downtown: "CA5",
  down_town: "CA5",
  // CA6 Cairo West
  cairo_west: "CA6",
  shoubra_and_shoubra_el_kheima: "CA6",
  // D11 Qalubeya
  qaluibia: "D11",
  qalubeya: "D11",
  banha: "D11",
  // D12 Menoufia 1
  menoufia_1: "D12",
  monofia_1: "D12",
  // D13 Menoufia 2
  menoufia_2: "D13",
  monofia_2: "D13",
  // D14 Gharbia 1 (Tanta)
  gharbia_1: "D14",
  tanta: "D14",
  // D15 Gharbia 2 (Mahalla)
  gharbia_2: "D15",
  mahalla: "D15",
  // D16 Kafr El-Sheikh
  kafr_el_sheikh: "D16",
  kfs: "D16",
  kafr_el_sheikh_1: "D16",
  // D21 Dakahlia 1
  dakahlia_1: "D21",
  // D22 Dakahlia 2
  dakahlia_2: "D22",
  // D23 Dakahlia 3
  dakahlia_3: "D23",
  // D24 Sharkia 1
  sharkia_1: "D24",
  // D25 Sharkia 2
  sharkia_2: "D25",
  sharkia_3: "D25",
  // D26 Port said - Domiat
  port_said_domiat: "D26",
  domiat: "D26",
  // GZ1 Giza - Giza Centers
  giza_giza_centers: "GZ1",
  giza_centers: "GZ1",
  // GZ2 Dokki - Mohandseen - Bolak
  dokki_mohandsen_bolak: "GZ2",
  dokki_bolaq_mohandsen: "GZ2",
  dokki_mohandsen_imbaba: "GZ2",
  // GZ3 Imbaba - Imbaba Centers
  imbaba: "GZ3",
  // GZ4 Haram - Faisal
  haram_faisal: "GZ4",
  haram_fisal: "GZ4",
  faisal_and_october: "GZ4",
  // GZ5 Helwan-Maadi
  maadi_helwan: "GZ5",
  helwan: "GZ5",
  // GZ6 Fayoum-Beni Suef
  fayoum: "GZ6",
  bani_suef: "GZ6",
  // GZ7 October -Zayed
  october_zayed: "GZ7",
  // OT1 North Sinai
  north_sinai: "OT1",
  // OT2 Suez/ South Sinai
  suez_south_sinai: "OT2",
  // OT3 Aswan
  aswan: "OT3",
  // UE1 Minia 1
  minia_1: "UE1",
  // UE2 Minia 2
  minia_2: "UE2",
  // UE3 Assuit 1
  assuit_1: "UE3",
  // UE4 Assuit 2
  assuit_2: "UE4",
  // UE5 Sohag1
  sohag1: "UE5",
  sohag_1: "UE5",
  // UE6 Sohag2
  sohag2: "UE6",
  sohag_2: "UE6",
  // UE7 Qena
  qena: "UE7",
  qena_1: "UE7",
  qena_2: "UE7",
  qena_and_nagaa_hammady: "UE7",
};
