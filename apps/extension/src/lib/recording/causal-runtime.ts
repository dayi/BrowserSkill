import type { CdpDebuggee } from "@/browser-driver/chromium-cdp";
import type { CdpRunner } from "@/tools/shared";
import { RecordingEventJournal, type RecordingJournalEvent } from "./event-journal";
import type {
  ConsoleEffectV4,
  NavigationEffectV4,
  NetworkEffectV4,
  SecurityEffectV4,
  StackFrameEvidenceV4,
  StepEffectsV4,
} from "./trace-v4-types";

const CAUSAL_PRE_ROLL_MS = 30;
const MAX_STACK_FRAMES = 8;
const MAX_EFFECTS_PER_KIND = 20;
const MAX_TEXT_CHARS = 1000;
const RELEVANT_RESOURCE_TYPES = new Set(["Document", "XHR", "Fetch"]);

interface NetworkRequestState {
  key: string;
  tabId: number;
  cdpSessionId?: string;
  requestId: string;
  method: string;
  url: string;
  resourceType?: string;
  frameId?: string;
  startedEpochMs: number;
  startedProtocolTimestamp?: number;
  initiator: StackFrameEvidenceV4[];
  status?: number;
}

interface NetworkTerminalData {
  request: NetworkRequestState;
  status?: number;
  errorText?: string;
  blockedReason?: string;
  durationMs?: number;
}

export interface NetworkActivitySnapshot {
  pendingRelevantRequests: number;
  quietForMs: number;
  lastActivityEpochMs?: number;
}

export interface CausalWindow {
  tabId: number;
  actionEpochMs: number;
  settledEpochMs: number;
  fromSeq?: number;
  toSeq?: number;
}

function sourceKey(source: CdpDebuggee, requestId: string): string {
  return `${source.tabId ?? -1}:${source.sessionId ?? "root"}:${requestId}`;
}

function truncate(value: string | undefined, max = MAX_TEXT_CHARS): string | undefined {
  if (!value) return undefined;
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Preserve URL shape while redacting values that may contain user/business data. */
export function sanitizeRecordedUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "<redacted>");
    }
    url.hash = "";
    return truncate(url.toString(), 4096) ?? raw;
  } catch {
    return truncate(raw, 4096) ?? raw;
  }
}

function stackFrames(raw: unknown): StackFrameEvidenceV4[] {
  const result: StackFrameEvidenceV4[] = [];
  let stack = raw as { callFrames?: unknown[]; parent?: unknown } | undefined;
  let depth = 0;
  while (stack && depth < 4 && result.length < MAX_STACK_FRAMES) {
    for (const item of stack.callFrames ?? []) {
      if (!item || typeof item !== "object") continue;
      const frame = item as Record<string, unknown>;
      result.push({
        ...(typeof frame.functionName === "string" && frame.functionName
          ? { function_name: truncate(frame.functionName) }
          : {}),
        ...(typeof frame.url === "string" && frame.url
          ? { url: sanitizeRecordedUrl(frame.url) }
          : {}),
        ...(typeof frame.lineNumber === "number" ? { line: frame.lineNumber + 1 } : {}),
        ...(typeof frame.columnNumber === "number" ? { column: frame.columnNumber + 1 } : {}),
      });
      if (result.length >= MAX_STACK_FRAMES) break;
    }
    stack = stack.parent as typeof stack;
    depth += 1;
  }
  return result;
}

function initiatorFrames(raw: unknown): StackFrameEvidenceV4[] {
  const initiator = (raw ?? {}) as Record<string, unknown>;
  return stackFrames(initiator.stack);
}

function consoleArgText(arg: unknown): string {
  if (!arg || typeof arg !== "object") return String(arg ?? "");
  const obj = arg as Record<string, unknown>;
  if (typeof obj.value === "string") return obj.value;
  if (obj.value !== undefined) {
    try {
      return JSON.stringify(obj.value);
    } catch {
      return String(obj.value);
    }
  }
  if (typeof obj.description === "string") return obj.description;
  if (typeof obj.type === "string") return obj.type;
  return "";
}

function securityCodeFromFailure(input: {
  errorText?: string;
  blockedReason?: string;
  corsError?: unknown;
}): string | null {
  const blocked = input.blockedReason?.toLowerCase();
  const error = input.errorText?.toLowerCase() ?? "";
  if (input.corsError || blocked === "cors") return "cors_blocked";
  if (blocked?.includes("csp") || error.includes("content security policy")) return "csp_blocked";
  if (blocked === "mixed-content" || error.includes("mixed content")) return "mixed_content";
  if (blocked === "inspector" || error.includes("blocked_by_client")) return "blocked_by_client";
  if (error.includes("cert") || error.includes("ssl")) return "certificate_error";
  if (blocked) return `network_${blocked.replace(/[^a-z0-9]+/g, "_")}`;
  return null;
}

function auditSecurityCode(code: string): string {
  const value = code.toLowerCase();
  if (value.includes("cors")) return "cors_blocked";
  if (value.includes("contentsecurity") || value.includes("csp")) return "csp_blocked";
  if (value.includes("mixedcontent")) return "mixed_content";
  if (value.includes("cookie")) return "browser_policy";
  if (value.includes("permission")) return "permission_denied";
  return "browser_policy";
}

/**
 * Recording-wide causal collector. It subscribes before user actions arrive,
 * so synchronous page side effects are present in the journal even when the
 * RECORD_STEP message reaches the service worker later.
 */
export class RecordingCausalRuntime {
  readonly journal = new RecordingEventJournal();
  readonly #cdp: CdpRunner;
  readonly #requests = new Map<string, NetworkRequestState>();
  readonly #pendingRelevant = new Map<number, Set<string>>();
  readonly #lastNetworkActivity = new Map<number, number>();
  readonly #enabledTabs = new Set<number>();
  readonly #mainFrameIds = new Map<number, string>();
  readonly #mainFrameUrls = new Map<number, string>();
  readonly #subscription: { dispose(): void } | null;

  constructor(cdp: CdpRunner) {
    this.#cdp = cdp;
    this.#subscription =
      cdp.onEvent?.((source, method, params) => this.#onCdpEvent(source, method, params)) ?? null;
  }

  async ensureTab(tabId: number): Promise<void> {
    if (this.#enabledTabs.has(tabId)) return;
    this.#enabledTabs.add(tabId);
    // send() ensures attachment; ChromiumCdp attach already enables
    // Network/Runtime/Log. Audits is best effort because not all targets expose it.
    await this.#cdp.send(tabId, "Audits.enable", {}).catch(() => {});
    // Seed the main-frame URL before the next action. This lets the first
    // Page.frameNavigated event after a click carry an explicit from -> to edge.
    try {
      const tree = await this.#cdp.send<{
        frameTree?: { frame?: { id?: string; url?: string } };
      }>(tabId, "Page.getFrameTree", {});
      const frame = tree.frameTree?.frame;
      if (frame?.id) this.#mainFrameIds.set(tabId, frame.id);
      if (frame?.url) this.#mainFrameUrls.set(tabId, sanitizeRecordedUrl(frame.url));
    } catch {
      // Navigation events can establish the baseline later.
    }
  }

  latestSeq(tabId: number): number {
    return this.journal.latestSeq(tabId);
  }

  networkActivity(tabId: number, now = Date.now()): NetworkActivitySnapshot {
    const last = this.#lastNetworkActivity.get(tabId);
    return {
      pendingRelevantRequests: this.#pendingRelevant.get(tabId)?.size ?? 0,
      quietForMs: last === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - last),
      ...(last !== undefined ? { lastActivityEpochMs: last } : {}),
    };
  }

  effectsForWindow(window: CausalWindow): StepEffectsV4 {
    const events = this.journal.range({
      tabId: window.tabId,
      fromEpochMs: window.actionEpochMs - CAUSAL_PRE_ROLL_MS,
      toEpochMs: window.settledEpochMs,
      fromSeq: window.fromSeq,
      toSeq: window.toSeq,
    });

    const network: NetworkEffectV4[] = [];
    const consoleEffects: ConsoleEffectV4[] = [];
    const security: SecurityEffectV4[] = [];
    const navigation: NavigationEffectV4[] = [];

    for (const event of events) {
      if (
        (event.kind === "network_finished" || event.kind === "network_failure") &&
        network.length < MAX_EFFECTS_PER_KIND
      ) {
        const data = event.data as NetworkTerminalData;
        network.push({
          method: data.request.method,
          url: data.request.url,
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.errorText ? { error_text: truncate(data.errorText) } : {}),
          ...(data.blockedReason ? { blocked_reason: data.blockedReason } : {}),
          ...(data.request.resourceType ? { resource_type: data.request.resourceType } : {}),
          ...(data.durationMs !== undefined ? { duration_ms: Math.max(0, data.durationMs) } : {}),
          ...(data.request.initiator.length ? { initiator: data.request.initiator } : {}),
        });
      } else if (
        (event.kind === "console" || event.kind === "exception") &&
        consoleEffects.length < MAX_EFFECTS_PER_KIND
      ) {
        const data = event.data as ConsoleEffectV4;
        // Keep errors/warnings/exceptions in the compact trace; normal log chatter
        // remains only in the bounded journal and is discarded at trace export.
        if (
          event.kind === "exception" ||
          data.level === "error" ||
          data.level === "warning" ||
          data.level === "warn"
        ) {
          consoleEffects.push(data);
        }
      } else if (event.kind === "security" && security.length < MAX_EFFECTS_PER_KIND) {
        security.push(event.data as SecurityEffectV4);
      } else if (event.kind === "browser" && navigation.length < MAX_EFFECTS_PER_KIND) {
        const data = event.data as { type?: string; from?: string; to?: string };
        if (data.type === "navigation" && data.from && data.to) {
          navigation.push({ from: data.from, to: data.to });
        }
      }
    }

    return {
      ...(network.length ? { network } : {}),
      ...(consoleEffects.length ? { console: consoleEffects } : {}),
      ...(security.length ? { security } : {}),
      ...(navigation.length ? { navigation } : {}),
    };
  }

  dispose(): void {
    this.#subscription?.dispose();
    this.#requests.clear();
    this.#pendingRelevant.clear();
    this.#lastNetworkActivity.clear();
    this.#enabledTabs.clear();
    this.#mainFrameIds.clear();
    this.#mainFrameUrls.clear();
    this.journal.clear();
  }

  #append<T>(
    source: CdpDebuggee,
    kind: RecordingJournalEvent<T>["kind"],
    data: T,
    epochMs = Date.now(),
    frameId?: string,
  ): void {
    const tabId = source.tabId;
    if (typeof tabId !== "number") return;
    this.journal.append({
      tabId,
      ...(source.sessionId ? { cdpSessionId: source.sessionId } : {}),
      ...(frameId ? { frameId } : {}),
      epochMs,
      kind,
      data,
    });
  }

  #markNetworkActivity(tabId: number, key: string, relevant: boolean, active: boolean): void {
    const now = Date.now();
    this.#lastNetworkActivity.set(tabId, now);
    if (!relevant) return;
    const pending = this.#pendingRelevant.get(tabId) ?? new Set<string>();
    if (active) pending.add(key);
    else pending.delete(key);
    if (pending.size) this.#pendingRelevant.set(tabId, pending);
    else this.#pendingRelevant.delete(tabId);
  }

  #appendNavigation(source: CdpDebuggee, frameId: string | undefined, toRaw: string): void {
    const tabId = source.tabId;
    if (typeof tabId !== "number") return;
    const to = sanitizeRecordedUrl(toRaw);
    const from = this.#mainFrameUrls.get(tabId);
    if (frameId) this.#mainFrameIds.set(tabId, frameId);
    this.#mainFrameUrls.set(tabId, to);
    if (!from || from === to) return;
    this.#append(source, "browser", { type: "navigation", from, to }, Date.now(), frameId);
  }

  #finishRedirectLeg(
    source: CdpDebuggee,
    state: NetworkRequestState,
    redirectResponse: Record<string, unknown>,
    endProtocolTimestamp: number | undefined,
  ): void {
    const status = typeof redirectResponse.status === "number" ? redirectResponse.status : state.status;
    const durationMs =
      endProtocolTimestamp !== undefined && state.startedProtocolTimestamp !== undefined
        ? (endProtocolTimestamp - state.startedProtocolTimestamp) * 1000
        : Date.now() - state.startedEpochMs;
    this.#append(
      source,
      "network_finished",
      {
        request: state,
        ...(status !== undefined ? { status } : {}),
        durationMs,
      } satisfies NetworkTerminalData,
      Date.now(),
      state.frameId,
    );
  }

  #onCdpEvent(source: CdpDebuggee, method: string, params: unknown): void {
    const tabId = source.tabId;
    if (typeof tabId !== "number") return;
    const raw = (params ?? {}) as Record<string, unknown>;

    if (method === "Network.requestWillBeSent") {
      const requestId = typeof raw.requestId === "string" ? raw.requestId : undefined;
      const request = (raw.request ?? {}) as Record<string, unknown>;
      if (!requestId || typeof request.url !== "string") return;
      const resourceType = typeof raw.type === "string" ? raw.type : undefined;
      const key = sourceKey(source, requestId);
      const previous = this.#requests.get(key);
      const redirectResponse = raw.redirectResponse as Record<string, unknown> | undefined;
      if (previous && redirectResponse) {
        this.#finishRedirectLeg(
          source,
          previous,
          redirectResponse,
          typeof raw.timestamp === "number" ? raw.timestamp : undefined,
        );
      }
      const startedEpochMs = typeof raw.wallTime === "number" ? raw.wallTime * 1000 : Date.now();
      const state: NetworkRequestState = {
        key,
        tabId,
        ...(source.sessionId ? { cdpSessionId: source.sessionId } : {}),
        requestId,
        method: typeof request.method === "string" ? request.method : "GET",
        url: sanitizeRecordedUrl(request.url),
        ...(resourceType ? { resourceType } : {}),
        ...(typeof raw.frameId === "string" ? { frameId: raw.frameId } : {}),
        startedEpochMs,
        ...(typeof raw.timestamp === "number" ? { startedProtocolTimestamp: raw.timestamp } : {}),
        initiator: initiatorFrames(raw.initiator),
      };
      this.#requests.set(key, state);
      this.#markNetworkActivity(tabId, key, RELEVANT_RESOURCE_TYPES.has(resourceType ?? ""), true);
      this.#append(source, "network_request", state, startedEpochMs, state.frameId);
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = typeof raw.requestId === "string" ? raw.requestId : undefined;
      if (!requestId) return;
      const state = this.#requests.get(sourceKey(source, requestId));
      if (!state) return;
      const response = (raw.response ?? {}) as Record<string, unknown>;
      if (typeof response.status === "number") state.status = response.status;
      this.#lastNetworkActivity.set(tabId, Date.now());
      this.#append(
        source,
        "network_response",
        {
          request: state,
          ...(state.status !== undefined ? { status: state.status } : {}),
        },
        Date.now(),
        state.frameId,
      );
      return;
    }

    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const requestId = typeof raw.requestId === "string" ? raw.requestId : undefined;
      if (!requestId) return;
      const key = sourceKey(source, requestId);
      const state = this.#requests.get(key);
      if (!state) return;
      this.#requests.delete(key);
      const relevant = RELEVANT_RESOURCE_TYPES.has(state.resourceType ?? "");
      this.#markNetworkActivity(tabId, key, relevant, false);
      const endProtocol = typeof raw.timestamp === "number" ? raw.timestamp : undefined;
      const durationMs =
        endProtocol !== undefined && state.startedProtocolTimestamp !== undefined
          ? (endProtocol - state.startedProtocolTimestamp) * 1000
          : Date.now() - state.startedEpochMs;
      const data: NetworkTerminalData = {
        request: state,
        ...(state.status !== undefined ? { status: state.status } : {}),
        ...(typeof raw.errorText === "string" ? { errorText: raw.errorText } : {}),
        ...(typeof raw.blockedReason === "string" ? { blockedReason: raw.blockedReason } : {}),
        durationMs,
      };
      this.#append(
        source,
        method === "Network.loadingFinished" ? "network_finished" : "network_failure",
        data,
        Date.now(),
        state.frameId,
      );
      if (method === "Network.loadingFailed") {
        const code = securityCodeFromFailure({
          errorText: data.errorText,
          blockedReason: data.blockedReason,
          corsError: raw.corsErrorStatus,
        });
        if (code) {
          this.#append(
            source,
            "security",
            {
              code,
              ...(data.errorText ? { message: truncate(data.errorText) } : {}),
              source: "network",
              confidence: "explicit",
            } satisfies SecurityEffectV4,
          );
        }
      }
      return;
    }

    if (method === "Runtime.consoleAPICalled") {
      const level = typeof raw.type === "string" ? raw.type : "log";
      const args = Array.isArray(raw.args) ? raw.args : [];
      const text = truncate(args.map(consoleArgText).filter(Boolean).join(" ")) ?? "";
      const stack = stackFrames(raw.stackTrace);
      this.#append(
        source,
        "console",
        {
          level,
          text,
          ...(stack.length ? { stack_trace: stack } : {}),
        } satisfies ConsoleEffectV4,
      );
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      const details = (raw.exceptionDetails ?? {}) as Record<string, unknown>;
      const exception = (details.exception ?? {}) as Record<string, unknown>;
      const text =
        truncate(typeof exception.description === "string" ? exception.description : undefined) ??
        truncate(typeof details.text === "string" ? details.text : undefined) ??
        "Uncaught exception";
      const stack = stackFrames(details.stackTrace);
      this.#append(
        source,
        "exception",
        {
          level: "error",
          text,
          ...(stack.length ? { stack_trace: stack } : {}),
        } satisfies ConsoleEffectV4,
      );
      return;
    }

    if (method === "Log.entryAdded") {
      const entry = (raw.entry ?? {}) as Record<string, unknown>;
      const level = typeof entry.level === "string" ? entry.level : "log";
      const text = truncate(typeof entry.text === "string" ? entry.text : undefined) ?? "";
      const stack = stackFrames(entry.stackTrace);
      this.#append(
        source,
        "console",
        {
          level,
          text,
          ...(stack.length ? { stack_trace: stack } : {}),
        } satisfies ConsoleEffectV4,
      );
      return;
    }

    if (method === "Audits.issueAdded") {
      const issue = (raw.issue ?? {}) as Record<string, unknown>;
      const code = typeof issue.code === "string" ? issue.code : "UnknownIssue";
      this.#append(
        source,
        "security",
        {
          code: auditSecurityCode(code),
          message: truncate(code),
          source: "audits",
          confidence: "explicit",
        } satisfies SecurityEffectV4,
      );
      return;
    }

    if (method === "Page.frameNavigated") {
      const frame = (raw.frame ?? {}) as Record<string, unknown>;
      // Only main-frame navigation belongs to the tab-level business state.
      if (typeof frame.parentId === "string") return;
      const url = typeof frame.url === "string" ? frame.url : undefined;
      if (!url) return;
      const frameId = typeof frame.id === "string" ? frame.id : undefined;
      this.#appendNavigation(source, frameId, url);
      return;
    }

    if (method === "Page.navigatedWithinDocument") {
      const frameId = typeof raw.frameId === "string" ? raw.frameId : undefined;
      const mainFrameId = this.#mainFrameIds.get(tabId);
      if (mainFrameId && frameId && mainFrameId !== frameId) return;
      const url = typeof raw.url === "string" ? raw.url : undefined;
      if (url) this.#appendNavigation(source, frameId, url);
    }
  }
}
