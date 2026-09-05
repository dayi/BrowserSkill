import { describe, expect, it } from "vitest";
import { projectFingerprintAttrs } from "./record-safe-observation";

describe("record-safe fingerprint attributes", () => {
  it("keeps replay identity attributes but excludes values and page data", () => {
    const projected = projectFingerprintAttrs({
      id: "approve-button",
      name: "approve",
      type: "BUTTON",
      "data-testid": "submit-approval",
      "data-test": "approval-submit",
      "data-cy": "approve",
      "aria-label": "提交审批",
      "aria-controls": "approval-dialog",
      "aria-haspopup": "dialog",
      placeholder: "请输入审批意见",
      value: "secret form value",
      class: "ant-btn ant-btn-primary generated-4123",
      style: "color:red",
      href: "https://example.test/private?token=secret",
      onclick: "submitApproval()",
    });

    expect(projected).toEqual({
      id: "approve-button",
      name: "approve",
      input_type: "button",
      test_id: "submit-approval",
      data_test: "approval-submit",
      data_cy: "approve",
      aria_label: "提交审批",
      aria_controls: "approval-dialog",
      aria_haspopup: "dialog",
      placeholder: "请输入审批意见",
    });
    expect(JSON.stringify(projected)).not.toContain("secret form value");
    expect(JSON.stringify(projected)).not.toContain("generated-4123");
    expect(JSON.stringify(projected)).not.toContain("token=secret");
    expect(JSON.stringify(projected)).not.toContain("submitApproval");
  });

  it("returns undefined when no allowlisted identity attribute is present", () => {
    expect(
      projectFingerprintAttrs({
        value: "sensitive",
        class: "button",
        href: "/business/42",
      }),
    ).toBeUndefined();
  });
});
