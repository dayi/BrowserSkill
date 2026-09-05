import { describe, expect, it } from "vitest";
import { RecordingStateRegistry } from "./state-registry";
import { buildTraceV4 } from "./trace-builder-v4";
import type { RecordingDraftStep } from "./types";

describe("buildTraceV4 effect selection", () => {
  it("exports only enabled effects and derives observation from the exported evidence", () => {
    const registry = new RecordingStateRegistry();
    const state = registry.register({
      url: "https://oa.example.test/form",
      title: "审批",
      vomText: '@vom 1\nbutton "提交"',
      capturedAtMs: 1_000,
    });
    const drafts: RecordingDraftStep[] = [
      {
        op: "click",
        pageUrl: state.url,
        preStateId: state.id,
        postStateId: state.id,
        causal: {
          actionEpochMs: 1_010,
          receivedEpochMs: 1_020,
          settle: { reason: "quiet", duration_ms: 40 },
          effects: {
            network: [
              {
                method: "POST",
                url: "https://oa.example.test/api/approve?id=%3Credacted%3E",
                status: 200,
              },
            ],
            security: [
              {
                code: "browser_policy",
                source: "audits",
                confidence: "explicit",
              },
            ],
          },
        },
      },
    ];

    const trace = buildTraceV4({
      registry,
      drafts,
      startedAt: new Date(1_000).toISOString(),
      stoppedBy: "cli_stop",
      bskVersion: "0.2.0",
      captureEffects: ["network"],
    });

    expect(trace.capture.effects).toEqual(["network"]);
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]?.effects.network).toHaveLength(1);
    expect(trace.steps[0]?.effects.security).toBeUndefined();
    expect(trace.steps[0]?.result.observation).toBe("changed");
  });

  it("does not advertise deferred javascript profiling as captured evidence", () => {
    const registry = new RecordingStateRegistry();
    const state = registry.register({
      url: "https://example.test/",
      vomText: "@vom 1",
      capturedAtMs: 2_000,
    });
    const trace = buildTraceV4({
      registry,
      drafts: [],
      startedAt: new Date(2_000).toISOString(),
      stoppedBy: "cli_stop",
      bskVersion: "0.2.0",
      captureEffects: ["javascript"],
    });

    expect(trace.capture.effects).toEqual([]);
    expect(trace.states[0]?.id).toBe(state.id);
  });
});
