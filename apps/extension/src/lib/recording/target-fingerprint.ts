import type { CaptureTargetDescriptor } from "@/lib/describe-target";

export interface CaptureFingerprintAttributes {
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

export interface CaptureSemanticAncestor {
  tag?: string;
  role?: string;
  name?: string;
}

/**
 * Durable target identity carried by trace v4. Geometry and @eN refs are
 * intentionally not part of this type: they are observation-local hints.
 */
export interface CaptureElementFingerprint {
  tag: string;
  role?: string;
  name?: string;
  attributes?: CaptureFingerprintAttributes;
  nearby_text?: string[];
  ancestors?: CaptureSemanticAncestor[];
}

export interface ObservationFingerprintEvidence {
  tag?: string;
  role?: string;
  name?: string;
  context?: string;
  attrs?: CaptureFingerprintAttributes;
}

function compact(value: string | undefined, max = 120): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/** Generated UUID/hash/react ids hurt replay more than they help. */
function stableId(value: string | undefined): string | undefined {
  const id = compact(value, 96);
  if (!id) return undefined;
  if (/^\d+$/.test(id)) return undefined;
  if (/^:[a-z0-9_-]+:$/i.test(id)) return undefined;
  if (/^[0-9a-f]{12,}$/i.test(id)) return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return undefined;
  }
  return id;
}

function compactAttributes(
  attrs: CaptureFingerprintAttributes | undefined,
): CaptureFingerprintAttributes | undefined {
  if (!attrs) return undefined;
  const id = stableId(attrs.id);
  const name = compact(attrs.name);
  const inputType = compact(attrs.input_type, 40)?.toLowerCase();
  const testId = compact(attrs.test_id);
  const dataTest = compact(attrs.data_test);
  const dataCy = compact(attrs.data_cy);
  const ariaLabel = compact(attrs.aria_label);
  const ariaControls = compact(attrs.aria_controls);
  const ariaHaspopup = compact(attrs.aria_haspopup, 40)?.toLowerCase();
  const placeholder = compact(attrs.placeholder);
  const result: CaptureFingerprintAttributes = {
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
  return Object.keys(result).length ? result : undefined;
}

/**
 * Build the baseline fingerprint from the descriptor already captured in the
 * content script. Observation-time matching enriches it with allowlisted DOM
 * attributes after the action has been matched to a concrete VOM node.
 */
export function fingerprintFromCaptureTarget(
  target: CaptureTargetDescriptor | undefined,
): CaptureElementFingerprint | undefined {
  if (!target) return undefined;
  const attributes = compactAttributes({
    ...(target.name_attr ? { name: target.name_attr } : {}),
    ...(target.placeholder ? { placeholder: target.placeholder } : {}),
  });
  return {
    tag: target.tag,
    ...(target.role ? { role: target.role } : {}),
    ...(target.name ? { name: target.name } : {}),
    ...(attributes ? { attributes } : {}),
    ...(target.nearby_label ? { nearby_text: [target.nearby_label] } : {}),
  };
}

/** Merge post-match DOM/AX evidence without ever copying observation-local refs. */
export function enrichTargetFingerprint(
  base: CaptureElementFingerprint | undefined,
  evidence: ObservationFingerprintEvidence,
): CaptureElementFingerprint | undefined {
  const tag = compact(evidence.tag, 40) ?? base?.tag;
  if (!tag) return base;
  const role = compact(evidence.role, 60) ?? base?.role;
  const name = compact(evidence.name) ?? base?.name;
  const attributes = compactAttributes({
    ...(base?.attributes ?? {}),
    ...(evidence.attrs ?? {}),
  });
  const nearby = [
    ...(base?.nearby_text ?? []),
    ...(compact(evidence.context) ? [compact(evidence.context)!] : []),
  ].filter((value, index, values) => value !== name && values.indexOf(value) === index);
  return {
    tag: tag.toLowerCase(),
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(attributes ? { attributes } : {}),
    ...(nearby.length ? { nearby_text: nearby.slice(0, 3) } : {}),
    ...(base?.ancestors?.length ? { ancestors: base.ancestors.slice(0, 4) } : {}),
  };
}
