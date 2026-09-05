import type { CaptureTargetDescriptor } from "@/lib/describe-target";
import type { DocumentActivityDelta, DocumentActivitySnapshot } from "./document-activity";
import type { CaptureElementFingerprint } from "./target-fingerprint";
import type { SettleSummaryV4, StepEffectsV4 } from "./trace-v4-types";
import type {
  FillCommit,
  KeyModifier,
  NavigationCause,
  StepV3,
  TargetDescriptorV3,
} from "@/transport/types";

export interface TargetGeometry {
  /** Top-level viewport-relative CSS pixels, as defined by the geometry module. */
  rect: { x: number; y: number; w: number; h: number };
  tag: string;
}

export interface TargetMatchHint {
  geometry?: TargetGeometry;
  /** Missing means top frame; null means the source Document could not be resolved. */
  frameId?: string | null;
  geometrySpace?: "top" | "local";
}

export interface StepAnnotation {
  draftId: number;
  op: StepV3["op"];
  line: number;
  stateId: string;
  detail?: string;
}

interface DraftStateLink {
  pageUrl?: string;
  preStateId?: string;
  postStateId?: string;
  /** Capture times are draft-local because registry state ids can be deduplicated. */
  preCapturedAtMs?: number;
  postCapturedAtMs?: number;
}

interface DraftTarget {
  captureTarget?: CaptureTargetDescriptor;
  fingerprint?: CaptureElementFingerprint;
  targetHint?: TargetMatchHint;
  matchedTarget?: TargetDescriptorV3;
}

interface DraftNavigationEffect {
  navigatedTo?: string;
}

/** Trace-v4-only evidence retained internally until reduction. */
export interface DraftCausalEvidence {
  actionEpochMs?: number;
  receivedEpochMs?: number;
  eventFromSeq?: number;
  eventToSeq?: number;
  settle?: SettleSummaryV4;
  effects?: StepEffectsV4;
  activityBefore?: DocumentActivitySnapshot | null;
  activityAfter?: DocumentActivitySnapshot | null;
  activityDelta?: DocumentActivityDelta;
}

type WithCausal = { causal?: DraftCausalEvidence };

export type RecordingDraftStep =
  | ({ op: "click" } & DraftStateLink & DraftTarget & DraftNavigationEffect & WithCausal)
  | ({ op: "hover" } & DraftStateLink & DraftTarget & WithCausal)
  | ({
      op: "fill";
      value: string;
      commit?: FillCommit;
      redacted?: boolean;
    } & DraftStateLink &
      DraftTarget &
      DraftNavigationEffect &
      WithCausal)
  | ({
      op: "press";
      key: string;
      modifiers?: KeyModifier[];
    } & DraftStateLink &
      DraftTarget &
      DraftNavigationEffect &
      WithCausal)
  | ({
      op: "select";
      values: string[];
      labels?: string[];
    } & DraftStateLink &
      DraftTarget &
      DraftNavigationEffect &
      WithCausal)
  | ({ op: "scroll" } & DraftStateLink & WithCausal)
  | ({ op: "switch_tab" } & DraftStateLink & WithCausal)
  | ({
      op: "navigate";
      url: string;
      cause?: NavigationCause;
      transitionType?: string;
      transitionQualifiers?: string[];
    } & DraftStateLink &
      WithCausal);

export type TargetedRecordingDraft = Extract<
  RecordingDraftStep,
  { op: "click" | "hover" | "fill" | "press" | "select" }
>;
