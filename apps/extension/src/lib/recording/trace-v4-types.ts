import type { CaptureElementFingerprint } from "./target-fingerprint";
import type { FillCommit, KeyModifier, NavigationCause, StopReason } from "@/transport/types";

export const TRACE_VERSION_V4 = 4 as const;
export const CAUSAL_FORMAT_VERSION = 1 as const;

export type RecordDiagnosticsLevelV4 = "minimal" | "standard" | "deep";
export type RecordEffectKindV4 =
  | "dom"
  | "network"
  | "console"
  | "navigation"
  | "security"
  | "javascript"
  | "browser";

export interface TraceCaptureConfigV4 {
  diagnostics: RecordDiagnosticsLevelV4;
  effects: RecordEffectKindV4[];
  settle_max_ms?: number;
  redact_values?: boolean;
}

export interface TraceStateCaptureV4 {
  recording_offset_ms: number;
  dom_generation?: number;
  document_id?: string;
  frame_count?: number;
}

export interface TraceStateV4 {
  id: string;
  url: string;
  title?: string;
  body: string;
  truncated?: boolean;
  capture?: TraceStateCaptureV4;
}

export interface TargetDescriptorV4 {
  ref?: string;
  role?: string;
  name?: string;
  ctx?: string;
  unmatched?: boolean;
  fingerprint?: CaptureElementFingerprint;
}

export interface StepTimingV4 {
  action_at_ms: number;
  received_at_ms?: number;
  settled_at_ms?: number;
  duration_ms?: number;
}

export type SettleReasonV4 =
  | "quiet"
  | "timeout"
  | "cancelled"
  | "superseded_by_next_action"
  | "navigation"
  | "unknown";

export interface SettleSummaryV4 {
  reason: SettleReasonV4;
  duration_ms: number;
  dom_quiet_ms?: number;
  network_quiet_ms?: number;
  pending_relevant_requests?: number;
}

export type ChangeSignificanceV4 = "high" | "medium" | "low";
export type DomChangeKindV4 = "appeared" | "disappeared" | "text_changed" | "state_changed";

export interface DomChangeV4 {
  kind: DomChangeKindV4;
  role?: string;
  name?: string;
  context?: string;
  before?: string;
  after?: string;
  significance: ChangeSignificanceV4;
}

export interface DomEffectV4 {
  mutation_count: number;
  activity_duration_ms?: number;
  changes?: DomChangeV4[];
}

export interface StackFrameEvidenceV4 {
  function_name?: string;
  url?: string;
  line?: number;
  column?: number;
}

export interface NetworkEffectV4 {
  method: string;
  url: string;
  status?: number;
  error_text?: string;
  blocked_reason?: string;
  resource_type?: string;
  duration_ms?: number;
  initiator?: StackFrameEvidenceV4[];
}

export interface ConsoleEffectV4 {
  level: string;
  text: string;
  stack_trace?: StackFrameEvidenceV4[];
}

export interface NavigationEffectV4 {
  from: string;
  to: string;
  cause?: NavigationCause;
  redirect_count?: number;
}

export interface SecurityEffectV4 {
  code: string;
  message?: string;
  source: string;
  confidence: string;
}

export interface BrowserEffectV4 {
  kind: string;
  url?: string;
}

export interface StepEffectsV4 {
  dom?: DomEffectV4;
  network?: NetworkEffectV4[];
  navigation?: NavigationEffectV4[];
  console?: ConsoleEffectV4[];
  security?: SecurityEffectV4[];
  browser?: BrowserEffectV4[];
}

export type ObservationOutcomeV4 =
  | "changed"
  | "unchanged"
  | "navigation"
  | "blocked"
  | "error"
  | "unknown";

export interface StepResultV4 {
  state: string;
  observation: ObservationOutcomeV4;
}

export interface StepCommonV4 {
  id: number;
  state: string;
  timing: StepTimingV4;
  settle: SettleSummaryV4;
  effects: StepEffectsV4;
  result: StepResultV4;
}

export interface SelectedOptionV4 {
  value: string;
  label?: string;
}

export type StepV4 =
  | ({ op: "navigate" } & StepCommonV4 & { to: string; cause: NavigationCause })
  | ({ op: "switch_tab" } & StepCommonV4)
  | ({ op: "click" } & StepCommonV4 & { target: TargetDescriptorV4 })
  | ({ op: "hover" } & StepCommonV4 & { target: TargetDescriptorV4 })
  | ({ op: "fill" } & StepCommonV4 & {
      target: TargetDescriptorV4;
      value: string;
      commit: FillCommit;
      redacted?: boolean;
    })
  | ({ op: "select" } & StepCommonV4 & {
      target: TargetDescriptorV4;
      selection?: SelectedOptionV4[];
    })
  | ({ op: "press" } & StepCommonV4 & {
      key: string;
      modifiers?: KeyModifier[];
      target?: TargetDescriptorV4;
    })
  | ({ op: "scroll" } & StepCommonV4);

export interface TraceV4 {
  version: typeof TRACE_VERSION_V4;
  purpose?: string;
  started_at?: string;
  recorded_at: string;
  stopped_by: StopReason;
  entry: { start_url: string };
  recorder: {
    bsk: string;
    vom: number;
    causal: number;
  };
  capture: TraceCaptureConfigV4;
  states: TraceStateV4[];
  steps: StepV4[];
}
