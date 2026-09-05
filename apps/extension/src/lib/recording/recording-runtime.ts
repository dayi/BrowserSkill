import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import type { StopReason, TraceV3 } from "@/transport/types";
import type { RecordingCausalRuntime } from "./causal-runtime";
import { DocumentActivityManager } from "./document-activity";
import { type DocumentSettleScope, waitForDocumentSettled } from "./document-settle";
import type { RegisteredObservation } from "./observation-capture";
import { RecordingObservationSession } from "./observation-session";
import { inferMissingPostStates, SettleController } from "./settle-controller";
import { RecordingStateRegistry } from "./state-registry";
import { buildTraceV3 } from "./trace-builder-v3";
import type { RecordingDraftStep, StepAnnotation } from "./types";

interface TabRecordingContext {
  session: RecordingObservationSession;
  settle: SettleController;
  pendingCapture: PendingCapture | null;
  frameRefresh: Promise<void>;
  frameRefreshAbort: AbortController | null;
}

interface PendingCapture {
  promise: Promise<RegisteredObservation>;
  abort: AbortController;
}

export class RecordingObservationRuntime {
  readonly #cdp: CdpRunner;
  readonly #tabsApi: ChromeTabsApi;
  readonly #registry = new RecordingStateRegistry();
  readonly #annotations: StepAnnotation[] = [];
  readonly #contexts = new Map<number, TabRecordingContext>();
  readonly #maxTokens?: number;
  readonly #redactValues: boolean;
  readonly #causal?: RecordingCausalRuntime;
  readonly #activity?: DocumentActivityManager;
  readonly #settleMaxMs?: number;

  constructor(input: {
    cdp: CdpRunner;
    tabsApi: ChromeTabsApi;
    maxTokens?: number;
    redactValues?: boolean;
    causal?: RecordingCausalRuntime;
    settleMaxMs?: number;
  }) {
    this.#cdp = input.cdp;
    this.#tabsApi = input.tabsApi;
    this.#maxTokens = input.maxTokens;
    this.#redactValues = input.redactValues ?? false;
    this.#causal = input.causal;
    this.#activity = input.causal ? new DocumentActivityManager(input.cdp) : undefined;
    this.#settleMaxMs = input.settleMaxMs;
  }

  #rootScope(tabId: number): DocumentSettleScope {
    return { target: { tabId } };
  }

  #context(tabId: number): TabRecordingContext {
    const existing = this.#contexts.get(tabId);
    if (existing) return existing;
    const session = new RecordingObservationSession({
      registry: this.#registry,
      annotations: this.#annotations,
      maxTokens: this.#maxTokens,
      redactValues: this.#redactValues,
    });
    const context: TabRecordingContext = {
      session,
      settle: new SettleController({
        session,
        cdp: this.#cdp,
        tabsApi: this.#tabsApi,
        tabId,
        ...(this.#causal ? { causal: this.#causal } : {}),
        ...(this.#activity ? { activity: this.#activity } : {}),
        ...(this.#settleMaxMs !== undefined ? { settleMaxMs: this.#settleMaxMs } : {}),
      }),
      pendingCapture: null,
      frameRefresh: Promise.resolve(),
      frameRefreshAbort: null,
    };
    this.#contexts.set(tabId, context);
    return context;
  }

  async #capture(tabId: number): Promise<RegisteredObservation> {
    const context = this.#context(tabId);
    if (context.pendingCapture) return context.pendingCapture.promise;

    const abort = new AbortController();
    let pending!: PendingCapture;
    const promise = (async () => {
      const rootScope = this.#rootScope(tabId);
      await this.#causal?.ensureTab(tabId);
      // Install the long-lived activity observer before the state capture. It
      // remains active until navigation and therefore sees synchronous changes
      // caused by the next user action.
      await this.#activity?.ensure(rootScope);
      const observation = await context.session.capture(
        this.#cdp,
        this.#tabsApi,
        tabId,
        abort.signal,
      );
      await this.#activity?.read(rootScope);
      return observation;
    })();
    pending = {
      abort,
      promise: promise.finally(() => {
        if (context.pendingCapture === pending) context.pendingCapture = null;
      }),
    };
    context.pendingCapture = pending;
    return pending.promise;
  }

  async captureInitial(tabId: number): Promise<void> {
    const context = this.#context(tabId);
    if (context.session.cursor.lastSettled) return;
    await this.#capture(tabId);
  }

  /** Refresh the safe observation after a late child Document becomes usable. */
  async refreshDocument(tabId: number, producerId: string): Promise<void> {
    const context = this.#context(tabId);
    context.frameRefreshAbort?.abort();
    const abort = new AbortController();
    context.frameRefreshAbort = abort;
    const previous = context.frameRefresh;
    const refresh = (async () => {
      await previous;
      if (abort.signal.aborted) return;
      if (context.pendingCapture) await Promise.allSettled([context.pendingCapture.promise]);
      if (abort.signal.aborted) return;

      // The first capture discovers the safe producer -> CDP Document scope.
      await this.#capture(tabId);
      if (abort.signal.aborted) return;
      const scope = context.session.cursor.lastSettled?.index.documentScope(producerId);
      if (scope) {
        await this.#activity?.ensure(scope);
        await waitForDocumentSettled(this.#cdp, scope, { signal: abort.signal });
      }
      if (abort.signal.aborted) return;

      // Capture again after the child SPA is quiet so the next action can be
      // matched against refs that actually exist in its pre-action state.
      await this.#capture(tabId);
      if (scope) await this.#activity?.read(scope);
    })();
    const tracked = refresh.catch(() => {});
    context.frameRefresh = tracked;
    try {
      await refresh;
    } finally {
      if (context.frameRefresh === tracked) context.frameRefreshAbort = null;
    }
  }

  async captureTabTransition(
    fromTabId: number,
    toTabId: number,
  ): Promise<{
    preStateId?: string;
    postStateId?: string;
    targetUrl?: string;
    preCapturedAtMs?: number;
    postCapturedAtMs?: number;
  }> {
    const from = this.#context(fromTabId);
    await this.#flushContext(from);
    if (!from.session.cursor.lastSettled) {
      try {
        await this.captureInitial(fromTabId);
      } catch {
        // A target-tab observation can still preserve the forward transition.
      }
    }

    const to = this.#context(toTabId);
    let target = to.session.cursor.lastSettled;
    try {
      target = await this.#capture(toTabId);
    } catch {
      // Reuse the last settled target state when a refresh races navigation.
    }

    const source = from.session.cursor.lastSettled;
    return {
      ...(source
        ? { preStateId: source.stateId, preCapturedAtMs: source.capturedAtMs }
        : {}),
      ...(target
        ? {
            postStateId: target.stateId,
            postCapturedAtMs: target.capturedAtMs,
            targetUrl: target.url,
          }
        : {}),
    };
  }

  bindTabTransition(
    draft: Extract<RecordingDraftStep, { op: "switch_tab" }>,
    draftId: number,
  ): void {
    if (draft.preStateId) this.#registry.markStep(draft.preStateId, draftId);
  }

  async processDraft(
    tabId: number,
    drafts: RecordingDraftStep[],
    draftIndex: number,
    producerId?: string,
  ): Promise<void> {
    const draft = drafts[draftIndex];
    if (!draft) return;
    const context = this.#context(tabId);
    if (!context.session.cursor.lastSettled) {
      try {
        await this.captureInitial(tabId);
      } catch {
        // Post-action settle can still provide a usable state.
      }
    }
    const scope = producerId
      ? context.session.cursor.lastSettled?.index.documentScope(producerId)
      : undefined;
    const settleScope = scope ?? this.#rootScope(tabId);
    if (
      producerId &&
      (draft.op === "click" ||
        draft.op === "hover" ||
        draft.op === "fill" ||
        draft.op === "press" ||
        draft.op === "select")
    ) {
      draft.targetHint = {
        ...(draft.targetHint ?? {}),
        frameId: scope?.frameId ?? null,
        geometrySpace: "local",
      };
    }
    if (draft.causal) {
      await this.#causal?.ensureTab(tabId);
      // Never install a new probe after the action merely to manufacture a
      // baseline: last() is intentionally null when no pre-action observation
      // prepared this Document.
      draft.causal.activityBefore = this.#activity?.last(settleScope) ?? null;
    }
    context.session.bindDraft(draft, draftIndex + 1, context.settle.hasPending);
    context.settle.schedule(drafts, draftIndex, settleScope);
  }

  scheduleSettle(
    tabId: number,
    drafts: RecordingDraftStep[],
    draftIndex: number,
    scope?: DocumentSettleScope,
  ): void {
    this.#context(tabId).settle.schedule(drafts, draftIndex, scope);
  }

  clearRedirect(tabId: number): void {
    this.#contexts.get(tabId)?.settle.clearRedirect();
  }

  scheduleRedirect(tabId: number, drafts: RecordingDraftStep[], url: string): void {
    this.#context(tabId).settle.scheduleRedirect(drafts, url);
  }

  async #flushContext(context: TabRecordingContext): Promise<void> {
    await context.frameRefresh;
    if (context.pendingCapture) await Promise.allSettled([context.pendingCapture.promise]);
    await context.settle.flushRedirects();
    await context.settle.flush();
  }

  async flushRedirects(tabId: number): Promise<void> {
    await this.#contexts.get(tabId)?.settle.flushRedirects();
  }

  async flush(): Promise<void> {
    for (const context of this.#contexts.values()) await this.#flushContext(context);
  }

  async settleTrailing(tabId: number, drafts: RecordingDraftStep[]): Promise<void> {
    const context = this.#context(tabId);
    if (context.pendingCapture) await Promise.allSettled([context.pendingCapture.promise]);
    if (!context.session.cursor.lastSettled) {
      try {
        await this.captureInitial(tabId);
      } catch {
        // The trace may remain observation-free when CDP is unavailable.
      }
    }
    await context.settle.settleTrailing(drafts);
    inferMissingPostStates(drafts);
  }

  cancel(): void {
    for (const context of this.#contexts.values()) {
      context.frameRefreshAbort?.abort();
      context.pendingCapture?.abort.abort();
      context.settle.cancel();
    }
    this.#activity?.clear();
  }

  buildTrace(input: {
    drafts: RecordingDraftStep[];
    startedAt: string;
    purpose?: string;
    startUrl?: string;
    stoppedBy: StopReason;
    bskVersion: string;
    includeTabSwitches?: boolean;
  }): TraceV3 {
    return buildTraceV3({
      registry: this.#registry,
      drafts: input.drafts,
      annotations: this.#annotations,
      startedAt: input.startedAt,
      purpose: input.purpose,
      startUrl: input.startUrl,
      stoppedBy: input.stoppedBy,
      bskVersion: input.bskVersion,
      redactValues: this.#redactValues,
      includeTabSwitches: input.includeTabSwitches,
    });
  }

  /** Internal state registry used by the version-specific trace builder. */
  get registry(): RecordingStateRegistry {
    return this.#registry;
  }

  get annotations(): readonly StepAnnotation[] {
    return this.#annotations;
  }

  get redactValues(): boolean {
    return this.#redactValues;
  }
}
