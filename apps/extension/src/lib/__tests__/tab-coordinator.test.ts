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
    const second = tabs.noteActivation(5);
    const third = tabs.noteActivation(6);

    expect(tabs.isLatest(second)).toBe(false);
    expect(tabs.isLatest(third)).toBe(true);
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

    tabs.forgetTab(9);

    expect(tabs.hasTab(9)).toBe(false);
    expect(tabs.tabIds).toEqual([4]);
  });
});
