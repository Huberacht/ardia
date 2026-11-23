import { act } from "react-test-renderer";
import * as omnibox from "../state/search/omnibox";
import { dismissSearch, presentSearch, setSearchClearsPagePrefill, useSearch } from "../state/search/store";
import { useTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
});

afterEach(() => {
  act(() => dismissSearch());
  setSearchClearsPagePrefill(false);
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("where the panel opens on an empty field, a page's search starts empty instead of suggesting for its address and clearing it a moment later", () => {
  setSearchClearsPagePrefill(true);
  act(() => presentSearch("page", "https://example.com/a", null, { currentUrl: "https://example.com/a", currentTabId: "t0" }));
  expect(useSearch.getState()).toMatchObject({ open: true, text: "", initialText: "https://example.com/a", editsPage: true });
});

test("elsewhere a page's search still opens with its address in the field", () => {
  act(() => presentSearch("page", "https://example.com/a", null, { currentUrl: "https://example.com/a", currentTabId: "t0" }));
  expect(useSearch.getState()).toMatchObject({ text: "https://example.com/a", initialText: "https://example.com/a" });
});

test("changed suggestion sources are rebuilt the frame after search opens, not before it moves", () => {
  act(() => presentSearch("home"));
  act(() => dismissSearch());
  const rebuilt = jest.spyOn(omnibox, "setSources");
  act(() => useTabs.setState((state) => ({ listing: state.listing + 1 })));
  act(() => presentSearch("home"));
  expect(useSearch.getState().open).toBe(true);
  expect(rebuilt).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(32));
  expect(rebuilt).toHaveBeenCalledTimes(1);
});
