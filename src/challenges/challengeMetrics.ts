import { promises as fs } from "node:fs";
import { join } from "node:path";
import { readRecoverableJsonState } from "../runtime/localStateFile.js";

const EVOLVO_DIRECTORY_NAME = ".evolvo";
const CHALLENGE_METRICS_FILE_NAME = "challenge-metrics.json";

export type ChallengeMetrics = {
  total: number;
  success: number;
  failure: number;
  attemptsToSuccess: {
    total: number;
    samples: number;
    average: number;
  };
  categoryCounts: Record<string, number>;
  pendingAttemptsByChallenge: Record<string, number>;
};

export type ChallengeAttemptMetricsUpdate = {
  challengeIssueNumber: number;
  success: boolean;
  failureCategory?: string;
};

function createDefaultMetrics(): ChallengeMetrics {
  return {
    total: 0,
    success: 0,
    failure: 0,
    attemptsToSuccess: {
      total: 0,
      samples: 0,
      average: 0,
    },
    categoryCounts: {},
    pendingAttemptsByChallenge: {},
  };
}

function toFiniteNonNegativeInteger(value: unknown): number {
  const asNumber = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    return 0;
  }

  return Math.floor(asNumber);
}

function normalizeCategory(category: string | undefined): string {
  const normalized = category?.trim().toLowerCase();
  return normalized ? normalized : "unknown";
}

function sortNumericRecord(record: Record<string, number>): Record<string, number> {
  const entries = Object.entries(record)
    .filter(([key, value]) => key.trim().length > 0 && Number.isFinite(value) && value > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(entries);
}

function normalizeMetricsShape(metrics: unknown): ChallengeMetrics {
  if (typeof metrics !== "object" || metrics === null) {
    return createDefaultMetrics();
  }

  const candidate = metrics as Partial<ChallengeMetrics>;
  const total = toFiniteNonNegativeInteger(candidate.total);
  const success = toFiniteNonNegativeInteger(candidate.success);
  const failure = toFiniteNonNegativeInteger(candidate.failure);
  const attemptsToSuccessTotal = toFiniteNonNegativeInteger(candidate.attemptsToSuccess?.total);
  const attemptsToSuccessSamples = toFiniteNonNegativeInteger(candidate.attemptsToSuccess?.samples);
  const attemptsToSuccessAverage = attemptsToSuccessSamples === 0
    ? 0
    : Number((attemptsToSuccessTotal / attemptsToSuccessSamples).toFixed(2));
  const categoryCounts = sortNumericRecord(
    Object.fromEntries(
      Object.entries(candidate.categoryCounts ?? {}).map(([key, value]) => [key, toFiniteNonNegativeInteger(value)]),
    ),
  );
  const pendingAttemptsByChallenge = sortNumericRecord(
    Object.fromEntries(
      Object.entries(candidate.pendingAttemptsByChallenge ?? {}).map(([key, value]) => [key, toFiniteNonNegativeInteger(value)]),
    ),
  );

  return {
    total,
    success,
    failure,
    attemptsToSuccess: {
      total: attemptsToSuccessTotal,
      samples: attemptsToSuccessSamples,
      average: attemptsToSuccessAverage,
    },
    categoryCounts,
    pendingAttemptsByChallenge,
  };
}

function getMetricsPath(workDir: string): string {
  return join(workDir, EVOLVO_DIRECTORY_NAME, CHALLENGE_METRICS_FILE_NAME);
}

export async function readChallengeMetrics(workDir: string): Promise<ChallengeMetrics> {
  return readRecoverableJsonState({
    statePath: getMetricsPath(workDir),
    createDefaultState: createDefaultMetrics,
    normalizeState: normalizeMetricsShape,
    warningLabel: "challenge metrics store",
  });
}

async function writeChallengeMetrics(workDir: string, metrics: ChallengeMetrics): Promise<void> {
  const metricsPath = getMetricsPath(workDir);
  await fs.mkdir(join(workDir, EVOLVO_DIRECTORY_NAME), { recursive: true });
  await fs.writeFile(metricsPath, `${JSON.stringify(normalizeMetricsShape(metrics), null, 2)}\n`, "utf8");
}

export async function recordChallengeAttemptMetrics(
  workDir: string,
  update: ChallengeAttemptMetricsUpdate,
): Promise<ChallengeMetrics> {
  const metrics = await readChallengeMetrics(workDir);
  const challengeKey = String(Math.floor(update.challengeIssueNumber));
  const previousPendingAttempts = toFiniteNonNegativeInteger(metrics.pendingAttemptsByChallenge[challengeKey]);
  const currentAttemptCount = previousPendingAttempts + 1;

  metrics.total += 1;

  if (update.success) {
    metrics.success += 1;
    metrics.attemptsToSuccess.total += currentAttemptCount;
    metrics.attemptsToSuccess.samples += 1;
    metrics.attemptsToSuccess.average = Number(
      (metrics.attemptsToSuccess.total / metrics.attemptsToSuccess.samples).toFixed(2),
    );
    delete metrics.pendingAttemptsByChallenge[challengeKey];
  } else {
    metrics.failure += 1;
    metrics.pendingAttemptsByChallenge[challengeKey] = currentAttemptCount;
    const category = normalizeCategory(update.failureCategory);
    metrics.categoryCounts[category] = toFiniteNonNegativeInteger(metrics.categoryCounts[category]) + 1;
  }

  const normalized = normalizeMetricsShape(metrics);
  await writeChallengeMetrics(workDir, normalized);
  return normalized;
}

function formatRate(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "0.00%";
  }

  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

export function formatChallengeMetricsReport(metrics: ChallengeMetrics): string {
  const normalized = normalizeMetricsShape(metrics);
  const failureCategoryEntries = Object.entries(normalized.categoryCounts);
  const pendingChallenges = Object.keys(normalized.pendingAttemptsByChallenge).length;
  const failureCategoryLine = failureCategoryEntries.length === 0
    ? "- none"
    : failureCategoryEntries.map(([category, count]) => `${category}:${count}`).join(", ");

  return [
    "## Challenge Metrics",
    `- total attempts: ${normalized.total}`,
    `- successful attempts: ${normalized.success}`,
    `- failed attempts: ${normalized.failure}`,
    `- success rate: ${formatRate(normalized.success, normalized.total)}`,
    `- attempts-to-success avg: ${normalized.attemptsToSuccess.average.toFixed(2)} (samples=${normalized.attemptsToSuccess.samples})`,
    `- failure categories: ${failureCategoryLine}`,
    `- active pending challenge attempts: ${pendingChallenges}`,
  ].join("\n");
}
