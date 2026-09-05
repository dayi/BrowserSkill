import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpDebuggee } from "@/browser-driver/chromium-cdp";
import type { CdpRunner } from "@/tools/shared";
import { RecordingCausalRuntime, sanitizeRecordedUrl } from "./causal-runtime";

interface FakeCdp {
  cdp: CdpRunner;
  emit(source: CdpDebuggee, method: string, params: unknown): void;
}

function fakeCdp(): FakeCdp {
  let handler: ((source: CdpDebuggee, method: string, params: unknown) => void) | undefined;
  const send = async <T = unknown>(): Promise<T> => ({}) as T;
  const cdp: CdpRunner = {
    send,
    onEvent(next) {
      handler = next;
      return {
        dispose() {
          if (handler === next) handler = undefined;
        },
      };
    },
  };
  return {
    cdp,
    emit(source, method, params) {
      handler?.(source, method, params);
    },
  };
}

function setNow(ms: number): void {
  vi.setSystemTime(new Date(ms));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RecordingCausalRuntime", () => {
  it("keeps synchronous network effects even when the recorded step reaches background later", async () => {
    vi.useFakeTimers();
    const fake = fakeCdp();
    const runtime = new RecordingCausalRuntime(fake.cdp);
    const source: CdpDebuggee = { tabId: 7 };

    setNow(1_000);
    await runtime.ensureTab(7);
    const actionEpochMs = Date.now();

    // The page starts fetch() synchronously from the click handler. These CDP
    // events arrive before the content-script RECORD_STEP message reaches the
    // MV3 service worker.
    setNow(1_005);
    fake.emit(source, "Network.requestWillBeSent", {
      requestId: "request-1",
      timestamp: 10,
      type: "XHR",
      frameId: "frame-1",
      request: {
        method: "POST",
        url: "https://api.example.test/submit?token=secret&id=42",
      },
      initiator: {
        stack: {
          callFrames: [
            {
              functionName: "submitOrder",
              url: "https://app.example.test/order.js?build=123",
              lineNumber: 20,
              columnNumber: 4,
            },
          ],
        },
      },
    });

    setNow(1_012);
    fake.emit(source, "Network.responseReceived", {
      requestId: "request-1",
      response: { status: 200 },
    });

    setNow(1_025);
    fake.emit(source, "Network.loadingFinished", {
      requestId: "request-1",
      timestamp: 10.02,
    });

    // Model RECORD_STEP delivery latency: correlation happens only now, after
    // every network event above has already been journaled.
    setNow(1_080);
    const effects = runtime.effectsForWindow({
      tabId: 7,
      actionEpochMs,
      settledEpochMs: Date.now(),
    });

    expect(effects.network).toHaveLength(1);
    expect(effects.network?.[0]).toMatchObject({
      method: "POST",
      status: 200,
      resource_type: "XHR",
      duration_ms: 20,
    });
    expect(effects.network?.[0]?.url).toContain("token=%3Credacted%3E");
    expect(effects.network?.[0]?.url).not.toContain("secret");
    expect(effects.network?.[0]?.initiator?.[0]?.function_name).toBe("submitOrder");
    expect(effects.network?.[0]?.initiator?.[0]?.url).not.toContain("build=123");

    runtime.dispose();
  });

  it("tracks only Document/XHR/Fetch as settle-blocking requests", async () => {
    vi.useFakeTimers();
    const fake = fakeCdp();
    const runtime = new RecordingCausalRuntime(fake.cdp);
    const source: CdpDebuggee = { tabId: 11 };
    await runtime.ensureTab(11);

    setNow(2_000);
    fake.emit(source, "Network.requestWillBeSent", {
      requestId: "xhr",
      type: "Fetch",
      request: { method: "GET", url: "https://api.example.test/data" },
    });
    fake.emit(source, "Network.requestWillBeSent", {
      requestId: "socket",
      type: "WebSocket",
      request: { method: "GET", url: "wss://events.example.test/socket" },
    });
    expect(runtime.networkActivity(11).pendingRelevantRequests).toBe(1);

    setNow(2_050);
    fake.emit(source, "Network.loadingFinished", { requestId: "xhr" });
    expect(runtime.networkActivity(11).pendingRelevantRequests).toBe(0);

    runtime.dispose();
  });

  it("promotes explicit browser blocking into a security effect", async () => {
    vi.useFakeTimers();
    const fake = fakeCdp();
    const runtime = new RecordingCausalRuntime(fake.cdp);
    const source: CdpDebuggee = { tabId: 12 };
    await runtime.ensureTab(12);

    setNow(3_000);
    const actionEpochMs = Date.now();
    fake.emit(source, "Network.requestWillBeSent", {
      requestId: "blocked",
      type: "Fetch",
      request: { method: "GET", url: "https://cross.example.test/private?key=secret" },
    });
    setNow(3_010);
    fake.emit(source, "Network.loadingFailed", {
      requestId: "blocked",
      errorText: "net::ERR_FAILED",
      blockedReason: "cors",
      corsErrorStatus: { corsError: "DisallowedByMode" },
    });

    const effects = runtime.effectsForWindow({
      tabId: 12,
      actionEpochMs,
      settledEpochMs: 3_020,
    });
    expect(effects.security).toEqual([
      expect.objectContaining({
        code: "cors_blocked",
        source: "network",
        confidence: "explicit",
      }),
    ]);
    expect(effects.network?.[0]?.url).not.toContain("secret");

    runtime.dispose();
  });

  it("records explicit main-frame from-to navigation instead of a dead navigation_seen marker", async () => {
    vi.useFakeTimers();
    const fake = fakeCdp();
    const runtime = new RecordingCausalRuntime(fake.cdp);
    const source: CdpDebuggee = { tabId: 20 };
    await runtime.ensureTab(20);

    setNow(3_990);
    fake.emit(source, "Page.frameNavigated", {
      frame: { id: "main", url: "https://oa.example.test/list" },
    });
    setNow(4_000);
    const actionEpochMs = Date.now();
    setNow(4_015);
    fake.emit(source, "Page.frameNavigated", {
      frame: { id: "main", url: "https://oa.example.test/detail/42" },
    });

    const effects = runtime.effectsForWindow({
      tabId: 20,
      actionEpochMs,
      settledEpochMs: 4_050,
    });
    expect(effects.navigation).toEqual([
      {
        from: "https://oa.example.test/list",
        to: "https://oa.example.test/detail/42",
      },
    ]);
    runtime.dispose();
  });

  it("keeps each HTTP redirect leg when CDP reuses requestId", async () => {
    vi.useFakeTimers();
    const fake = fakeCdp();
    const runtime = new RecordingCausalRuntime(fake.cdp);
    const source: CdpDebuggee = { tabId: 21 };
    await runtime.ensureTab(21);

    setNow(5_000);
    const actionEpochMs = Date.now();
    setNow(5_005);
    fake.emit(source, "Network.requestWillBeSent", {
      requestId: "redirected",
      timestamp: 20,
      type: "Document",
      request: { method: "GET", url: "https://example.test/start" },
    });
    setNow(5_010);
    fake.emit(source, "Network.requestWillBeSent", {
      requestId: "redirected",
      timestamp: 20.01,
      type: "Document",
      redirectResponse: { status: 302 },
      request: { method: "GET", url: "https://example.test/final" },
    });
    setNow(5_015);
    fake.emit(source, "Network.responseReceived", {
      requestId: "redirected",
      response: { status: 200 },
    });
    setNow(5_025);
    fake.emit(source, "Network.loadingFinished", {
      requestId: "redirected",
      timestamp: 20.025,
    });

    const effects = runtime.effectsForWindow({
      tabId: 21,
      actionEpochMs,
      settledEpochMs: 5_050,
    });
    expect(effects.network).toHaveLength(2);
    expect(effects.network?.[0]).toMatchObject({
      url: "https://example.test/start",
      status: 302,
    });
    expect(effects.network?.[1]).toMatchObject({
      url: "https://example.test/final",
      status: 200,
    });
    runtime.dispose();
  });
});

describe("sanitizeRecordedUrl", () => {
  it("keeps URL shape but removes query values and fragments", () => {
    const url = sanitizeRecordedUrl("https://example.test/a?ticket=abc&n=1#section");
    expect(url).toContain("ticket=%3Credacted%3E");
    expect(url).toContain("n=%3Credacted%3E");
    expect(url).not.toContain("abc");
    expect(url).not.toContain("#section");
  });
});
