import type { RecordingNavigationCursor } from "./step-buffer";

export interface TabActivation {
  tabId: number;
  revision: number;
}

export class RecordingTabCoordinator {
  readonly #navigationByTab = new Map<number, RecordingNavigationCursor>();
  readonly #trackedTabs = new Set<number>();
  readonly #removedTabs = new Set<number>();
  readonly #openerByTab = new Map<number, number>();
  readonly #lastActivationByTab = new Map<number, number>();
  #activeTabId: number | null;
  #currentTabId: number | null;
  #activationRevision = 0;

  constructor(initialTabId: number, initialUrl?: string) {
    this.#activeTabId = initialTabId;
    this.#currentTabId = initialTabId;
    this.#trackedTabs.add(initialTabId);
    this.#lastActivationByTab.set(initialTabId, this.#activationRevision);
    this.#navigationByTab.set(initialTabId, {
      currentUrl: initialUrl,
      pendingNavigation: false,
    });
  }

  get activeTabId(): number | null {
    return this.#activeTabId;
  }

  get currentTabId(): number | null {
    return this.#currentTabId;
  }

  get tabIds(): readonly number[] {
    return [...this.#trackedTabs];
  }

  hasTab(tabId: number): boolean {
    return this.#trackedTabs.has(tabId);
  }

  wasRemoved(tabId: number): boolean {
    return this.#removedTabs.has(tabId);
  }

  trackTab(tabId: number, initialUrl?: string, openerTabId?: number): boolean {
    // Once removal is observed for this recording, an already-queued
    // RECORD_STEP must never resurrect that tab.
    if (this.#removedTabs.has(tabId)) return false;
    this.#trackedTabs.add(tabId);
    if (openerTabId !== undefined && openerTabId !== tabId) {
      this.#openerByTab.set(tabId, openerTabId);
    }
    this.navigation(tabId, initialUrl);
    return true;
  }

  forgetTab(tabId: number, preferredFallbackTabId?: number): void {
    if (!this.#trackedTabs.delete(tabId)) return;
    this.#removedTabs.add(tabId);
    // Keep the navigation cursor until the recording is released. A step that
    // was accepted immediately before tabs.onRemoved may still be in the
    // action queue and needs the closed tab's URL, but must not re-track it.
    const fallbackTabId = this.#fallbackTab(tabId, preferredFallbackTabId);
    if (this.#currentTabId === tabId) this.#currentTabId = fallbackTabId;
    if (this.#activeTabId === tabId) {
      this.#activeTabId = fallbackTabId;
      this.#activationRevision += 1;
    }
  }

  noteActivation(tabId: number): TabActivation | null {
    if (!this.#trackedTabs.has(tabId)) return null;
    this.#activeTabId = tabId;
    this.#activationRevision += 1;
    this.#lastActivationByTab.set(tabId, this.#activationRevision);
    return { tabId, revision: this.#activationRevision };
  }

  isLatest(activation: TabActivation): boolean {
    return (
      activation.tabId === this.#activeTabId && activation.revision === this.#activationRevision
    );
  }

  commit(tabId: number, currentUrl?: string): boolean {
    if (!this.trackTab(tabId, currentUrl)) return false;
    if (currentUrl !== undefined) this.navigation(tabId).currentUrl = currentUrl;
    this.#currentTabId = tabId;
    return true;
  }

  navigation(tabId: number, fallbackUrl?: string): RecordingNavigationCursor {
    const existing = this.#navigationByTab.get(tabId);
    if (existing) {
      if (!existing.currentUrl && fallbackUrl) existing.currentUrl = fallbackUrl;
      return existing;
    }
    const created: RecordingNavigationCursor = {
      currentUrl: fallbackUrl,
      pendingNavigation: false,
    };
    this.#navigationByTab.set(tabId, created);
    return created;
  }

  #fallbackTab(removedTabId: number, preferredFallbackTabId?: number): number | null {
    if (preferredFallbackTabId !== undefined && this.#trackedTabs.has(preferredFallbackTabId)) {
      return preferredFallbackTabId;
    }

    const openerTabId = this.#openerByTab.get(removedTabId);
    if (openerTabId !== undefined && this.#trackedTabs.has(openerTabId)) return openerTabId;

    let fallbackTabId: number | null = null;
    let latestRevision = -1;
    for (const candidate of this.#trackedTabs) {
      const revision = this.#lastActivationByTab.get(candidate) ?? -1;
      if (revision > latestRevision) {
        fallbackTabId = candidate;
        latestRevision = revision;
      }
    }
    return fallbackTabId ?? this.#trackedTabs.values().next().value ?? null;
  }
}
