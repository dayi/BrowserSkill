import type { CaptureElementFingerprint, CaptureFingerprintAttributes } from "./target-fingerprint";
import type {
  DomChangeV4,
  NetworkEffectV4,
  ObservationOutcomeV4,
  StepEffectsV4,
} from "./trace-v4-types";

export interface ReplayTargetCandidate {
  ref?: string;
  fingerprint: CaptureElementFingerprint;
  visible?: boolean;
  enabled?: boolean;
}

export interface ReplayTargetScore {
  candidate: ReplayTargetCandidate;
  score: number;
  reasons: string[];
  contradictions: string[];
}

export interface ReplayTargetDecision {
  best?: ReplayTargetScore;
  ranked: ReplayTargetScore[];
  confidence: "high" | "medium" | "low" | "none";
  ambiguous: boolean;
}

const STABLE_ATTRIBUTE_WEIGHTS: ReadonlyArray<[
  keyof CaptureFingerprintAttributes,
  number,
]> = [
  ["test_id", 55],
  ["data_test", 50],
  ["data_cy", 50],
  ["id", 35],
  ["name", 24],
  ["aria_label", 24],
  ["aria_controls", 14],
  ["placeholder", 12],
  ["input_type", 8],
  ["aria_haspopup", 8],
];

function norm(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function textSimilarity(expected: string | undefined, actual: string | undefined): number {
  const left = norm(expected);
  const right = norm(actual);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.65;
  const leftWords = new Set(left.split(" ").filter(Boolean));
  const rightWords = new Set(right.split(" ").filter(Boolean));
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  return overlap / Math.max(leftWords.size, rightWords.size, 1);
}

function scoreAttribute(
  name: keyof CaptureFingerprintAttributes,
  weight: number,
  expected: CaptureFingerprintAttributes | undefined,
  actual: CaptureFingerprintAttributes | undefined,
  reasons: string[],
  contradictions: string[],
): number {
  const left = norm(expected?.[name]);
  if (!left) return 0;
  const right = norm(actual?.[name]);
  if (!right) return 0;
  if (left === right) {
    reasons.push(`${name}=exact`);
    return weight;
  }
  // Stable test hooks / ids are strong contradictions when both sides expose
  // different values. Softer semantic attributes only receive a small penalty.
  if (name === "test_id" || name === "data_test" || name === "data_cy" || name === "id") {
    contradictions.push(`${name}=mismatch`);
    return -weight;
  }
  contradictions.push(`${name}=different`);
  return -Math.round(weight * 0.35);
}

/**
 * Score a current observation candidate against a trace-v4 fingerprint.
 * Observation-local refs and geometry are deliberately excluded so a replay
 * can survive DOM regeneration, viewport changes, and different @eN numbering.
 */
export function scoreReplayTarget(
  expected: CaptureElementFingerprint,
  candidate: ReplayTargetCandidate,
): ReplayTargetScore {
  const actual = candidate.fingerprint;
  let score = 0;
  const reasons: string[] = [];
  const contradictions: string[] = [];

  const expectedTag = norm(expected.tag);
  const actualTag = norm(actual.tag);
  if (expectedTag === actualTag) {
    score += 10;
    reasons.push("tag=exact");
  } else {
    score -= 18;
    contradictions.push("tag=mismatch");
  }

  const expectedRole = norm(expected.role);
  const actualRole = norm(actual.role);
  if (expectedRole && actualRole) {
    if (expectedRole === actualRole) {
      score += 28;
      reasons.push("role=exact");
    } else {
      score -= 30;
      contradictions.push("role=mismatch");
    }
  }

  const nameSimilarity = textSimilarity(expected.name, actual.name);
  if (nameSimilarity > 0) {
    const points = Math.round(34 * nameSimilarity);
    score += points;
    reasons.push(nameSimilarity === 1 ? "name=exact" : `name~${nameSimilarity.toFixed(2)}`);
  } else if (expected.name && actual.name) {
    score -= 16;
    contradictions.push("name=mismatch");
  }

  for (const [name, weight] of STABLE_ATTRIBUTE_WEIGHTS) {
    score += scoreAttribute(
      name,
      weight,
      expected.attributes,
      actual.attributes,
      reasons,
      contradictions,
    );
  }

  const expectedNearby = expected.nearby_text ?? [];
  const actualNearby = actual.nearby_text ?? [];
  let nearbyPoints = 0;
  for (const left of expectedNearby) {
    const best = Math.max(0, ...actualNearby.map((right) => textSimilarity(left, right)));
    nearbyPoints += Math.round(best * 8);
  }
  if (nearbyPoints) {
    score += Math.min(18, nearbyPoints);
    reasons.push("nearby_text");
  }

  const expectedAncestors = expected.ancestors ?? [];
  const actualAncestors = actual.ancestors ?? [];
  let ancestorPoints = 0;
  for (const expectedAncestor of expectedAncestors.slice(0, 3)) {
    const best = Math.max(
      0,
      ...actualAncestors.slice(0, 4).map((actualAncestor) => {
        let local = 0;
        if (norm(expectedAncestor.tag) && norm(expectedAncestor.tag) === norm(actualAncestor.tag)) local += 0.25;
        if (norm(expectedAncestor.role) && norm(expectedAncestor.role) === norm(actualAncestor.role)) local += 0.35;
        local += 0.4 * textSimilarity(expectedAncestor.name, actualAncestor.name);
        return Math.min(1, local);
      }),
    );
    ancestorPoints += Math.round(best * 6);
  }
  if (ancestorPoints) {
    score += Math.min(14, ancestorPoints);
    reasons.push("semantic_ancestor");
  }

  if (candidate.visible === true) score += 5;
  if (candidate.enabled === true) score += 4;
  if (candidate.visible === false) {
    score -= 25;
    contradictions.push("not_visible");
  }
  if (candidate.enabled === false) {
    score -= 18;
    contradictions.push("disabled");
  }

  return { candidate, score, reasons, contradictions };
}

export function rankReplayTargets(
  expected: CaptureElementFingerprint,
  candidates: ReplayTargetCandidate[],
): ReplayTargetDecision {
  const ranked = candidates
    .map((candidate) => scoreReplayTarget(expected, candidate))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) return { ranked, confidence: "none", ambiguous: false };
  const second = ranked[1];
  const margin = second ? best.score - second.score : Number.POSITIVE_INFINITY;
  const ambiguous = Boolean(second && margin < 12);
  const confidence =
    best.score >= 75 && margin >= 15
      ? "high"
      : best.score >= 42 && margin >= 8
        ? "medium"
        : "low";
  return { best, ranked, confidence, ambiguous };
}

export type ReplayEffectVerificationStatus =
  | "matched"
  | "partial"
  | "mismatch"
  | "insufficient";

export interface ReplayEffectVerification {
  status: ReplayEffectVerificationStatus;
  score: number;
  matched: string[];
  missing: string[];
  unexpected: string[];
}

function comparableUrl(raw: string): { origin: string; path: string; queryKeys: string[] } | null {
  try {
    const url = new URL(raw);
    return {
      origin: url.origin.toLocaleLowerCase(),
      path: url.pathname.replace(/\/+$/, "") || "/",
      queryKeys: [...url.searchParams.keys()].sort(),
    };
  } catch {
    return null;
  }
}

function sameEndpoint(expected: NetworkEffectV4, actual: NetworkEffectV4): boolean {
  if (expected.method.toUpperCase() !== actual.method.toUpperCase()) return false;
  const left = comparableUrl(expected.url);
  const right = comparableUrl(actual.url);
  if (!left || !right) return expected.url === actual.url;
  return (
    left.origin === right.origin &&
    left.path === right.path &&
    left.queryKeys.join("\0") === right.queryKeys.join("\0")
  );
}

function compatibleStatus(expected: number | undefined, actual: number | undefined): boolean {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  if (expected === actual) return true;
  return Math.floor(expected / 100) === Math.floor(actual / 100);
}

function domChangeMatches(expected: DomChangeV4, actual: DomChangeV4): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.role && norm(expected.role) !== norm(actual.role)) return false;
  if (expected.name && textSimilarity(expected.name, actual.name) < 0.65) return false;
  return true;
}

/**
 * Compare the effects observed during replay with the recorded causal contract.
 * The verifier is intentionally asymmetric: unexpected security blocks/errors
 * are hard failures, while low-signal DOM/network omissions become partial or
 * insufficient evidence rather than encouraging a blind retry.
 */
export function verifyReplayEffects(
  expected: StepEffectsV4,
  observed: StepEffectsV4,
  expectedOutcome: ObservationOutcomeV4 = "changed",
): ReplayEffectVerification {
  const matched: string[] = [];
  const missing: string[] = [];
  const unexpected: string[] = [];
  let expectedSignals = 0;
  let matchedSignals = 0;

  if (!(expected.security?.length) && observed.security?.length) {
    unexpected.push(...observed.security.map((effect) => `security:${effect.code}`));
  }
  if (
    expectedOutcome !== "error" &&
    observed.console?.some((entry) => entry.level === "error")
  ) {
    unexpected.push("console:error");
  }

  for (const expectedNavigation of expected.navigation ?? []) {
    expectedSignals += 2;
    const destination = comparableUrl(expectedNavigation.to);
    const found = (observed.navigation ?? []).some((actual) => {
      const actualDestination = comparableUrl(actual.to);
      if (!destination || !actualDestination) return expectedNavigation.to === actual.to;
      return destination.origin === actualDestination.origin && destination.path === actualDestination.path;
    });
    if (found) {
      matchedSignals += 2;
      matched.push(`navigation:${expectedNavigation.to}`);
    } else {
      missing.push(`navigation:${expectedNavigation.to}`);
    }
  }

  for (const expectedNetwork of expected.network ?? []) {
    expectedSignals += 1;
    const found = (observed.network ?? []).some(
      (actual) => sameEndpoint(expectedNetwork, actual) && compatibleStatus(expectedNetwork.status, actual.status),
    );
    if (found) {
      matchedSignals += 1;
      matched.push(`network:${expectedNetwork.method}:${expectedNetwork.url}`);
    } else {
      missing.push(`network:${expectedNetwork.method}:${expectedNetwork.url}`);
    }
  }

  for (const expectedChange of expected.dom?.changes ?? []) {
    if (expectedChange.significance === "low") continue;
    expectedSignals += expectedChange.significance === "high" ? 2 : 1;
    const found = (observed.dom?.changes ?? []).some((actual) => domChangeMatches(expectedChange, actual));
    if (found) {
      matchedSignals += expectedChange.significance === "high" ? 2 : 1;
      matched.push(`dom:${expectedChange.kind}:${expectedChange.role ?? ""}:${expectedChange.name ?? ""}`);
    } else {
      missing.push(`dom:${expectedChange.kind}:${expectedChange.role ?? ""}:${expectedChange.name ?? ""}`);
    }
  }

  if (unexpected.length) {
    return { status: "mismatch", score: 0, matched, missing, unexpected };
  }
  if (expectedSignals === 0) {
    return {
      status: "insufficient",
      score: 0,
      matched,
      missing,
      unexpected,
    };
  }

  const score = matchedSignals / expectedSignals;
  const status: ReplayEffectVerificationStatus =
    score >= 0.85 ? "matched" : score >= 0.4 ? "partial" : "mismatch";
  return { status, score, matched, missing, unexpected };
}
