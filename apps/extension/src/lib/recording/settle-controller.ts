import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import type { RecordingCausalRuntime } from "./causal-runtime";
import { waitForCompositeSettle } from "./composite-settle";
import { activityDelta, type DocumentActivityManager } from "./document-activity";
import { type DocumentSettleScope, waitForDocumentSettled } from "./document-settle";
import { RecordingObservationSession } from "./observation-session";
import type { SettleSummaryV4, StepEffectsV4 } from "./trace-v4-types";
import type { RecordingDraftStep } from "./types";

interface PendingSettle {
  abort: AbortController;
  scope: DocumentSettleScope;
}

interface PendingRedirect {
  url: string;
  abort: AbortController;
}

const CAPTURE_RETRY_DELAY_MS = 250;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "AbortError"
  );
}

function mergeEffects(base: StepEffectsV4 | undefined, next: StepEffectsV4): StepEffectsV4 {
  return {
    ...(base ?? {}),
    ...next,
    ...(base?.network || next.network
      ? { network: [...(base?.network ?? []), ...(next.network ?? [])] }
      : {}),
    ...(base?.console || next.console
      ? { console: [...(base?.console ?? []), ...(next.console ?? [])] }
      : {}),
    ...(base?.security || next.security
      ? { security: [...(base?.security ?? []), ...(next.security ?? [])] }
      : {}),
    ...(base?.navigation || next.navigation
      ? { navigation: [...(base?.navigation ?? []), ...(next.navigation ?? [])] }
      : {}),
    ...(base?.browser || next.browser
      ? { browser: [...(base?.browser ?? []), ...(next.browser ?? [])] }
      : {}),
  };
}

export function inferMissingPostStates(drafts: RecordingDraftStep[]): void {
  for (let index = 0; index < drafts.length - 1; index += 1) {
    const draft = drafts[index];
    const next = drafts[index + 1];
    if (draft && next && !draft.postStateId && next.preStateId) {
      draft.postStateId = next.preStateId;
      draft.postCapturedAtMs = next.preCapturedAtMs;
    }
  }
}

export class SettleController {
  readonly #session: RecordingObservationSession;
  readonly #cdp: CdpRunner;
  readonly #tabsApi: ChromeTabsApi;
  readonly #tabId: number;
  readonly #rootScope: DocumentSettleScope;
  readonly #causal?: RecordingCausalRuntime;
  readonly #activity?: DocumentActivityManager;
  readonly #settleMaxMs?: number;
  readonly #pending = new Map<number, PendingSettle>();
  #queue = Promise.resolve();
  #pendingRedirect: PendingRedirect | null = null;
  #redirectQueue = Promise.resolve();

  constructor(input: {
    session: RecordingObservationSession;
    cdp: CdpRunner;
    tabsApi: ChromeTabsApi;
    tabId: number;
    causal?: RecordingCausalRuntime;
    activity?: DocumentActivityManager;
    settleMaxMs?: number;
  }) {
    this.#session = input.session;
    this.#cdp = input.cdp;
    this.#tabsApi = input.tabsApi;
    this.#tabId = input.tabId;
    this.#rootScope = { target: { tabId: input.tabId } };
    this.#causal = input.causal;
    this.#activity = input.activity;
    this.#settleMaxMs = input.settleMaxMs;
  }

  get hasPending(): boolean {
    return this.#pending.size > 0 || this.#pendingRedirect !== null;
  }

  async #captureWithRetry(signal?: AbortSignal) {
    try {
      return await this.#session.capture(this.#cdp, this.#tabsApi, this.#tabId, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      await delay(CAPTURE_RETRY_DELAY_MS, signal);
      return this.#session.capture(this.#cdp, this.#tabsApi, this.#tabId, signal);
    }
  }

  #finalizeCausalWindow(
    draft: RecordingDraftStep,
    settledEpochMs: number,
    settle?: SettleSummaryV4,
  ): void {
    if (!draft.causal || !this.#causal) return;
    const actionEpochMs = draft.causal.actionEpochMs ?? settledEpochMs;
    draft.causal.eventToSeq = this.#causal.latestSeq(this.#tabId);
    const effects = this.#causal.effectsForWindow({
      tabId: this.#tabId,
      actionEpochMs,
      settledEpochMs,
      ...(draft.causal.eventFromSeq !== undefined ? { fromSeq: draft.causal.eventFromSeq } : {}),
      ...(draft.causal.eventToSeq !== undefined ? { toSeq: draft.causal.eventToSeq } : {}),
    });
    draft.causal.effects = mergeEffects(draft.causal.effects, effects);
    if (settle) draft.causal.settle = settle;
  }

  #supersedeDraft(draft: RecordingDraftStep | undefined, next: RecordingDraftStep | undefined): void {
    if (!draft?.causal) return;
    const action = draft.causal.actionEpochMs ?? Date.now();
    const end = next?.causal?.actionEpochMs ?? Date.now();
    const settle: SettleSummaryV4 = {
      reason: "superseded_by_next_action",
      duration_ms: Math.max(0, end - action),
      ...(this.#causal
        ? { pending_relevant_requests: this.#causal.networkActivity(this.#tabId, end).pendingRelevantRequests }
        : {}),
    };
    draft.postCapturedAtMs ??= next?.preCapturedAtMs;
    this.#finalizeCausalWindow(draft, end, settle);
  }

  schedule(
    drafts: RecordingDraftStep[],
    draftIndex: number,
    scope: DocumentSettleScope = this.#rootScope,
  ): void {
    if (scope.target.tabId !== this.#tabId) {
      throw new Error(
        `settle scope tab ${scope.target.tabId} does not belong to tab ${this.#tabId}`,
      );
    }
    const currentDraft = drafts[draftIndex];
    const landing = currentDraft?.preStateId;
    for (const [index, pending] of this.#pending) {
      if (index >= draftIndex) continue;
      pending.abort.abort();
      this.#pending.delete(index);
      const previous = drafts[index];
      if (landing && previous && !previous.postStateId) {
        previous.postStateId = landing;
        previous.postCapturedAtMs = currentDraft?.preCapturedAtMs;
      }
      this.#supersedeDraft(previous, currentDraft);
    }

    this.#pending.get(draftIndex)?.abort.abort();
    const pending = { abort: new AbortController(), scope };
    this.#pending.set(draftIndex, pending);
    const task = async () => {
      if (pending.abort.signal.aborted) return;
      try {
        await this.#causal?.ensureTab(this.#tabId);
        let settleSummary: SettleSummaryV4 | undefined;
        if (this.#causal) {
          const composite = await waitForCompositeSettle(this.#cdp, this.#causal, pending.scope, {
            signal: pending.abort.signal,
            ...(this.#settleMaxMs !== undefined ? { hardMaxMs: this.#settleMaxMs } : {}),
          });
          if (composite.reason === "cancelled") return;
          settleSummary = composite.summary;
        } else {
          const outcome = await waitForDocumentSettled(this.#cdp, pending.scope, {
            signal: pending.abort.signal,
          });
          if (outcome === "cancelled") return;
        }

        const observation = await this.#captureWithRetry(pending.abort.signal);
        if (!pending.abort.signal.aborted && drafts[draftIndex]) {
          const draft = drafts[draftIndex]!;
          draft.postStateId = observation.stateId;
          draft.postCapturedAtMs = observation.capturedAtMs;
          if (draft.causal && this.#activity) {
            draft.causal.activityAfter = await this.#activity.read(pending.scope);
            draft.causal.activityDelta = activityDelta(
              draft.causal.activityBefore,
              draft.causal.activityAfter,
            );
            const delta = draft.causal.activityDelta;
            if (delta) {
              const dom = {
                mutation_count: delta.mutationCount,
                ...(delta.activityDurationMs !== undefined
                  ? { activity_duration_ms: delta.activityDurationMs }
                  : {}),
              };
              draft.causal.effects = mergeEffects(draft.causal.effects, { dom });
              if (settleSummary && delta.lastActivityEpochMs !== undefined) {
                settleSummary.dom_quiet_ms = Math.max(0, observation.capturedAtMs - delta.lastActivityEpochMs);
              }
            }
          }
          this.#finalizeCausalWindow(
            draft,
            settleSummary
              ? Math.min(observation.capturedAtMs, Date.now())
              : observation.capturedAtMs,
            settleSummary,
          );
        }
      } catch (error) {
        if (!isAbortError(error)) {
          console.warn(
            `[bsk record] post-action observation failed for step ${draftIndex + 1}`,
            error,
          );
        }
      } finally {
        if (this.#pending.get(draftIndex) === pending) this.#pending.delete(draftIndex);
      }
    };
    this.#queue = this.#queue.then(task, task).catch(() => {});
  }

  cancel(): void {
    for (const pending of this.#pending.values()) pending.abort.abort();
    this.#pending.clear();
    this.clearRedirect();
  }

  async flush(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const current = this.#queue;
      await current;
      if (current === this.#queue) return;
    }
    console.warn("[bsk record] settle queue kept growing; using completed observations");
  }

  async settleTrailing(drafts: RecordingDraftStep[]): Promise<void> {
    const trailing: RecordingDraftStep[] = [];
    for (let index = drafts.length - 1; index >= 0; index -= 1) {
      const draft = drafts[index];
      if (!draft || draft.postStateId) break;
      trailing.push(draft);
    }
    if (trailing.length === 0) return;
    try {
      const observation = await this.#captureWithRetry();
      const now = observation.capturedAtMs;
      for (const draft of trailing) {
        draft.postStateId = observation.stateId;
        draft.postCapturedAtMs = observation.capturedAtMs;
        if (draft.causal && !draft.causal.settle) {
          this.#finalizeCausalWindow(draft, now, {
            reason: "unknown",
            duration_ms: Math.max(0, now - (draft.causal.actionEpochMs ?? now)),
            ...(this.#causal
              ? { pending_relevant_requests: this.#causal.networkActivity(this.#tabId, now).pendingRelevantRequests }
              : {}),
          });
        }
      }
    } catch (error) {
      console.warn("[bsk record] final observation at stop failed", error);
    }
  }

  clearRedirect(): void {
    this.#pendingRedirect?.abort.abort();
    this.#pendingRedirect = null;
  }

  scheduleRedirect(drafts: RecordingDraftStep[], url: string): void {
    this.#pendingRedirect?.abort.abort();
    const pending: PendingRedirect = { url, abort: new AbortController() };
    this.#pendingRedirect = pending;
    const task = () => this.#settleRedirect(drafts, pending);
    this.#redirectQueue = this.#redirectQueue.then(task, task).catch(() => {});
  }

  async #settleRedirect(drafts: RecordingDraftStep[], pending: PendingRedirect): Promise<void> {
    const outcome = await waitForDocumentSettled(this.#cdp, this.#rootScope, {
      signal: pending.abort.signal,
    });
    if (outcome === "cancelled" || this.#pendingRedirect !== pending) return;

    let finalUrl = pending.url;
    try {
      finalUrl = (await this.#tabsApi.get(this.#tabId)).url || finalUrl;
    } catch {
      // The navigation event URL remains the best available destination.
    }
    if (this.#pendingRedirect !== pending) return;
    this.#pendingRedirect = null;
    if (
      !finalUrl ||
      finalUrl === "about:blank" ||
      this.#session.cursor.lastSettled?.url === finalUrl
    ) {
      return;
    }

    const last = drafts[drafts.length - 1];
    if (last?.op === "navigate" && last.url === finalUrl) {
      if (!last.postStateId) this.schedule(drafts, drafts.length - 1);
      await this.flush();
      return;
    }

    const now = Date.now();
    const draft: RecordingDraftStep = {
      op: "navigate",
      url: finalUrl,
      pageUrl: finalUrl,
      cause: "browser",
      transitionQualifiers: ["server_redirect"],
      preStateId: this.#session.cursor.lastSettled?.stateId,
      preCapturedAtMs: this.#session.cursor.lastSettled?.capturedAtMs,
      causal: {
        actionEpochMs: now,
        receivedEpochMs: now,
      },
    };
    drafts.push(draft);
    const draftIndex = drafts.length - 1;
    if (draft.preStateId) this.#session.registry.markStep(draft.preStateId, draftIndex + 1);
    this.schedule(drafts, draftIndex);
    await this.flush();
  }

  async flushRedirects(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const current = this.#redirectQueue;
      await current;
      if (current === this.#redirectQueue) return;
    }
    console.warn("[bsk record] redirect queue kept growing; using the final completed landing");
  }
}
