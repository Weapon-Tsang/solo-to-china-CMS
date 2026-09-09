import { sha256 } from "./utils.mjs";

export const QUALITY_EVALUATION_REPORT_VERSION = "quality-report-1.0.0";

export function buildQualityEvaluationReport({ dataset, results, strategyVersion, model = null, startedAt = null, completedAt = null }) {
  const samples = Array.isArray(dataset?.samples) ? dataset.samples : [];
  const byId = new Map((results || []).map((item) => [item.id, item]));
  const rows = samples.map((sample) => {
    const result = byId.get(sample.id);
    return { ...sample, evaluated: Boolean(result), actualPass: result?.passed ?? null,
      matchedExpectation: result ? Boolean(result.passed) === Boolean(sample.expectedPass) : null,
      hardFailures: result?.hardFailures ?? null, warnings: result?.warnings ?? null,
      semanticStatus: result?.semanticStatus || "not_sampled", elapsedMs: result?.elapsedMs ?? null,
      inputHash: result?.inputHash || null };
  });
  const evaluated = rows.filter((row) => row.evaluated);
  const expectedPass = evaluated.filter((row) => row.expectedPass);
  const expectedFail = evaluated.filter((row) => !row.expectedPass);
  const safeRate = (numerator, denominator) => denominator ? numerator / denominator : null;
  const durationMs = startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null;
  return {
    reportVersion: QUALITY_EVALUATION_REPORT_VERSION,
    datasetVersion: dataset?.version || "unknown",
    datasetHash: sha256(JSON.stringify(dataset || {})),
    strategyVersion: strategyVersion || dataset?.strategyVersion || "unknown",
    model: model || { status: "not_tested", reason: "No approved real-model evaluation run was supplied." },
    sampleCounts: { total: samples.length, evaluated: evaluated.length, heldOut: rows.filter((row) => row.heldOut).length },
    metrics: {
      expectationAccuracy: safeRate(evaluated.filter((row) => row.matchedExpectation).length, evaluated.length),
      supportedDraftPassRate: safeRate(expectedPass.filter((row) => row.actualPass).length, expectedPass.length),
      mutationBlockRate: safeRate(expectedFail.filter((row) => !row.actualPass).length, expectedFail.length),
      falseBlockRate: safeRate(expectedPass.filter((row) => !row.actualPass).length, expectedPass.length),
      semanticSampleSize: evaluated.filter((row) => row.semanticStatus !== "not_sampled").length,
      humanRework: { status: "not_measured", count: null },
      elapsedMs: durationMs,
    },
    claims: { deterministicValidatorBehavior: evaluated.length > 0 ? "measured" : "not_measured",
      realModelWritingImprovement: model?.status === "measured" ? "measured" : "not_measured" },
    samples: rows,
  };
}
