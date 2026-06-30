import { googleGeocodeGovernorate, hasGoogleServerKey } from "@/lib/google-maps/server";
import type { SalesBrickReference } from "@/lib/sales/monthly-distributor-import";

// English governorate names as returned by Google Geocoding API (language=en),
// with the " Governorate" suffix stripped. Mapped to Phoenix region codes.
const GOVERNORATE_TO_REGION: Record<string, string> = {
  // Cairo
  cairo: "CA",
  // Giza region (includes Fayoum and Beni Suef in Phoenix territory scope)
  giza: "GZ",
  fayoum: "GZ",
  "beni suef": "GZ",
  // Upper Egypt
  minia: "UE",
  asyut: "UE",
  sohag: "UE",
  qena: "UE",
  luxor: "UE",
  // Alexandria + Beheira
  alexandria: "AB",
  beheira: "AB",
  matrouh: "AB",
  // Delta (1): Qalubeya, Menoufia, Gharbia, Kafr El Sheikh
  qalyubia: "D1",
  monufia: "D1",
  gharbia: "D1",
  "kafr el sheikh": "D1",
  // Delta (2): Dakahlia, Damietta, Port Said
  dakahlia: "D2",
  damietta: "D2",
  "port said": "D2",
  // Delta (3) unambiguous cases: Suez and Ismailia are exclusively D3
  suez: "D3",
  ismailia: "D3",
  // Sharkia is ambiguous (bricks split between D2 and D3 after the carve-out)
  // — handled by AMBIGUOUS_GOVERNORATES below
  // Others / remote
  "south sinai": "OT",
  "north sinai": "OT",
  "red sea": "OT",
  "new valley": "OT",
  aswan: "OT",
};

// Sharkia governorate bricks were carved between D2 and D3.
// Governorate alone cannot resolve which sub-region a brick belongs to.
const AMBIGUOUS_GOVERNORATES = new Set(["sharqia", "sharkia", "ash sharqiyah"]);

// Validates an AI-suggested brick for an unknown customer pharmacy by geocoding
// the pharmacy's name+address and comparing the returned governorate to the
// brick's Phoenix region. Returns a real confidence score (0–100) that replaces
// the LLM's self-reported confidence, which is systemically overconfident.
export async function geocodeValidateCustomerBrick(
  rawName: string,
  rawAddress: string,
  suggestedBrick: SalesBrickReference,
): Promise<{ confidence: number }> {
  if (!hasGoogleServerKey()) return { confidence: 40 };

  const searchText = [rawName, rawAddress].filter(Boolean).join(" ");
  let governorate: string | null = null;
  try {
    governorate = await googleGeocodeGovernorate(searchText);
  } catch {
    return { confidence: 30 };
  }

  if (!governorate) return { confidence: 25 };

  const normalized = governorate.toLowerCase().trim();

  if (AMBIGUOUS_GOVERNORATES.has(normalized)) {
    // Brick is plausibly in D2 or D3 — we can't resolve further from governorate alone
    if (suggestedBrick.regionCode === "D2" || suggestedBrick.regionCode === "D3") {
      return { confidence: 58 };
    }
  }

  const mappedRegion = GOVERNORATE_TO_REGION[normalized];
  if (!mappedRegion) return { confidence: 35 };

  if (mappedRegion === suggestedBrick.regionCode) {
    // Region matches — brick may still be wrong within the region, so cap at 88%
    return { confidence: 88 };
  }

  return { confidence: 12 };
}
