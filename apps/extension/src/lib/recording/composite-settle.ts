import type { CdpRunner } from "@/tools/shared";
import type { RecordingCausalRuntime } from "./causal-runtime";
import {
  type DocumentSettleScope,
  type SettleOutcome,
  waitForDocumentSettled,
} from "./document-settle";
import type { SettleReasonV4, SettleSummaryV4 } from "./trace-v4-types";

const DOM_QUIET_MS = 300;
const NETWORK_QUIET_MS = 300;
const HARD_MAX_MS = 8_000;
const DOM_PROBE_SLICE_MS = 2_000;

export interface CompositeSettleResult {
  reason: SettleReasonV4;
  startedEpochMs: number;
  endedEpochMs: number;
  domOutcome: SettleOutcome;
  summary: SettleSummaryV4;
}

/**
 * V4 settle policy: the document must be mutation-quiet and relevant
 * Document/XHR/Fetch activity must be drained and quiet. Long-lived sockets,
 * media, and unrelated resources never hold the action open.
 */
export async function waitForCompositeSettle(
  cdp: CdpRunner,
  causal: RecordingCausalRuntime,
  scope: DocumentSettleScope,
  options: { signal?: AbortSignal; hardMaxMs?: number } = {},
): Promise<CompositeSettleResult> {
  const startedEpochMs = Date.now();
  const hardDeadline = startedEpochMs + (options.hardMaxMs ?? HARD_MAX_MS);
  let lastDomOutcome: SettleOutcome = "quiet";

  for (;;) {
    if (options.signal?.aborted) {
      return result("cancelled", "cancelled", startedEpochMs, causal, scope.target.tabId);
    }
    const now = Date.now();
    if (now >= hardDeadline) {
      return result("timeout", lastDomOutcome, startedEpochMs, causal, scope.target.tabId);
    }

    const remaining = Math.max(1, hardDeadline - now);
    lastDomOutcome = await waitForDocumentSettled(cdp, scope, {
      signal: options.signal,
      quietMs: DOM_QUIET_MS,
      maxMs: Math.min(DOM_PROBE_SLICE_MS, remaining),
    });
    if (lastDomOutcome === "cancelled") {
      return result("cancelled", lastDomOutcome, startedEpochMs, causal, scope.target.tabId);
    }

    const network = causal.networkActivity(scope.target.tabId);
    if (
      lastDomOutcome === "quiet" &&
      network.pendingRelevantRequests === 0 &&
      network.quietForMs >= NETWORK_QUIET_MS
    ) {
      return result("quiet", lastDomOutcome, startedEpochMs, causal, scope.target.tabId);
    }

    if (Date.now() >= hardDeadline) {
      return result("timeout", lastDomOutcome, startedEpochMs, causal, scope.target.tabId);
    }
  }
}

function result(
  reason: SettleReasonV4,
  domOutcome: SettleOutcome,
  startedEpochMs: number,
  causal: RecordingCausalRuntime,
  tabId: number,
): CompositeSettleResult {
  const endedEpochMs = Date.now();
  const network = causal.networkActivity(tabId, endedEpochMs);
  const summary: SettleSummaryV4 = {
    reason,
    duration_ms: Math.max(0, endedEpochMs - startedEpochMs),
    ...(Number.isFinite(network.quietForMs)
      ? { network_quiet_ms: Math.max(0, network.quietForMs) }
      : {}),
    pending_relevant_requests: network.pendingRelevantRequests,
  };
  return {
    reason,
    startedEpochMs,
    endedEpochMs,
    domOutcome,
    summary,
  };
}
