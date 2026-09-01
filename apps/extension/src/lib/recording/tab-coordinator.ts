import type { RecordingNavigationCursor } from "./step-buffer";

export interface TabActivation {
  tabId: number;
  revision: number;
}

export class RecordingTabCoordinator {
  readonly #navigationByTab = new Map<number, RecordingNavigationCursor>();
  readonly #trackedTabs = new Set<number>();
  #activeTabId: number;
  #currentTabId: number;
  #activationRevision = 0;

  constructor(initialTabId: number, initialUrl?: string) {
    this.#activeTabId = initialTabId;
    this.#currentTabId = initialTabId;
    this.#trackedTabs.add(initialTabId);
    this.#navigationByTab.set(initialTabId, {
      currentUrl: initialUrl,
      pendingNavigation: false,
    });
  }

  get activeTabId(): number {
    return this.#activeTabId;
  }

  get currentTabId(): number {
    return this.#currentTabId;
  }

  get tabIds(): readonly number[] {
    return [...this.#trackedTabs];
  }

  hasTab(tabId: number): boolean {
    return this.#trackedTabs.has(tabId);
  }

  trackTab(tabId: number, initialUrl?: string): void {
    this.#trackedTabs.add(tabId);
    this.navigation(tabId, initialUrl);
  }

  forgetTab(tabId: number): void {
    this.#trackedTabs.delete(tabId);
    this.#navigationByTab.delete(tabId);
  }

  noteActivation(tabId: number): TabActivation {
    this.#activeTabId = tabId;
    this.#activationRevision += 1;
    return { tabId, revision: this.#activationRevision };
  }

  isLatest(activation: TabActivation): boolean {
    return (
      activation.tabId === this.#activeTabId && activation.revision === this.#activationRevision
    );
  }

  commit(tabId: number, currentUrl?: string): void {
    this.trackTab(tabId, currentUrl);
    if (currentUrl !== undefined) this.navigation(tabId).currentUrl = currentUrl;
    this.#currentTabId = tabId;
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
}
