// Batch quality gate: a dataset where too many rows are bad is neglected as a
// whole instead of loading the few rows that happened to pass.
//
// The ratio counts both the extractor's rejects (CSV rows it could not map)
// and the transformer's rejects (rows that failed validation) against every
// row the extractor read. A batch is neglected when that ratio reaches
// MAX_REJECT_RATIO (default 0.6, i.e. 60% or more bad rows). An empty batch
// is never neglected.

"use strict";

function assessBatch(extracted, transformed, maxRatio) {
  const extractRejected = (extracted && extracted.rejected) || [];
  const transformRejected = (transformed && transformed.rejected) || [];
  const total = ((extracted && extracted.transactions) || []).length + extractRejected.length;
  const bad = extractRejected.length + transformRejected.length;
  const ratio = total === 0 ? 0 : bad / total;
  const reasons = {};
  for (const r of [...extractRejected, ...transformRejected]) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  return { total, bad, ratio, percent: Math.round(ratio * 100), maxRatio, reasons, ok: total === 0 || ratio < maxRatio };
}

module.exports = { assessBatch };
