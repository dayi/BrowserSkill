import { VOM_FORMAT_VERSION, type StopReason } from "@/transport/types";
import { resolveDraftStartUrl } from "./draft-policy";
import { semanticStateDiff } from "./state-diff";
import type { RecordedStateEntry, RecordingStateRegistry } from "./state-registry";
import {
  CAUSAL_FORMAT_VERSION,
  TRACE_VERSION_V4,
  type RecordDiagnosticsLevelV4,
  type RecordEffectKindV4,
  type StepEffectsV4,
  type StepV4,
  type TraceStateV4,
  type TraceV4,
} from "./trace-v4-types";
import { reduceTraceStepsV4 } from "./trace-reducer-v4";
import { formatTraceStateBody } from "./trace-state-body";
import type { RecordingDraftStep, StepAnnotation } from "./types";

/** Effects implemented by the P0 causal recorder. JavaScript profiler evidence
 * remains intentionally deferred and is therefore never advertised here. */
const SUPPORTED_EFFECTS: RecordEffectKindV4[] = [
  "dom",
  "network",
  "console",
  "navigation",
  "security",
  "browser",
];

function effectiveEffects(requested: RecordEffectKindV4[] | undefined): RecordEffectKindV4[] {
  if (requested === undefined) return [...SUPPORTED_EFFECTS];
  const supported = new Set<RecordEffectKindV4>(SUPPORTED_EFFECTS);
  return [...new Set(requested.filter((kind) => supported.has(kind)))];
}

function filterEffects(effects: StepEffectsV4, enabled: Set<RecordEffectKindV4>): StepEffectsV4 {
  return {
    ...(enabled.has("dom") && effects.dom ? { dom: effects.dom } : {}),
    ...(enabled.has("network") && effects.network?.length ? { network: effects.network } : {}),
    ...(enabled.has("console") && effects.console?.length ? { console: effects.console } : {}),
    ...(enabled.has("navigation") && effects.navigation?.length
      ? { navigation: effects.navigation }
      : {}),
    ...(enabled.has("security") && effects.security?.length ? { security: effects.security } : {}),
    ...(enabled.has("browser") && effects.browser?.length ? { browser: effects.browser } : {}),
  };
}

function applyEffectFilter(
  drafts: RecordingDraftStep[],
  enabledKinds: RecordEffectKindV4[],
): void {
  const enabled = new Set(enabledKinds);
  for (const draft of drafts) {
    if (!draft.causal?.effects) continue;
    draft.causal.effects = filterEffects(draft.causal.effects, enabled);
  }
}

function publishedEntries(registry: RecordingStateRegistry, steps: StepV4[]): RecordedStateEntry[] {
  const entries = registry.values();
  if (steps.length === 0) return entries.slice(0, 1);
  const referenced = new Set(steps.flatMap((step) => [step.state, step.result.state]));
  return entries.filter((entry) => referenced.has(entry.id));
}

function remapDraftIds(draftIds: number[], stepIdByDraftId: Map<number, number>): number[] {
  return [
    ...new Set(
      draftIds.flatMap((id) => {
        const stepId = stepIdByDraftId.get(id);
        return stepId === undefined ? [] : [stepId];
      }),
    ),
  ].sort((a, b) => a - b);
}

function attachSemanticChanges(registry: RecordingStateRegistry, drafts: RecordingDraftStep[]): void {
  for (const draft of drafts) {
    if (!draft.preStateId || !draft.postStateId) continue;
    const changes = semanticStateDiff(registry.get(draft.preStateId), registry.get(draft.postStateId));
    if (!changes.length) continue;
    draft.causal ??= {};
    const previous: StepEffectsV4 = draft.causal.effects ?? {};
    draft.causal.effects = {
      ...previous,
      dom: {
        mutation_count: previous.dom?.mutation_count ?? draft.causal.activityDelta?.mutationCount ?? 0,
        ...(previous.dom?.activity_duration_ms !== undefined
          ? { activity_duration_ms: previous.dom.activity_duration_ms }
          : draft.causal.activityDelta?.activityDurationMs !== undefined
            ? { activity_duration_ms: draft.causal.activityDelta.activityDurationMs }
            : {}),
        changes,
      },
    };
  }
}

export function buildTraceV4(input: {
  registry: RecordingStateRegistry;
  drafts: RecordingDraftStep[];
  annotations?: readonly StepAnnotation[];
  startedAt: string;
  purpose?: string;
  startUrl?: string;
  stoppedBy: StopReason;
  bskVersion: string;
  redactValues?: boolean;
  includeTabSwitches?: boolean;
  diagnostics?: RecordDiagnosticsLevelV4;
  captureEffects?: RecordEffectKindV4[];
  settleMaxMs?: number;
}): TraceV4 {
  const enabledEffects = effectiveEffects(input.captureEffects);
  attachSemanticChanges(input.registry, input.drafts);
  // Filter before reduction so `result.observation` is derived from exactly
  // the evidence that will be exported, rather than from hidden/discarded data.
  applyEffectFilter(input.drafts, enabledEffects);

  const reduced = reduceTraceStepsV4(input.drafts, {
    startedAt: input.startedAt,
    includeTabSwitches: input.includeTabSwitches,
    redactValues: input.redactValues,
  });
  const entries = publishedEntries(input.registry, reduced.steps);
  const publishedId = new Map(entries.map((entry, index) => [entry.id, `s${index + 1}`]));
  const annotationsByState = new Map<string, StepAnnotation[]>();
  for (const annotation of input.annotations ?? []) {
    const bucket = annotationsByState.get(annotation.stateId) ?? [];
    bucket.push(annotation);
    annotationsByState.set(annotation.stateId, bucket);
  }
  const steps = reduced.steps.map((step) => ({
    ...step,
    state: publishedId.get(step.state) ?? step.state,
    result: {
      ...step.result,
      state: publishedId.get(step.result.state) ?? step.result.state,
    },
  }));
  const parsedStartedAt = Date.parse(input.startedAt);
  const startedAtMs = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now();
  const states: TraceStateV4[] = entries.map((entry) => {
    const id = publishedId.get(entry.id) ?? entry.id;
    return {
      id,
      url: entry.url,
      ...(entry.title ? { title: entry.title } : {}),
      body: formatTraceStateBody({
        stateId: id,
        url: entry.url,
        title: entry.title,
        stepIds: remapDraftIds(entry.stepsHere, reduced.stepIdByDraftId),
        vomText: entry.vomText,
        annotations: annotationsByState.get(entry.id) ?? [],
        stepIdByDraftId: reduced.stepIdByDraftId,
      }),
      ...(entry.truncated ? { truncated: true } : {}),
      capture: {
        recording_offset_ms: Math.max(0, entry.capturedAtMs - startedAtMs),
      },
    };
  });

  return {
    version: TRACE_VERSION_V4,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    recorded_at: new Date().toISOString(),
    started_at: input.startedAt,
    stopped_by: input.stoppedBy,
    entry: { start_url: resolveDraftStartUrl(input.drafts, input.startUrl, states[0]?.url) },
    recorder: {
      bsk: input.bskVersion,
      vom: VOM_FORMAT_VERSION,
      causal: CAUSAL_FORMAT_VERSION,
    },
    capture: {
      diagnostics: input.diagnostics ?? "standard",
      effects: enabledEffects,
      ...(input.settleMaxMs !== undefined ? { settle_max_ms: input.settleMaxMs } : {}),
      ...(input.redactValues !== undefined ? { redact_values: input.redactValues } : {}),
    },
    states,
    steps,
  };
}
