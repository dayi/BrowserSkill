import type { Rect, RenderedRef, VomResult } from "@browser-skill/vom";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import { readRecordingDocumentIdentity } from "@/shared/recording-document-identity";
import type { CapturedSurfaceProbe } from "./capture";
import type { CapturedFrameDocument, FrameAxNode } from "./frame-capture";

/** Frame identity needed to resolve an `@eN` that lives in an iframe. */
export interface CaptureVomFrame {
  frameId: string;
  target: CdpTarget;
  parentFrameId?: string;
  ownerBackendNodeId?: number;
  /** BrowserSkill-generated identity for the recording agent in this Document. */
  recordingDocumentId?: string;
}

/** Strict allow-list of non-value DOM attributes safe to retain for replay identity. */
export interface CaptureVomFingerprintAttrs {
  id?: string;
  name?: string;
  input_type?: string;
  test_id?: string;
  data_test?: string;
  data_cy?: string;
  aria_label?: string;
  aria_controls?: string;
  aria_haspopup?: string;
  placeholder?: string;
}

/** Allowlisted geometry + identity hints used to match a recorded action to a rendered ref. */
export interface CaptureVomMatchNode {
  frameId: string;
  backendNodeId: number;
  tag: string;
  /** Top-level viewport-relative geometry. */
  rect: Rect | null;
  /** Frame-local viewport-relative geometry, when available. */
  localRect?: Rect | null;
  /** No input value/textContent/class/style/href is exposed here. */
  fingerprintAttrs?: CaptureVomFingerprintAttrs;
}

/**
 * Raw AX/DOM trees are never returned. When `redactValues` is enabled by the
 * caller, form values in `text` are masked as well.
 */
export interface CaptureVomObservationResult {
  text: string;
  refs: RenderedRef[];
  truncated: boolean;
  rootFrameId: string;
  frames: CaptureVomFrame[];
  matchNodes: CaptureVomMatchNode[];
  surfaceProbes?: CapturedSurfaceProbe[];
  /**
   * Whether this observation actively hovered the page, and whether that
   * revealed content the static tree does not contain. Lets callers judge how
   * far the page may have drifted from the returned snapshot.
   */
  hoverProbe?: HoverProbeReport;
}

export interface HoverProbeReport {
  performed: boolean;
  revealedContent: boolean;
}

function projectFrames(documents: CapturedFrameDocument<FrameAxNode>[]): CaptureVomFrame[] {
  return documents.map((document) => {
    let recordingDocumentId: string | undefined;
    for (const node of document.domNodes) {
      recordingDocumentId = readRecordingDocumentIdentity(node.attrs);
      if (recordingDocumentId) break;
    }
    return {
      frameId: document.frameId,
      target: document.target,
      ...(document.parentFrameId ? { parentFrameId: document.parentFrameId } : {}),
      ...(document.ownerBackendNodeId !== undefined
        ? { ownerBackendNodeId: document.ownerBackendNodeId }
        : {}),
      ...(recordingDocumentId ? { recordingDocumentId } : {}),
    };
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** Exported for a narrow unit test; callers should consume matchNodes instead. */
export function projectFingerprintAttrs(
  attrs: Record<string, string>,
): CaptureVomFingerprintAttrs | undefined {
  const id = nonEmpty(attrs.id);
  const name = nonEmpty(attrs.name);
  const inputType = nonEmpty(attrs.type)?.toLowerCase();
  const testId = nonEmpty(attrs["data-testid"]);
  const dataTest = nonEmpty(attrs["data-test"]);
  const dataCy = nonEmpty(attrs["data-cy"]);
  const ariaLabel = nonEmpty(attrs["aria-label"]);
  const ariaControls = nonEmpty(attrs["aria-controls"]);
  const ariaHaspopup = nonEmpty(attrs["aria-haspopup"]);
  const placeholder = nonEmpty(attrs.placeholder);
  const projected: CaptureVomFingerprintAttrs = {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(inputType ? { input_type: inputType } : {}),
    ...(testId ? { test_id: testId } : {}),
    ...(dataTest ? { data_test: dataTest } : {}),
    ...(dataCy ? { data_cy: dataCy } : {}),
    ...(ariaLabel ? { aria_label: ariaLabel } : {}),
    ...(ariaControls ? { aria_controls: ariaControls } : {}),
    ...(ariaHaspopup ? { aria_haspopup: ariaHaspopup } : {}),
    ...(placeholder ? { placeholder } : {}),
  };
  return Object.keys(projected).length ? projected : undefined;
}

function projectMatchNodes(documents: CapturedFrameDocument<FrameAxNode>[]): CaptureVomMatchNode[] {
  return documents.flatMap((document) =>
    document.domNodes.map((node) => {
      const fingerprintAttrs = projectFingerprintAttrs(node.attrs);
      return {
        frameId: document.frameId,
        backendNodeId: node.backendNodeId,
        tag: node.tag,
        rect: node.rect,
        ...(node.localRect !== undefined ? { localRect: node.localRect } : {}),
        ...(fingerprintAttrs ? { fingerprintAttrs } : {}),
      };
    }),
  );
}

export function projectRecordSafeObservation(input: {
  rootFrameId: string;
  frameDocuments: CapturedFrameDocument<FrameAxNode>[];
  rendered: VomResult;
  surfaceProbes?: CapturedSurfaceProbe[];
  hoverProbe?: HoverProbeReport;
}): CaptureVomObservationResult {
  return {
    text: input.rendered.text,
    refs: input.rendered.refs,
    truncated: input.rendered.truncated,
    rootFrameId: input.rootFrameId,
    frames: projectFrames(input.frameDocuments),
    matchNodes: projectMatchNodes(input.frameDocuments),
    surfaceProbes: input.surfaceProbes,
    ...(input.hoverProbe ? { hoverProbe: input.hoverProbe } : {}),
  };
}
