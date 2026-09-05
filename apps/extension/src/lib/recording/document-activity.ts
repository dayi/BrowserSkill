import type { CdpRunner } from "@/tools/shared";
import { sendToCdpTarget } from "@/tools/shared";
import type { DocumentSettleScope } from "./document-settle";

const ACTIVITY_WORLD_NAME = "__bsk_record_activity__";

const ACTIVITY_PROBE = `(() => {
  const scope = globalThis;
  let probe = scope.__bskRecordActivity;
  if (!probe) {
    const now = Date.now();
    probe = {
      generation: 0,
      mutationCount: 0,
      childListCount: 0,
      attributeCount: 0,
      characterDataCount: 0,
      installedAt: now,
      firstMutationAt: null,
      lastMutationAt: now,
    };
    const observer = new MutationObserver((records) => {
      const changedAt = Date.now();
      probe.generation += 1;
      probe.mutationCount += records.length;
      if (probe.firstMutationAt === null) probe.firstMutationAt = changedAt;
      probe.lastMutationAt = changedAt;
      for (const record of records) {
        if (record.type === "childList") probe.childListCount += 1;
        else if (record.type === "attributes") probe.attributeCount += 1;
        else if (record.type === "characterData") probe.characterDataCount += 1;
      }
    });
    const root = document.documentElement;
    if (root) {
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
    probe.observer = observer;
    scope.__bskRecordActivity = probe;
  }
  return {
    generation: probe.generation,
    mutationCount: probe.mutationCount,
    childListCount: probe.childListCount,
    attributeCount: probe.attributeCount,
    characterDataCount: probe.characterDataCount,
    installedAt: probe.installedAt,
    firstMutationAt: probe.firstMutationAt,
    lastMutationAt: probe.lastMutationAt,
  };
})()`;

export interface DocumentActivitySnapshot {
  generation: number;
  mutationCount: number;
  childListCount: number;
  attributeCount: number;
  characterDataCount: number;
  installedAt: number;
  firstMutationAt?: number;
  lastMutationAt: number;
}

export interface DocumentActivityDelta {
  generationDelta: number;
  mutationCount: number;
  childListCount: number;
  attributeCount: number;
  characterDataCount: number;
  firstActivityEpochMs?: number;
  lastActivityEpochMs?: number;
  activityDurationMs?: number;
}

interface ActivityContext {
  executionContextId?: number;
}

export class DocumentActivityManager {
  readonly #cdp: CdpRunner;
  readonly #contexts = new Map<string, ActivityContext>();

  constructor(cdp: CdpRunner) {
    this.#cdp = cdp;
  }

  async ensure(scope: DocumentSettleScope): Promise<DocumentActivitySnapshot | null> {
    return this.read(scope);
  }

  async read(scope: DocumentSettleScope): Promise<DocumentActivitySnapshot | null> {
    const key = this.#scopeKey(scope);
    const context = this.#contexts.get(key) ?? {};
    this.#contexts.set(key, context);
    try {
      if (scope.frameId && context.executionContextId === undefined) {
        const result = await sendToCdpTarget<{ executionContextId?: number }>(
          this.#cdp,
          scope.target,
          "Page.createIsolatedWorld",
          {
            frameId: scope.frameId,
            worldName: ACTIVITY_WORLD_NAME,
            grantUniveralAccess: false,
          },
        );
        context.executionContextId = result.executionContextId;
        if (context.executionContextId === undefined) return null;
      }
      const reply = await sendToCdpTarget<{ result?: { value?: unknown } }>(
        this.#cdp,
        scope.target,
        "Runtime.evaluate",
        {
          expression: ACTIVITY_PROBE,
          returnByValue: true,
          ...(context.executionContextId !== undefined
            ? { contextId: context.executionContextId }
            : {}),
        },
      );
      return parseSnapshot(reply.result?.value);
    } catch {
      // Navigation invalidates execution contexts; retry with a fresh world on
      // the next read instead of surfacing a recording failure.
      this.#contexts.delete(key);
      return null;
    }
  }

  clear(): void {
    this.#contexts.clear();
  }

  #scopeKey(scope: DocumentSettleScope): string {
    return `${scope.target.tabId}:${scope.target.sessionId ?? "root"}:${scope.frameId ?? "root"}`;
  }
}

export function activityDelta(
  before: DocumentActivitySnapshot | null | undefined,
  after: DocumentActivitySnapshot | null | undefined,
): DocumentActivityDelta | undefined {
  if (!before || !after) return undefined;
  // A lower counter means navigation/document replacement. Do not pretend the
  // new document's counters are a delta of the old one.
  if (after.generation < before.generation || after.mutationCount < before.mutationCount) {
    return undefined;
  }
  const mutationCount = after.mutationCount - before.mutationCount;
  const first = mutationCount > 0 ? Math.max(before.lastMutationAt, after.firstMutationAt ?? 0) : undefined;
  const last = mutationCount > 0 ? after.lastMutationAt : undefined;
  return {
    generationDelta: after.generation - before.generation,
    mutationCount,
    childListCount: Math.max(0, after.childListCount - before.childListCount),
    attributeCount: Math.max(0, after.attributeCount - before.attributeCount),
    characterDataCount: Math.max(0, after.characterDataCount - before.characterDataCount),
    ...(first ? { firstActivityEpochMs: first } : {}),
    ...(last ? { lastActivityEpochMs: last } : {}),
    ...(first && last ? { activityDurationMs: Math.max(0, last - first) } : {}),
  };
}

function parseSnapshot(value: unknown): DocumentActivitySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.generation !== "number" ||
    typeof raw.mutationCount !== "number" ||
    typeof raw.childListCount !== "number" ||
    typeof raw.attributeCount !== "number" ||
    typeof raw.characterDataCount !== "number" ||
    typeof raw.installedAt !== "number" ||
    typeof raw.lastMutationAt !== "number"
  ) {
    return null;
  }
  return {
    generation: raw.generation,
    mutationCount: raw.mutationCount,
    childListCount: raw.childListCount,
    attributeCount: raw.attributeCount,
    characterDataCount: raw.characterDataCount,
    installedAt: raw.installedAt,
    ...(typeof raw.firstMutationAt === "number" ? { firstMutationAt: raw.firstMutationAt } : {}),
    lastMutationAt: raw.lastMutationAt,
  };
}
