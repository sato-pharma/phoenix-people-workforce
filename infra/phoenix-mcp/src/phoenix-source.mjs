// Source-side ONLY (never imported by the reader entry point): one shared implementation of the proof,
// read recorder, registry and live authorization that the Phoenix source process also runs.
export { installReadRecorder,runWithReadRecorder } from '../../../src/lib/mcp-source/read-recorder.ts';
export { verifySourceProof,assertVerifiedProof,isVerifiedProof,sealFreshness,contentSnapshotId,summarizeReads,SourceProofError } from '../../../src/lib/mcp-source/source-proof.ts';
export { provenRead,withChangeClock,createRpcWatermarkReader } from '../../../src/lib/mcp-source/collector.ts';
export { SPECS,SALES_PUBLICATION_SPEC } from '../../../src/lib/mcp-source/source-registry.ts';
export { decideLiveIdentity,loadLiveIdentity,LiveAuthorizationError } from '../../../src/lib/mcp-source/live-authorization.ts';
