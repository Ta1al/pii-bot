import type { RiskInput, RiskResult, RiskTimings } from "./classify.js";

export interface StoredRiskAssessment {
  result: RiskResult;
  input: RiskInput;
  timings: RiskTimings;
  assessedAt: number;
}

const MAX_RESULTS = 10_000;
const results = new Map<string, StoredRiskAssessment>();

/** Keeps the latest assessment available to the message context command. */
export function storeRiskAssessment(
  messageId: string,
  assessment: Omit<StoredRiskAssessment, "assessedAt">
): void {
  results.delete(messageId);
  results.set(messageId, { ...assessment, assessedAt: Date.now() });

  while (results.size > MAX_RESULTS) {
    const oldest = results.keys().next().value;
    if (oldest === undefined) break;
    results.delete(oldest);
  }
}

export function getRiskAssessment(
  messageId: string
): StoredRiskAssessment | undefined {
  return results.get(messageId);
}
