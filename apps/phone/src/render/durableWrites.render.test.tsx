import { act } from "react-test-renderer";
import { settledWithoutWaiting } from "../state/app/boot";
import * as browserDatabase from "../state/store/browserDatabase";
import { tabDatabase } from "../state/store/database";
import { pages } from "../platform/pages";
import * as pageStore from "../state/pages/store";
import { archiveTabById, clearArchivedTabs, currentTabs, flushTabWrites, selectTabById, tabWritesPending, tabWritesStalled, updateTabById } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  browserDatabase.writeTabs(tabDatabase(), currentTabs().open, []);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const stored = (id: string) => browserDatabase.readOpenTabs(tabDatabase()).find((tab) => tab.id === id)!;

test("a busy database keeps the batch and retries it until the commit lands, so the screen and the store never disagree for long", () => {
  const next = currentTabs().open.find((tab) => tab.id !== currentTabs().selectedId)!;
  const real = jest.requireActual<typeof browserDatabase>("../state/store/browserDatabase").commitTabChanges;
  let refusals = 2;
  jest.spyOn(browserDatabase, "commitTabChanges").mockImplementation((db, commit) => {
    if (refusals > 0) {
      refusals -= 1;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return real(db, commit);
  });
  act(() => selectTabById(next.id));
  act(() => jest.advanceTimersByTime(20));
  expect(tabWritesPending()).toBe(true);
  act(() => jest.advanceTimersByTime(500));
  expect(tabWritesPending()).toBe(false);
  expect(stored(next.id).lastActive).toBe(currentTabs().open.find((tab) => tab.id === next.id)!.lastActive);
});

test("a new address is written at once, while a new title waits for the frame after the change", () => {
  const id = currentTabs().open[0]!.id;
  act(() => updateTabById(id, { url: "https://moved.example/" }));
  expect(stored(id).url).toBe("https://moved.example/");
  act(() => updateTabById(id, { title: "Later" }));
  expect(stored(id).title).not.toBe("Later");
  expect(flushTabWrites()).toBe(true);
  expect(stored(id).title).toBe("Later");
});

test("the import is skipped without waiting only when the native side says it is settled, and a cached none never skips it", () => {
  expect(settledWithoutWaiting("none", null)).toBe("none");
  expect(settledWithoutWaiting("imported", null)).toBe("imported");
  expect(settledWithoutWaiting("startedFresh", "startedFresh")).toBe("startedFresh");
  expect(settledWithoutWaiting("startedFresh", null)).toBeNull();
  expect(settledWithoutWaiting("pending", "imported")).toBeNull();
  expect(settledWithoutWaiting("unknown", "imported")).toBe("imported");
  expect(settledWithoutWaiting("unknown", null)).toBeNull();
});

const refuse = (times: number, message: string) => {
  const real = jest.requireActual<typeof browserDatabase>("../state/store/browserDatabase").commitTabChanges;
  let left = times;
  return jest.spyOn(browserDatabase, "commitTabChanges").mockImplementation((db, commit) => {
    if (left > 0) {
      left -= 1;
      throw new Error(message);
    }
    return real(db, commit);
  });
};

test("Clear Archive covers an archive still waiting on a busy database: once the retry lands the archive stays empty, and the picture files go only after the commit", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  const removed = jest.spyOn(pageStore, "deletePageSnapshots");
  const id = currentTabs().open[0]!.id;
  refuse(2, "SQLITE_BUSY: database is locked");
  act(() => archiveTabById(id));
  expect(tabWritesPending()).toBe(true);
  act(() => clearArchivedTabs());
  expect(currentTabs().archivedCount).toBe(0);
  expect(removed.mock.calls.flatMap(([ids]) => ids)).not.toContain(id);
  act(() => jest.advanceTimersByTime(1_000));
  expect(tabWritesPending()).toBe(false);
  expect(browserDatabase.readArchivedTabs(tabDatabase(), 10)).toEqual([]);
  expect(browserDatabase.readOpenTabs(tabDatabase()).map((tab) => tab.id)).not.toContain(id);
  expect(removed.mock.calls.flatMap(([ids]) => ids)).toContain(id);
});

test("an archive after Clear Archive in the same waiting batch survives it", () => {
  jest.spyOn(pageStore, "endPages").mockImplementation(() => undefined);
  const [first, second] = currentTabs().open;
  refuse(1, "SQLITE_BUSY");
  act(() => archiveTabById(first!.id));
  act(() => clearArchivedTabs());
  act(() => archiveTabById(second!.id));
  act(() => jest.advanceTimersByTime(1_000));
  expect(browserDatabase.readArchivedTabs(tabDatabase(), 10).map((tab) => tab.id)).toEqual([second!.id]);
});

test("a write that fails for good stops retrying on a timer and waits for the next change", () => {
  const commits = refuse(100, "SQLITE_FULL: database or disk is full");
  const id = currentTabs().open[0]!.id;
  act(() => updateTabById(id, { url: "https://stuck.example/" }));
  const tries = commits.mock.calls.length;
  act(() => jest.advanceTimersByTime(30_000));
  expect(commits.mock.calls.length).toBe(tries);
  expect(tabWritesStalled()).toBe(true);
  commits.mockRestore();
  act(() => updateTabById(id, { title: "Unstuck" }));
  expect(flushTabWrites()).toBe(true);
  expect(stored(id).url).toBe("https://stuck.example/");
});

test("the picture a committed row points at is handed to the native side only after SQLite commits it", () => {
  const acknowledged = jest.spyOn(pages, "snapshotsCommitted").mockImplementation(() => undefined);
  const id = currentTabs().open[0]!.id;
  refuse(1, "SQLITE_BUSY");
  act(() => updateTabById(id, { snapshotFileName: "file:///snapshots/b.jpg" }));
  act(() => updateTabById(id, { snapshotFileName: "file:///snapshots/c.jpg" }));
  act(() => jest.advanceTimersByTime(20));
  expect(acknowledged).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(500));
  expect(acknowledged).toHaveBeenCalledWith({ [id]: "file:///snapshots/c.jpg" });
});
