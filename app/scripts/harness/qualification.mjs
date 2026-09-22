const finite = (value) => Number.isFinite(value);

export const CDP_QUALIFICATION_REASON = 'cdp-byte-mapping-unqualified';

export function validateCdpQualification(record) {
  const statSize = Number(record?.statSizeBytes ?? record?.stat?.size);
  const chunks = Number(record?.bodyBytesFromChunks);
  const total = Number(record?.bodyBytesFromTotal);
  const valid = record?.status === 'passed'
    && finite(statSize)
    && finite(chunks)
    && finite(total)
    && chunks === total
    && total === statSize;
  return {
    valid,
    reason: valid ? null : CDP_QUALIFICATION_REASON,
    statSizeBytes: statSize,
    bodyBytesFromChunks: chunks,
    bodyBytesFromTotal: total,
  };
}
