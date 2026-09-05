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

/**
 * Build the baseline fingerprint from the descriptor already captured in the
 * content script. Observation-time matching may enrich role/name/context, but
 * these fields survive ref regeneration and viewport/layout changes.
 */
export function fingerprintFromCaptureTarget(
  target: CaptureTargetDescriptor | undefined,
): CaptureElementFingerprint | undefined {
  if (!target) return undefined;
  const attributes: CaptureFingerprintAttributes = {
    ...(target.name_attr ? { name: target.name_attr } : {}),
    ...(target.placeholder ? { placeholder: target.placeholder } : {}),
  };
  const hasAttributes = Object.keys(attributes).length > 0;
  return {
    tag: target.tag,
    ...(target.role ? { role: target.role } : {}),
    ...(target.name ? { name: target.name } : {}),
    ...(hasAttributes ? { attributes } : {}),
    ...(target.nearby_label ? { nearby_text: [target.nearby_label] } : {}),
  };
}
