import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import "../platform/copy";
import { blocking } from "../platform/blocking";
import { pages } from "../platform/pages";
import { SystemPageMenuHost } from "../components/browsing/SystemPageMenu";
import { ExpoLibrarySheet } from "../components/library/ExpoLibrary";
import { DesignProvider } from "../components/ui";
import { openPageMenu, pageMenuHidden, printCurrentPage, setNightShadeOn, showFind } from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { useBrowse } from "../state/browse/store";
import * as library from "../state/library/store";
import { useLibrary } from "../state/library/store";
import { useTabs } from "../state/tabs/store";
import { pressButton, renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const navigation = (url: string, isLoading: boolean) => ({ url, title: "Site", canGoBack: false, canGoForward: false, isLoading, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 }) as never;
const page = (url: string, isLoading: boolean) => act(() => usePages.setState((state) => ({ ...state, navigation: { t0: navigation(url, isLoading) } })));
const twoPages = (first: string, second: string) => act(() => usePages.setState((state) => ({ ...state, navigation: { t0: navigation(first, false), t1: navigation(second, false) } })));
const select = (id: string) => act(() => useTabs.setState({ selectedId: id }));

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

const menuRows = (root: Root) => hosts(root.root, (props) => props.testID === "pageMenuWords");

onIos("the iPhone page menu mounts its rows once the page is quiet, before the first open, and keeps them mounted after it closes, so opening it only presents", async () => {
  page("https://site0.example/", true);
  const root = menu();
  expect(menuSheet(root)).toBeNull();
  page("https://site0.example/", false);
  expect(menuSheet(root)!.props.isPresented).toBe(false);
  const rows = menuRows(root)[0]!;
  expect(rows).toBeDefined();
  await act(async () => void openPageMenu());
  expect(menuSheet(root)!.props.isPresented).toBe(true);
  expect(menuRows(root)[0]).toBe(rows);
  act(() => menuSheet(root)!.props.onIsPresentedChange({ nativeEvent: { isPresented: false } }));
  expect(usePageUi.getState().menuOpen).toBe(false);
  act(() => menuSheet(root)!.props.onDismiss({ nativeEvent: {} }));
  expect(menuSheet(root)!.props.isPresented).toBe(false);
  expect(menuRows(root)[0]).toBe(rows);
  unmount(root);
});

onIos("a settled page's Night Shade and blocker state is read ahead, so the menu opens with its real switches instead of flipping them as it rises", async () => {
  page("https://site0.example/", false);
  await flush();
  act(() => void openPageMenu());
  expect(usePageUi.getState().menuSite).toEqual({ host: "site0.example", nightShade: "always", blockersEnabled: false });
  await flush();
});

onIos("Find on Page closes the menu and starts in the same moment, without waiting for the sheet to finish leaving", async () => {
  page("https://site0.example/", false);
  jest.spyOn(pages, "hasSystemFind").mockReturnValue(true);
  const find = jest.spyOn(pages, "presentSystemFind").mockResolvedValue(undefined as never);
  const root = menu();
  await act(async () => void openPageMenu());
  act(() => showFind());
  expect(usePageUi.getState().menuOpen).toBe(false);
  await flush();
  expect(find).toHaveBeenCalledWith("t0");
  unmount(root);
});

onIos("Print waits for the menu to be gone, runs once from the first of the sheet's disappearing or dismissal, and still runs if the menu's host goes first", async () => {
  page("https://site0.example/", false);
  jest.spyOn(pages, "canPrint").mockReturnValue(true);
  const print = jest.spyOn(pages, "print").mockResolvedValue(true);
  const root = menu();
  await act(async () => void openPageMenu());
  act(() => printCurrentPage());
  expect(print).not.toHaveBeenCalled();
  act(() => pageMenuHidden());
  act(() => menuSheet(root)!.props.onDismiss({ nativeEvent: {} }));
  await flush();
  expect(print).toHaveBeenCalledTimes(1);
  await act(async () => void openPageMenu());
  act(() => printCurrentPage());
  unmount(root);
  await flush();
  expect(print).toHaveBeenCalledTimes(2);
});

onIos("a follow-up asked for on one tab is dropped when another tab is shown before the menu has gone", async () => {
  withTabs(2);
  select("t0");
  twoPages("https://site-a.example/", "https://site-b.example/");
  jest.spyOn(pages, "canPrint").mockReturnValue(true);
  const print = jest.spyOn(pages, "print").mockResolvedValue(true);
  await act(async () => void openPageMenu());
  act(() => printCurrentPage());
  select("t1");
  act(() => pageMenuHidden());
  await flush();
  expect(print).not.toHaveBeenCalled();
});

onIos("a late site read from one tab's menu never lands in another tab's menu, and its switches write to the site they show", async () => {
  withTabs(2);
  select("t0");
  let answerA: (mode: { mode: string }) => void = () => undefined;
  jest.spyOn(pages, "nightShade").mockImplementation((host) => (host === "late-a.example" ? new Promise((resolve) => (answerA = resolve as never)) : Promise.resolve({ mode: "disabled" })) as never);
  const write = jest.spyOn(pages, "setNightShade").mockResolvedValue(undefined as never);
  twoPages("https://late-a.example/", "https://late-b.example/");
  act(() => void openPageMenu());
  select("t1");
  await act(async () => void openPageMenu());
  await flush();
  expect(usePageUi.getState().menuSite).toMatchObject({ host: "late-b.example", nightShade: "disabled" });
  answerA({ mode: "always" });
  await flush();
  expect(usePageUi.getState().menuSite).toMatchObject({ host: "late-b.example", nightShade: "disabled" });
  act(() => setNightShadeOn(true));
  await flush();
  expect(write).toHaveBeenCalledWith("always", "late-b.example", false);
  select("t0");
  act(() => setNightShadeOn(false));
  await flush();
  expect(write).toHaveBeenCalledTimes(1);
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
