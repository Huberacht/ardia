import { act } from "react-test-renderer";
import { settledWithoutWaiting } from "../state/app/boot";
import * as browserDatabase from "../state/store/browserDatabase";
import { tabDatabase } from "../state/store/database";
import { currentTabs, flushTabWrites, selectTabById, tabWritesPending, updateTabById } from "../state/tabs/store";
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
  const real = jest.requireActual<typeof browserDatabase>("../state/store/browserDatabase").writeTabs;
  let refusals = 2;
  jest.spyOn(browserDatabase, "writeTabs").mockImplementation((db, put, remove) => {
    if (refusals > 0) {
      refusals -= 1;
      throw new Error("SQLITE_BUSY");
    }
    real(db, put, remove);
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
