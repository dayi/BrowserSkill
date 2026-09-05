import type { NavigationCause } from "@/transport/types";
import { shouldIncludeDraft } from "./draft-policy";
import { hasRedirectQualifier } from "./navigation-policy";
import type {
  ObservationOutcomeV4,
  StepCommonV4,
  StepEffectsV4,
  StepV4,
  TargetDescriptorV4,
} from "./trace-v4-types";
import type { RecordingDraftStep } from "./types";

interface CollapsedDraft {
  draft: RecordingDraftStep;
  draftIds: number[];
}

const TRANSITION_CAUSES: Record<string, NavigationCause> = {
  typed: "user_typed",
  generated: "user_typed",
  keyword: "user_typed",
  keyword_generated: "user_typed",
  link: "link",
  form_submit: "form_submit",
  reload: "reload",
  auto_bookmark: "browser",
  start_page: "browser",
};

function isRedirect(step: Extract<RecordingDraftStep, { op: "navigate" }>): boolean {
  return hasRedirectQualifier(step.transitionQualifiers);
}

function mergeEffectArrays<T>(left: T[] | undefined, right: T[] | undefined): T[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length ? merged : undefined;
}

function mergeEffects(left: StepEffectsV4 | undefined, right: StepEffectsV4 | undefined): StepEffectsV4 | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    ...(left.dom || right.dom ? { dom: right.dom ?? left.dom } : {}),
    ...(mergeEffectArrays(left.network, right.network)
      ? { network: mergeEffectArrays(left.network, right.network) }
      : {}),
    ...(mergeEffectArrays(left.navigation, right.navigation)
      ? { navigation: mergeEffectArrays(left.navigation, right.navigation) }
      : {}),
    ...(mergeEffectArrays(left.console, right.console)
      ? { console: mergeEffectArrays(left.console, right.console) }
      : {}),
    ...(mergeEffectArrays(left.security, right.security)
      ? { security: mergeEffectArrays(left.security, right.security) }
      : {}),
    ...(mergeEffectArrays(left.browser, right.browser)
      ? { browser: mergeEffectArrays(left.browser, right.browser) }
      : {}),
  };
}

function collapseRedirects(steps: RecordingDraftStep[]): CollapsedDraft[] {
  const output: CollapsedDraft[] = [];
  steps.forEach((step, index) => {
    const previous = output[output.length - 1];
    if (step.op === "navigate" && previous?.draft.op === "navigate" && isRedirect(step)) {
      const previousCausal = previous.draft.causal;
      previous.draft = {
        ...previous.draft,
        url: step.url,
        postStateId: step.postStateId ?? previous.draft.postStateId,
        postCapturedAtMs: step.postCapturedAtMs ?? previous.draft.postCapturedAtMs,
        causal:
          previousCausal || step.causal
            ? {
                ...(previousCausal ?? {}),
                ...(step.causal?.eventToSeq !== undefined ? { eventToSeq: step.causal.eventToSeq } : {}),
                ...(step.causal?.settle ? { settle: step.causal.settle } : {}),
                ...(mergeEffects(previousCausal?.effects, step.causal?.effects)
                  ? { effects: mergeEffects(previousCausal?.effects, step.causal?.effects) }
                  : {}),
              }
            : undefined,
      };
      previous.draftIds.push(index + 1);
      return;
    }
    output.push({ draft: { ...step }, draftIds: [index + 1] });
  });
  return output;
}

function navigationCause(step: Extract<RecordingDraftStep, { op: "navigate" }>): NavigationCause {
  if (step.cause) return step.cause;
  const qualifiers = step.transitionQualifiers ?? [];
  if (qualifiers.includes("forward_back")) return "history";
  if (qualifiers.includes("from_address_bar")) return "user_typed";
  return TRANSITION_CAUSES[step.transitionType ?? ""] ?? "browser";
}

function selection(values: string[], labels?: string[]): Array<{ value: string; label?: string }> {
  return values.map((value, index) => ({
    value,
    ...(labels?.[index] ? { label: labels[index] } : {}),
  }));
}

function targetDescriptor(draft: RecordingDraftStep): TargetDescriptorV4 | undefined {
  if (!("captureTarget" in draft) && !("matchedTarget" in draft)) return undefined;
  const matched = "matchedTarget" in draft ? draft.matchedTarget : undefined;
  const capture = "captureTarget" in draft ? draft.captureTarget : undefined;
  const fingerprint = "fingerprint" in draft ? draft.fingerprint : undefined;
  if (!matched && !capture && !fingerprint) return undefined;
  return {
    ...(matched?.ref ? { ref: matched.ref } : {}),
    ...(matched?.role ?? capture?.role ? { role: matched?.role ?? capture?.role } : {}),
    ...(matched?.name ?? capture?.name ? { name: matched?.name ?? capture?.name } : {}),
    ...(matched?.ctx ? { ctx: matched.ctx } : {}),
    ...(matched?.unmatched ? { unmatched: true } : {}),
    ...(fingerprint
      ? {
          fingerprint: {
            ...fingerprint,
            ...(fingerprint.role ?? matched?.role ? { role: fingerprint.role ?? matched?.role } : {}),
            ...(fingerprint.name ?? matched?.name ? { name: fingerprint.name ?? matched?.name } : {}),
          },
        }
      : {}),
  };
}

function withNavigationEffect(draft: RecordingDraftStep, effects: StepEffectsV4): StepEffectsV4 {
  if (!("navigatedTo" in draft) || !draft.navigatedTo || !draft.pageUrl || draft.navigatedTo === draft.pageUrl) {
    return effects;
  }
  const existing = effects.navigation ?? [];
  if (existing.some((item) => item.from === draft.pageUrl && item.to === draft.navigatedTo)) return effects;
  return {
    ...effects,
    navigation: [...existing, { from: draft.pageUrl, to: draft.navigatedTo }],
  };
}

function observationOutcome(
  draft: RecordingDraftStep,
  state: string,
  resultState: string,
  effects: StepEffectsV4,
): ObservationOutcomeV4 {
  if (effects.security?.length) return "blocked";
  if (effects.console?.some((entry) => entry.level === "error")) return "error";
  if (effects.navigation?.length || ("navigatedTo" in draft && draft.navigatedTo)) return "navigation";
  if (
    state !== resultState ||
    effects.dom?.mutation_count ||
    effects.dom?.changes?.length ||
    effects.network?.length ||
    effects.browser?.length
  ) {
    return "changed";
  }
  return "unchanged";
}

function commonForDraft(
  draft: RecordingDraftStep,
  id: number,
  startedAtMs: number,
): StepCommonV4 | null {
  const state = draft.preStateId ?? draft.postStateId;
  const resultState = draft.postStateId ?? draft.preStateId;
  if (!state || !resultState) return null;
  const actionEpochMs =
    draft.causal?.actionEpochMs ?? draft.preCapturedAtMs ?? draft.postCapturedAtMs ?? startedAtMs;
  const settledEpochMs = draft.postCapturedAtMs ?? actionEpochMs;
  const effects = withNavigationEffect(draft, draft.causal?.effects ?? {});
  const durationMs = Math.max(0, settledEpochMs - actionEpochMs);
  return {
    id,
    state,
    timing: {
      action_at_ms: Math.max(0, actionEpochMs - startedAtMs),
      ...(draft.causal?.receivedEpochMs !== undefined
        ? { received_at_ms: Math.max(0, draft.causal.receivedEpochMs - startedAtMs) }
        : {}),
      settled_at_ms: Math.max(0, settledEpochMs - startedAtMs),
      duration_ms: durationMs,
    },
    settle: draft.causal?.settle ?? { reason: "unknown", duration_ms: durationMs },
    effects,
    result: {
      state: resultState,
      observation: observationOutcome(draft, state, resultState, effects),
    },
  };
}

interface ReduceDraftOptions {
  includeTabSwitches: boolean;
  redactValues: boolean;
  startedAtMs: number;
}

function reduceDraft(
  draft: RecordingDraftStep,
  id: number,
  options: ReduceDraftOptions,
): StepV4 | null {
  if (!shouldIncludeDraft(draft)) return null;
  if (draft.op === "switch_tab") {
    if (!options.includeTabSwitches || !draft.preStateId || !draft.postStateId) return null;
    const common = commonForDraft(draft, id, options.startedAtMs);
    return common ? { op: "switch_tab", ...common } : null;
  }
  const common = commonForDraft(draft, id, options.startedAtMs);
  if (!common) return null;

  switch (draft.op) {
    case "navigate":
      return { op: "navigate", ...common, to: draft.url, cause: navigationCause(draft) };
    case "click":
      return { op: "click", ...common, target: targetDescriptor(draft) ?? { unmatched: true } };
    case "hover":
      return { op: "hover", ...common, target: targetDescriptor(draft) ?? { unmatched: true } };
    case "fill": {
      const fillIsRedacted = options.redactValues || draft.redacted === true;
      return {
        op: "fill",
        ...common,
        target: targetDescriptor(draft) ?? { unmatched: true },
        value: fillIsRedacted ? "***" : draft.value,
        commit: draft.commit ?? "blur",
        ...(fillIsRedacted ? { redacted: true } : {}),
      };
    }
    case "press":
      return {
        op: "press",
        ...common,
        key: draft.key,
        ...(draft.captureTarget || draft.matchedTarget || draft.fingerprint
          ? { target: targetDescriptor(draft) ?? { unmatched: true } }
          : {}),
        ...(draft.modifiers?.length ? { modifiers: draft.modifiers } : {}),
      };
    case "select":
      return {
        op: "select",
        ...common,
        target: targetDescriptor(draft) ?? { unmatched: true },
        ...(!options.redactValues ? { selection: selection(draft.values, draft.labels) } : {}),
      };
    case "scroll":
      return { op: "scroll", ...common };
  }
}

export interface ReducedTraceV4 {
  steps: StepV4[];
  stepIdByDraftId: Map<number, number>;
}

export function reduceTraceStepsV4(
  steps: RecordingDraftStep[],
  options: {
    startedAt: string;
    includeTabSwitches?: boolean;
    redactValues?: boolean;
  },
): ReducedTraceV4 {
  const output: StepV4[] = [];
  const stepIdByDraftId = new Map<number, number>();
  const parsedStartedAt = Date.parse(options.startedAt);
  const startedAtMs = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now();
  for (const { draft, draftIds } of collapseRedirects(steps)) {
    const step = reduceDraft(draft, output.length + 1, {
      includeTabSwitches: options.includeTabSwitches === true,
      redactValues: options.redactValues === true,
      startedAtMs,
    });
    if (!step) continue;
    output.push(step);
    for (const draftId of draftIds) stepIdByDraftId.set(draftId, step.id);
  }
  return { steps: output, stepIdByDraftId };
}
