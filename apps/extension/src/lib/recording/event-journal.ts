export type RecordingJournalEventKind =
  | "network_request"
  | "network_response"
  | "network_finished"
  | "network_failure"
  | "console"
  | "exception"
  | "security"
  | "dialog"
  | "browser";

export interface RecordingJournalEvent<T = unknown> {
  seq: number;
  tabId: number;
  frameId?: string;
  cdpSessionId?: string;
  /** Epoch milliseconds in the recorder process. */
  epochMs: number;
  kind: RecordingJournalEventKind;
  data: T;
}

const DEFAULT_MAX_EVENTS_PER_TAB = 4096;
const DEFAULT_MAX_EVENT_AGE_MS = 30_000;

/**
 * Bounded rolling event history used to correlate CDP events with an action
 * after the action message reaches the MV3 service worker. Events are kept
 * before RECORD_STEP arrives, which closes the synchronous-side-effect gap.
 */
export class RecordingEventJournal {
  readonly #maxEventsPerTab: number;
  readonly #maxEventAgeMs: number;
  readonly #eventsByTab = new Map<number, RecordingJournalEvent[]>();
  #nextSeq = 1;

  constructor(options: { maxEventsPerTab?: number; maxEventAgeMs?: number } = {}) {
    this.#maxEventsPerTab = options.maxEventsPerTab ?? DEFAULT_MAX_EVENTS_PER_TAB;
    this.#maxEventAgeMs = options.maxEventAgeMs ?? DEFAULT_MAX_EVENT_AGE_MS;
  }

  append<T>(event: Omit<RecordingJournalEvent<T>, "seq">): RecordingJournalEvent<T> {
    const stored: RecordingJournalEvent<T> = { ...event, seq: this.#nextSeq++ };
    const bucket = this.#eventsByTab.get(event.tabId) ?? [];
    bucket.push(stored as RecordingJournalEvent);
    this.#eventsByTab.set(event.tabId, bucket);
    this.#pruneTab(event.tabId, event.epochMs);
    return stored;
  }

  latestSeq(tabId: number): number {
    const bucket = this.#eventsByTab.get(tabId);
    return bucket?.[bucket.length - 1]?.seq ?? 0;
  }

  range(input: {
    tabId: number;
    fromEpochMs: number;
    toEpochMs: number;
    fromSeq?: number;
    toSeq?: number;
  }): RecordingJournalEvent[] {
    const bucket = this.#eventsByTab.get(input.tabId) ?? [];
    return bucket.filter(
      (event) =>
        event.epochMs >= input.fromEpochMs &&
        event.epochMs <= input.toEpochMs &&
        (input.fromSeq === undefined || event.seq >= input.fromSeq) &&
        (input.toSeq === undefined || event.seq <= input.toSeq),
    );
  }

  prune(now = Date.now()): void {
    for (const tabId of this.#eventsByTab.keys()) this.#pruneTab(tabId, now);
  }

  clear(tabId?: number): void {
    if (tabId === undefined) this.#eventsByTab.clear();
    else this.#eventsByTab.delete(tabId);
  }

  #pruneTab(tabId: number, now: number): void {
    const bucket = this.#eventsByTab.get(tabId);
    if (!bucket) return;
    const oldestAllowed = now - this.#maxEventAgeMs;
    let first = 0;
    while (first < bucket.length && bucket[first]!.epochMs < oldestAllowed) first += 1;
    if (first > 0) bucket.splice(0, first);
    if (bucket.length > this.#maxEventsPerTab) {
      bucket.splice(0, bucket.length - this.#maxEventsPerTab);
    }
    if (bucket.length === 0) this.#eventsByTab.delete(tabId);
  }
}
