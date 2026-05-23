import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseCarEvidenceImageDataUrl,
  parseCarEvidenceImagePath,
} from "../app/api/outstation/request-body";

export function runOutstationCarEvidenceRegressionTests() {
  const validPath = "data:image/jpeg;base64,".concat(Buffer.from("jpeg").toString("base64"));
  const validPathImage = parseCarEvidenceImageDataUrl({ carEvidenceImageDataUrl: validPath });
  assert.equal(validPathImage, validPath);

  assert.equal(
    parseCarEvidenceImageDataUrl({ carEvidenceImageDataUrl: "data:image/jpeg;base64,not base64" }),
    undefined,
  );
  assert.equal(
    parseCarEvidenceImageDataUrl({
      carEvidenceImageDataUrl: "data:image/png;base64,aGVsbG8=",
    }),
    undefined,
  );
  assert.equal(
    parseCarEvidenceImageDataUrl({
      carEvidenceImageDataUrl: "javascript:alert(1)",
    }),
    undefined,
  );

  assert.equal(
    parseCarEvidenceImagePath({
      carEvidenceImagePath: "car/EMP-1001/request-1.jpg",
    }),
    "car/EMP-1001/request-1.jpg",
  );
  assert.equal(
    parseCarEvidenceImagePath({ carEvidenceImagePath: "invalid/path.png" }),
    undefined,
  );

  const syncRouteSource = readFileSync("app/api/outstation/sync-offline/route.ts", "utf8");
  assert.match(syncRouteSource, /carEvidenceImagePath:\s*parseCarEvidenceImagePath\(body\)/);
  assert.equal(syncRouteSource.includes("carEvidenceImageDataUrl: parseCarEvidenceImageDataUrl(body)"), false);

  const serviceSource = readFileSync("src/lib/outstation/service.ts", "utf8");
  assert.match(
    serviceSource,
    /carEvidenceImagePath\s*&&\s*carEvidenceImagePath !== buildOutstationCarEvidenceImagePath\(storedCarEvidenceMetadata\)/,
  );
  assert.match(
    serviceSource,
    /Car evidence image path does not match the submitted metadata\./,
  );
}
