import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import "../platform/copy";
import { blocking } from "../platform/blocking";
import { pages } from "../platform/pages";
import { SystemPageMenuHost } from "../components/browsing/SystemPageMenu";
import { ExpoLibrarySheet } from "../components/library/ExpoLibrary";
import { DesignProvider } from "../components/ui";
import { openPageMenu, showFind } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { useBrowse } from "../state/browse/store";
import * as library from "../state/library/store";
import { useLibrary } from "../state/library/store";
import { pressButton, renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const page = (url: string, isLoading: boolean) =>
  act(() => usePages.setState((state) => ({ ...state, navigation: { t0: { url, title: "Site 0", canGoBack: false, canGoForward: false, isLoading, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 } as never } })));

const flush = () => act(async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
});

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  act(() => usePageUi.setState({ menuOpen: false, menuPage: "main", menuSite: null, findOpen: false, readerTabId: null, press: null }));
  act(() => useBrowse.setState({ surface: "browsing", sheet: null }));
  act(() => useLibrary.setState({ open: false, section: "history", path: [], history: [], historyLoaded: false, files: [], filesLoaded: false }));
  jest.spyOn(library, "loadHistory").mockImplementation(() => undefined);
  jest.spyOn(pages, "nightShade").mockResolvedValue({ mode: "always" } as never);
  jest.spyOn(blocking, "isEnabledForSite").mockResolvedValue(false);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const hosts = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const sheetIn = (root: Root, testID: string) => {
  const anchor = hosts(root.root, (props) => props.testID === testID)[0];
  return anchor ? hosts(anchor, (props) => typeof props.isPresented === "boolean")[0]! : null;
};
const menuSheet = (root: Root) => sheetIn(root, "systemPageMenuSheet");
const titled = (node: ReactTestInstance, title: string) => hosts(node, (props) => Array.isArray(props.modifiers) && (props.modifiers as { $type: string; title?: string }[]).some((modifier) => modifier.$type === "navigationTitle" && modifier.title === title));

function menu() {
  return renderSurface(
    <DesignProvider design="redesigned">
      <SystemPageMenuHost tabId="t0" />
      <ExpoLibrarySheet />
    </DesignProvider>,
  );
}

onIos("the iPhone page menu's sheet mounts once the page is quiet and stays mounted after it closes, so opening it only presents", async () => {
  page("https://site0.example/", true);
  const root = menu();
  expect(menuSheet(root)).toBeNull();
  page("https://site0.example/", false);
  expect(menuSheet(root)!.props.isPresented).toBe(false);
  await act(async () => void openPageMenu());
  expect(menuSheet(root)!.props.isPresented).toBe(true);
  act(() => menuSheet(root)!.props.onIsPresentedChange({ nativeEvent: { isPresented: false } }));
  expect(usePageUi.getState().menuOpen).toBe(false);
  act(() => menuSheet(root)!.props.onDismiss({ nativeEvent: {} }));
  expect(menuSheet(root)!.props.isPresented).toBe(false);
  unmount(root);
});

onIos("a settled page's Night Shade and blocker state is read ahead, so the menu opens with its real switches instead of flipping them as it rises", async () => {
  page("https://site0.example/", false);
  await flush();
  act(() => void openPageMenu());
  expect(usePageUi.getState().menuSite).toEqual({ host: "site0.example", nightShade: "always", blockersEnabled: false });
  await flush();
});

onIos("Find on Page waits for the menu's real dismissal, not a timer", async () => {
  page("https://site0.example/", false);
  jest.spyOn(pages, "hasSystemFind").mockReturnValue(true);
  const find = jest.spyOn(pages, "presentSystemFind").mockResolvedValue(undefined as never);
  const root = menu();
  await act(async () => void openPageMenu());
  act(() => showFind());
  expect(usePageUi.getState().menuOpen).toBe(false);
  act(() => jest.advanceTimersByTime(2000));
  expect(find).not.toHaveBeenCalled();
  act(() => menuSheet(root)!.props.onDismiss({ nativeEvent: {} }));
  await flush();
  expect(find).toHaveBeenCalledWith("t0");
  unmount(root);
});

onIos("History opens inside the page menu's own sheet at full height instead of waiting for the menu to close, and closing either closes both", async () => {
  page("https://site0.example/", false);
  const root = menu();
  await act(async () => void openPageMenu());
  await pressButton(root, "History");
  expect(usePageUi.getState()).toMatchObject({ menuOpen: true, menuPage: "library" });
  expect(useLibrary.getState()).toMatchObject({ open: true, section: "history" });
  expect(sheetIn(root, "expoLibrarySheet")!.props.isPresented).toBe(false);
  expect(menuSheet(root)!.props.isPresented).toBe(true);
  expect(titled(menuSheet(root)!, "History")).not.toHaveLength(0);
  act(() => menuSheet(root)!.props.onIsPresentedChange({ nativeEvent: { isPresented: false } }));
  expect(usePageUi.getState().menuOpen).toBe(false);
  expect(useLibrary.getState().open).toBe(false);
  expect(sheetIn(root, "expoLibrarySheet")!.props.isPresented).toBe(false);
  await act(async () => void openPageMenu());
  await pressButton(root, "Bookmarks");
  act(() => library.closeLibrary());
  expect(usePageUi.getState().menuOpen).toBe(false);
  unmount(root);
});
