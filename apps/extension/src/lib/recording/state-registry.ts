export interface RecordedStateEntry {
  id: string;
  url: string;
  title?: string;
  /** Rendered VOM text; capture indexes and source DOM/AX data never enter the registry. */
  vomText: string;
  truncated: boolean;
  /** First time this semantic state identity was captured in this recording. */
  capturedAtMs: number;
  stepsHere: number[];
}

function stateIdentity(url: string, body: string): string {
  return `${url}\0${body}`;
}

export class RecordingStateRegistry {
  readonly #entriesById = new Map<string, RecordedStateEntry>();
  readonly #idByIdentity = new Map<string, string>();
  #nextId = 1;

  register(input: {
    url: string;
    title?: string;
    vomText: string;
    truncated?: boolean;
    capturedAtMs?: number;
  }): RecordedStateEntry {
    const identity = stateIdentity(input.url, input.vomText);
    const existingId = this.#idByIdentity.get(identity);
    if (existingId) {
      const existing = this.#entriesById.get(existingId)!;
      if (!existing.title && input.title) existing.title = input.title;
      if (input.truncated) existing.truncated = true;
      return existing;
    }

    const entry: RecordedStateEntry = {
      id: `s${this.#nextId}`,
      url: input.url,
      ...(input.title ? { title: input.title } : {}),
      vomText: input.vomText,
      truncated: input.truncated ?? false,
      capturedAtMs: input.capturedAtMs ?? Date.now(),
      stepsHere: [],
    };
    this.#nextId += 1;
    this.#entriesById.set(entry.id, entry);
    this.#idByIdentity.set(identity, entry.id);
    return entry;
  }

  values(): RecordedStateEntry[] {
    return [...this.#entriesById.values()];
  }

  get(stateId: string): RecordedStateEntry | undefined {
    return this.#entriesById.get(stateId);
  }

  markStep(stateId: string, draftId: number): void {
    const entry = this.#entriesById.get(stateId);
    if (entry && !entry.stepsHere.includes(draftId)) entry.stepsHere.push(draftId);
  }
}
