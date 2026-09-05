import { describe, expect, it } from "vitest";
import type { CaptureElementFingerprint } from "./target-fingerprint";
import { rankReplayTargets, verifyReplayEffects } from "./replay-evidence";

describe("rankReplayTargets", () => {
  it("prefers stable semantic identity over a stale observation-local ref", () => {
    const expected: CaptureElementFingerprint = {
      tag: "button",
      role: "button",
      name: "提交审批",
      attributes: { test_id: "submit-approval" },
      nearby_text: ["审批流程"],
    };

    const decision = rankReplayTargets(expected, [
      {
        ref: "e3",
        fingerprint: {
          tag: "button",
          role: "button",
          name: "取消",
          attributes: { test_id: "cancel" },
          nearby_text: ["审批流程"],
        },
        visible: true,
        enabled: true,
      },
      {
        // The new observation assigned a completely different @eN ref, but
        // stable semantic identity still points at the right control.
        ref: "e91",
        fingerprint: {
          tag: "button",
          role: "button",
          name: "提交审批",
          attributes: { test_id: "submit-approval" },
          nearby_text: ["审批流程"],
        },
        visible: true,
        enabled: true,
      },
    ]);

    expect(decision.best?.candidate.ref).toBe("e91");
    expect(decision.confidence).toBe("high");
    expect(decision.ambiguous).toBe(false);
  });

  it("marks near-equal semantic candidates as ambiguous instead of guessing", () => {
    const expected: CaptureElementFingerprint = {
      tag: "button",
      role: "button",
      name: "查看",
      nearby_text: ["工单 10086"],
    };
    const decision = rankReplayTargets(expected, [
      {
        ref: "e10",
        fingerprint: { tag: "button", role: "button", name: "查看" },
        visible: true,
        enabled: true,
      },
      {
        ref: "e11",
        fingerprint: { tag: "button", role: "button", name: "查看" },
        visible: true,
        enabled: true,
      },
    ]);

    expect(decision.ambiguous).toBe(true);
    expect(decision.confidence).toBe("low");
  });
});

describe("verifyReplayEffects", () => {
  it("accepts the same business effect even when redacted query values and exact 2xx status differ", () => {
    const result = verifyReplayEffects(
      {
        network: [
          {
            method: "POST",
            url: "https://oa.example.test/api/approve?id=%3Credacted%3E",
            status: 200,
          },
        ],
        dom: {
          mutation_count: 4,
          changes: [
            {
              kind: "appeared",
              role: "status",
              name: "提交成功",
              significance: "high",
            },
          ],
        },
      },
      {
        network: [
          {
            method: "POST",
            url: "https://oa.example.test/api/approve?id=%3Credacted%3E",
            status: 204,
          },
        ],
        dom: {
          mutation_count: 7,
          changes: [
            {
              kind: "appeared",
              role: "status",
              name: "提交成功",
              significance: "high",
            },
          ],
        },
      },
    );

    expect(result.status).toBe("matched");
    expect(result.score).toBe(1);
  });

  it("fails closed on a new browser security block", () => {
    const result = verifyReplayEffects(
      {
        network: [
          {
            method: "POST",
            url: "https://oa.example.test/api/approve",
            status: 200,
          },
        ],
      },
      {
        security: [
          {
            code: "csp_blocked",
            source: "audits",
            confidence: "explicit",
          },
        ],
      },
    );

    expect(result.status).toBe("mismatch");
    expect(result.unexpected).toContain("security:csp_blocked");
  });

  it("returns partial instead of recommending an unsafe blind retry when only some effects match", () => {
    const result = verifyReplayEffects(
      {
        navigation: [
          {
            from: "https://oa.example.test/list",
            to: "https://oa.example.test/detail/42",
          },
        ],
        network: [
          {
            method: "GET",
            url: "https://oa.example.test/api/detail?id=%3Credacted%3E",
            status: 200,
          },
        ],
      },
      {
        network: [
          {
            method: "GET",
            url: "https://oa.example.test/api/detail?id=%3Credacted%3E",
            status: 200,
          },
        ],
      },
    );

    expect(result.status).toBe("partial");
    expect(result.missing.some((item) => item.startsWith("navigation:"))).toBe(true);
  });
});
