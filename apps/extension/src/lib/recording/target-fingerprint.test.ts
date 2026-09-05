import { describe, expect, it } from "vitest";
import {
  enrichTargetFingerprint,
  fingerprintFromCaptureTarget,
} from "./target-fingerprint";

describe("target fingerprint enrichment", () => {
  it("adds stable DOM identity from the VOM-matched node without carrying refs or geometry", () => {
    const base = fingerprintFromCaptureTarget({
      tag: "button",
      role: "button",
      name: "提交",
      name_attr: "submit",
    });
    const enriched = enrichTargetFingerprint(base, {
      tag: "button",
      role: "button",
      name: "提交审批",
      context: "审批流程 2026-09",
      attrs: {
        id: "approval-submit",
        test_id: "submit-approval",
        aria_label: "提交审批",
        aria_controls: "confirm-dialog",
      },
    });

    expect(enriched).toEqual({
      tag: "button",
      role: "button",
      name: "提交审批",
      attributes: {
        id: "approval-submit",
        name: "submit",
        test_id: "submit-approval",
        aria_label: "提交审批",
        aria_controls: "confirm-dialog",
      },
      nearby_text: ["审批流程 2026-09"],
    });
    expect(JSON.stringify(enriched)).not.toMatch(/"ref"|"rect"|backendNodeId/);
  });

  it("drops unstable generated ids instead of making replay depend on them", () => {
    const uuid = enrichTargetFingerprint(
      { tag: "input", role: "textbox", name: "搜索" },
      {
        attrs: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          test_id: "search-box",
        },
      },
    );
    expect(uuid?.attributes?.id).toBeUndefined();
    expect(uuid?.attributes?.test_id).toBe("search-box");

    const generatedHex = enrichTargetFingerprint(
      { tag: "button", role: "button", name: "确定" },
      { attrs: { id: "abcdef1234567890" } },
    );
    expect(generatedHex?.attributes).toBeUndefined();
  });

  it("keeps distinct nearby business context bounded and deduplicated", () => {
    const enriched = enrichTargetFingerprint(
      {
        tag: "button",
        role: "button",
        name: "查看",
        nearby_text: ["工单 10086", "工单 10086", "客户 A"],
      },
      { context: "状态：待处理" },
    );
    expect(enriched?.nearby_text).toEqual(["工单 10086", "客户 A", "状态：待处理"]);
  });
});
