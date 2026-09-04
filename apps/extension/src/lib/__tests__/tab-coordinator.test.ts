import { describe, expect, it } from "vitest";
import { RecordingTabCoordinator } from "../recording/tab-coordinator";

describe("RecordingTabCoordinator", () => {
  it("keeps navigation state isolated per tab", () => {
    const tabs = new RecordingTabCoordinator(4, "https://example.com/first");
    const first = tabs.navigation(4);
    first.pendingNavigation = true;
    const second = tabs.navigation(5, "https://example.com/second");

    expect(second).toEqual({
      currentUrl: "https://example.com/second",
      pendingNavigation: false,
    });
    expect(tabs.navigation(4)).toBe(first);
    expect(tabs.navigation(4).pendingNavigation).toBe(true);
  });

  it("invalidates an earlier activation when a newer tab becomes active", () => {
    const tabs = new RecordingTabCoordinator(4);
    tabs.trackTab(5);
    tabs.trackTab(6);
    const second = tabs.noteActivation(5);
    const third = tabs.noteActivation(6);

    expect(tabs.isLatest(second!)).toBe(false);
    expect(tabs.isLatest(third!)).toBe(true);
    tabs.commit(6);
    expect(tabs.currentTabId).toBe(6);
  });

  it("commits the freshly observed URL when returning to an existing tab", () => {
    const tabs = new RecordingTabCoordinator(4);
    tabs.navigation(5, "https://example.com/old");

    tabs.commit(5, "https://example.com/new");

    expect(tabs.currentTabId).toBe(5);
    expect(tabs.navigation(5).currentUrl).toBe("https://example.com/new");
  });

  it("tracks popup tabs independently of their browser window", () => {
    const tabs = new RecordingTabCoordinator(4);

    tabs.trackTab(9, "https://example.com/popup");

    expect(tabs.hasTab(4)).toBe(true);
    expect(tabs.hasTab(9)).toBe(true);
    expect(tabs.tabIds).toEqual([4, 9]);
    expect(tabs.navigation(9).currentUrl).toBe("https://example.com/popup");

    tabs.noteActivation(9);
    tabs.commit(9);

    tabs.forgetTab(9);

    expect(tabs.hasTab(9)).toBe(false);
    expect(tabs.tabIds).toEqual([4]);
    expect(tabs.activeTabId).toBe(4);
    expect(tabs.currentTabId).toBe(4);
  });

  it("does not resurrect a tab after its removal was observed", () => {
    const tabs = new RecordingTabCoordinator(4);
    tabs.trackTab(9, "https://example.com/popup", 4);
    tabs.noteActivation(9);
    tabs.commit(9);

    tabs.forgetTab(9);

    expect(tabs.wasRemoved(9)).toBe(true);
    expect(tabs.trackTab(9)).toBe(false);
    expect(tabs.commit(9)).toBe(false);
    expect(tabs.noteActivation(9)).toBeNull();
    expect(tabs.tabIds).toEqual([4]);
    expect(tabs.currentTabId).toBe(4);
  });

  it("clears active and current state when the final tab closes", () => {
    const tabs = new RecordingTabCoordinator(4);

    tabs.forgetTab(4);

    expect(tabs.tabIds).toEqual([]);
    expect(tabs.activeTabId).toBeNull();
    expect(tabs.currentTabId).toBeNull();
  });

  it("falls back through nested popup openers instead of insertion order", () => {
    const tabs = new RecordingTabCoordinator(4);
    tabs.trackTab(5, "https://example.com/background");
    tabs.trackTab(6, "https://example.com/popup", 4);
    tabs.trackTab(7, "https://example.com/nested", 6);
    tabs.noteActivation(6);
    tabs.commit(6);
    tabs.noteActivation(7);
    tabs.commit(7);

    tabs.forgetTab(7);
    expect(tabs.activeTabId).toBe(6);
    expect(tabs.currentTabId).toBe(6);

    tabs.forgetTab(6);
    expect(tabs.activeTabId).toBe(4);
    expect(tabs.currentTabId).toBe(4);
  });

  it("prefers the focused live tab supplied at removal", () => {
    const tabs = new RecordingTabCoordinator(4);
    tabs.trackTab(5);
    tabs.trackTab(6, undefined, 4);
    tabs.noteActivation(6);
    tabs.commit(6);

    tabs.forgetTab(6, 5);

    expect(tabs.activeTabId).toBe(5);
    expect(tabs.currentTabId).toBe(5);
  });
});
