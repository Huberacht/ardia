import { blocking } from "../../platform/blocking";
import { downloads, type DownloadEvent } from "../../platform/downloads";
import { pages, type PageEngineEvent, type PageRequestAnswer } from "../../platform/pages";

export type { ReadableContent } from "../../platform/pages";
import { copyText, openExternal, preferredLanguage, pressHaptic, shareLink, successHaptic } from "../../platform/system";
import { cancelSearch, closeArchive, deckPullCommitted, openTab, showDeck, takeSheetFromSettings, useBrowse } from "../browse/store";
import { display } from "../search/omnibox";
import { presentSearch, searchState } from "../search/store";
import { currentPreferences, setPreference } from "../settings/store";
import { designFor } from "../../lib/design";
import { Platform } from "react-native";
import { listenToPages, openPageInBackground, pageHandle, pageIsFullscreen, pageRequest, settled, storeFind, storeFullscreen, storeRequest, usePages } from "../pages/store";
import { closeTabById, currentTabs, openNewTab, useTabs } from "../tabs/store";
import { isSyncableUrl } from "../tabs/tabModels";
import { findTab } from "../tabs/tabsState";
import { blockersToast, searchQuery, translationUrl, type NightShadeMode } from "./pageMenu";
import { backLayer, downloadedToast, downloadFailedToast, downloadingToast, pressPlan, stoppedPrivateDownloadsToast, type PressAction, type Request } from "./pagePrompts";
import { onboardingBack } from "../onboarding/store";
import { refreshSettings } from "../settings/actions";
import { openSettings, openSettingsPage, popSettings, type SettingsRoute } from "../settings/nav";
import { pinToMac, sendTab } from "../sync/actions";
import type { SyncedDevice } from "../../platform/sync";
import { linkToCopy } from "./linkCopy";
import { pageUi, usePageUi, type MenuSite, type MenuTranslation, type Press } from "./store";
import { closeVoiceSearch, useVoice } from "../voice/store";
import { addOnlineAgainListener } from "../../platform/network";
import { countUsage } from "../telemetry/telemetry";
import { geminiNanoMissingCount, pageSummaryOpenedCount, pageSummarySettledCounts } from "../../lib/telemetrySchema";
import { pageSummariesEnabled, pageSummariesRevision, refreshPageSummariesEnabled } from "../pageSummary/enabled";
import { dismissArchiveCard } from "../browse/archiveCard";
import { copy } from "../../lib/platformCopy";
import { launchValues } from "../../platform/launch";
import { actionWords } from "../../lib/sharedWords";
import { syncData } from "../sync/store";
import { closeLibrary, libraryBack, openLibrary, useLibrary, type LibrarySection } from "../library/store";
import { showToast, TOAST_LONG_DURATION_MS } from "../toasts/store";
import { syncOffered } from "../../platform/system";

const TITLE_FEEDBACK_MS = 1000;
const NO_APP_FOR_LINK = "No App Can Open This Link";

const quietly = (call: () => Promise<unknown>) => void settled(call, undefined);

const selectedId = () => currentTabs().selectedId;
const selectedTab = () => {
  const id = selectedId();
  return id ? findTab(currentTabs(), id) ?? null : null;
};
const hostOf = (url: string | null) => (url ? display(url).host || null : null);

let afterMenuHidden: (() => void) | null = null;

const knownSites = new Map<string, MenuSite>();
let preparedSite: string | null = null;

const sameSite = (a: MenuSite | null, b: MenuSite) => a !== null && a.host === b.host && a.nightShade === b.nightShade && a.blockersEnabled === b.blockersEnabled;
const sameTranslation = (a: MenuTranslation | null, b: MenuTranslation) => a !== null && a.languageName === b.languageName && a.confirmed === b.confirmed;
const sameLevels = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((level, index) => level === b[index]);

async function readMenuSite(url: string, host: string | null, isPrivate: boolean): Promise<MenuSite> {
  const [shade, blockers] = await Promise.all([settled(() => pages.nightShade(host, isPrivate), null), settled(() => blocking.isEnabledForSite(url, isPrivate), true)]);
  const site: MenuSite = { host, nightShade: shade?.mode ?? "disabled", blockersEnabled: blockers };
  if (!isPrivate && host) knownSites.set(host, site);
  return site;
}

const rememberSite = (site: MenuSite, isPrivate: boolean) => {
  if (!isPrivate && site.host) knownSites.set(site.host, site);
};

export function preparePageMenu() {
  const tab = selectedTab();
  if (!tab || tab.isPrivate) return;
  const navigation = usePages.getState().navigation[tab.id];
  if (!navigation || navigation.isLoading) return;
  const url = navigation.url ?? tab.url;
  const host = hostOf(url);
  if (!host || preparedSite === host) return;
  preparedSite = host;
  quietly(() => readMenuSite(url, host, false));
}

export const openPageMenu = () => showPageMenu(false);

async function showPageMenu(menuDocked: boolean) {
  const tab = selectedTab();
  if (!tab) return;
  afterMenuHidden = null;
  const url = usePages.getState().navigation[tab.id]?.url ?? tab.url;
  const host = hostOf(url);
  const known = tab.isPrivate || !host ? null : (knownSites.get(host) ?? null);
  usePageUi.setState({ menuOpen: true, menuPage: "main", menuDocked, titleFeedback: null, menuSite: known });
  if (menuDocked && !tab.isPrivate) countUsage("site_settings_sheet_opened");
  const [site, capabilities, translation] = await Promise.all([
    readMenuSite(url, host, tab.isPrivate),
    settled(async () => pages.capabilities(), null),
    settled(() => pages.translation(), null),
  ]);
  if (!tab.isPrivate) preparedSite = host;
  if (materialDesign() && selectedId() !== tab.id) return;
  const ui = pageUi();
  const levels = capabilities?.pageZoomLevels;
  usePageUi.setState({
    menuSite: ui.menuSite !== known || sameSite(ui.menuSite, site) ? ui.menuSite : site,
    menuTranslation: translation && !sameTranslation(ui.menuTranslation, translation) ? { languageName: translation.languageName, confirmed: translation.confirmed } : ui.menuTranslation,
    zoomLevels: levels && !sameLevels(levels, ui.zoomLevels) ? levels : ui.zoomLevels,
  });
}

export const closePageMenu = () => usePageUi.setState({ menuOpen: false });

export function pageMenuHidden() {
  const run = afterMenuHidden;
  afterMenuHidden = null;
  run?.();
}

function afterPageMenu(run: () => void) {
  if (!pageUi().menuOpen) {
    afterMenuHidden = null;
    run();
    return;
  }
  afterMenuHidden = run;
  closePageMenu();
}

export function openLibraryInMenu(section: LibrarySection) {
  usePageUi.setState({ menuPage: "library" });
  openLibrary(section);
}

export const shareOverPageMenu = () => {
  const tab = selectedTab();
  if (!tab || !isSyncableUrl(tab.url)) return;
  void shareLink(tab.url, tab.title)
    .catch(() => undefined)
    .finally(closePageMenu);
};

export function canPrintPages(): boolean {
  try {
    return pages.canPrint();
  } catch {
    return false;
  }
}

export function printCurrentPage() {
  const tab = selectedTab();
  const url = tab ? (usePages.getState().navigation[tab.id]?.url ?? tab.url) : null;
  if (!tab || !url || !isSyncableUrl(url)) return;
  afterPageMenu(() =>
    quietly(async () => {
      if ((await pages.print(tab.id)) && !tab.isPrivate) countUsage("pages_printed");
    }),
  );
}

export function canSummarizePages(): boolean {
  try {
    return pages.canSummarize();
  } catch {
    return false;
  }
}

export function summarizeCurrentPage() {
  const tab = selectedTab();
  if (!tab || !pageSummariesEnabled()) return;
  const navigation = usePages.getState().navigation[tab.id];
  const url = navigation?.url ?? tab.url;
  if (!isSyncableUrl(url) || navigation?.isLoading) return;
  const revision = pageSummariesRevision();

  afterPageMenu(() => {
    if (!pageSummariesEnabled() || pageSummariesRevision() !== revision) return;
    const current = selectedTab();
    const latest = usePages.getState().navigation[tab.id];
    if (current?.id !== tab.id || useBrowse.getState().surface !== "browsing" || latest?.isLoading || (latest?.url ?? current.url) !== url) return;
    quietly(() => pages.summarize(tab.id));
  });
}

export function openInDefaultBrowser() {
  const tab = selectedTab();
  closePageMenu();
  const url = tab ? (usePages.getState().navigation[tab.id]?.url ?? tab.url) : null;
  if (url && isSyncableUrl(url)) quietly(() => openExternal(url));
}

export function pinCurrentToMac() {
  if (!syncOffered()) return;
  const tab = selectedTab();
  if (!tab) return;
  const inTitle = copy().pinFeedbackInMenu && syncData().status.isEnabled;
  if (!inTitle) closePageMenu();
  void pinToMac(tab, () => openSettings({ page: "sync" }), inTitle ? showTitleFeedback : null);
}

export function sendCurrentTab(device: SyncedDevice) {
  const tab = selectedTab();
  closePageMenu();
  if (tab) void sendTab(tab, device);
}

export function openSiteSettings() {
  usePageUi.setState({ menuPage: "siteSettings" });
  if (materialDesign()) void refreshSettings();
}

const materialDesign = () => designFor(Platform.OS, false, currentPreferences().materialYou) === "material";

export const openDockedSiteSettings = () => showPageMenu(true);

export const closeMenuSubpage = () => usePageUi.setState({ menuPage: "main" });

export function openSiteSettingsSheet() {
  afterPageMenu(() => openSettingsPage({ page: "siteSettings" }));
}

export function openSiteSettingsRoute(route: SettingsRoute, { direct = false } = {}) {
  closePageMenu();
  openSettings(route, { direct });
}

const withPage = (run: (id: string) => Promise<unknown>) => {
  const id = selectedId();
  if (id) quietly(() => run(id));
};

export const menuBack = () => {
  closePageMenu();
  void pageHandle(selectedId())?.goBack();
};

export const menuForward = () => {
  closePageMenu();
  void pageHandle(selectedId())?.goForward();
};

export const menuReload = () => {
  closePageMenu();
  void pageHandle(selectedId())?.reload();
};

export const retryPage = (tabId: string) => void pageHandle(tabId)?.reload();

export function retryWhenOnline(tabId: string): () => void {
  const subscription = addOnlineAgainListener(() => {
    if (!findTab(currentTabs(), tabId)?.isPrivate) countUsage("pages_reloaded_online");
    retryPage(tabId);
  });
  return () => subscription.remove();
}

export const menuStop = () => void pageHandle(selectedId())?.stopLoading();

export function editPageQuery() {
  beginPageSearch("rises");
}

function beginPageSearch(arrival: "rises" | "dockedMenu") {
  const tab = selectedTab();
  if (!tab) return;
  if (arrival === "rises") closePageMenu();
  presentSearch("page", searchQuery(tab.url) ?? tab.url, null, { currentUrl: tab.url, currentTabId: tab.id }, arrival);
  if (arrival === "dockedMenu") closePageMenu();
}

function afterDockedMenu(run: () => void) {
  const tabId = selectedId();
  closePageMenu();
  afterMenuHidden = () => {
    if (tabId !== null && selectedId() === tabId && useBrowse.getState().surface === "browsing") run();
  };
}

export const editDockedPageQuery = () => {
  if (pageUi().menuOpen) beginPageSearch("dockedMenu");
};

export function copyCurrentLink() {
  const tab = selectedTab();
  if (!tab || !isSyncableUrl(tab.url)) return;
  const link = linkToCopy(tab.url);
  quietly(() => copyText(link.text));
  quietly(successHaptic);
  showTitleFeedback(link.acknowledgement);
}

export function showTitleFeedback(text: string) {
  usePageUi.setState({ titleFeedback: text });
  setTimeout(() => {
    if (pageUi().titleFeedback === text) usePageUi.setState({ titleFeedback: null });
  }, TITLE_FEEDBACK_MS);
}

export function shareCurrentPage() {
  const tab = selectedTab();
  if (!tab || !isSyncableUrl(tab.url)) return;
  closePageMenu();
  quietly(() => shareLink(tab.url, tab.title));
}

export function showReader() {
  const id = selectedId();
  if (!id) return;
  usePageUi.setState({ menuOpen: false, readerTabId: id });
}

export const closeReader = () => usePageUi.setState({ readerTabId: null });

export const readableContent = (id: string) => settled(() => pages.readableContent(id), null);

export const setReaderStep = (step: number) => setPreference("readerStep", step);
export const setReaderSerif = (serif: boolean) => setPreference("readerSerif", serif);
export const setReaderTheme = (theme: "light" | "sepia" | "dark") => setPreference("readerTheme", theme);

const usesSystemFind = () => {
  const value = launchValues().ArdiaAppFind;
  return value !== true && value !== "YES" && pages.hasSystemFind();
};

export function showFind() {
  const findIsPrivate = selectedTab()?.isPrivate ?? true;
  if (usesSystemFind()) {
    countUsage("find_opened_system");
    afterPageMenu(() => withPage((id) => pages.presentSystemFind(id)));
    return;
  }
  countUsage("find_opened_bar");
  if (!copy().findWaitsForMenu) {
    usePageUi.setState({ menuOpen: false, findOpen: true, findIsPrivate, findQuery: "" });
    return;
  }
  afterPageMenu(() => usePageUi.setState({ findOpen: true, findIsPrivate, findQuery: "" }));
}

export function showDockedFind() {
  const tab = selectedTab();
  if (!tab) return;
  if (!tab.isPrivate) countUsage("find_opened_bar");
  afterDockedMenu(() => usePageUi.setState({ findOpen: true, findIsPrivate: tab.isPrivate, findQuery: "" }));
}

export function typeFind(query: string) {
  usePageUi.setState({ findQuery: query });
  withPage((id) => (query ? pages.find(id, query) : pages.endFind(id)));
}

export const findNext = () => withPage((id) => pages.findNext(id));
export const findPrevious = () => withPage((id) => pages.findPrevious(id));

export function closeFind() {
  const id = selectedId();
  if (pageUi().findOpen && !pageUi().findIsPrivate) countUsage("find_closed_bar");
  usePageUi.setState({ findOpen: false, findIsPrivate: true, findQuery: "" });
  if (id) {
    storeFind(id, null);
    quietly(() => pages.endFind(id));
  }
}

export function translatePage() {
  const tab = selectedTab();
  if (!tab || !isSyncableUrl(tab.url)) return;
  closePageMenu();
  const { id, url, isPrivate } = tab;
  const translation = pageUi().menuTranslation;
  if (!isPrivate && translation && !translation.confirmed) usePageUi.setState({ menuTranslation: { ...translation, confirmed: true } });
  void (async () => {
    const remembered = await settled(() => pages.translationUrl(url), null);
    if (!isPrivate) {
      countUsage("pages_translated");
      await settled(() => pages.confirmTranslation(), undefined);
    }
    await pageHandle(id)?.loadUrl(remembered ?? translationUrl(url, preferredLanguage()));
  })();
}

export function setNightShadeOn(on: boolean) {
  const tab = selectedTab();
  const site = pageUi().menuSite;
  if (!tab || !site?.host) return;
  const mode: NightShadeMode = on ? "always" : "disabled";
  const next = { ...site, nightShade: mode };
  rememberSite(next, tab.isPrivate);
  usePageUi.setState({ menuSite: next });
  quietly(() => pages.setNightShade(mode, site.host, tab.isPrivate));
}

export const zoomOut = () => withPage((id) => pages.zoomOut(id));
export const zoomIn = () => withPage((id) => pages.zoomIn(id));
export const resetZoom = () => withPage((id) => pages.setPageZoom(id, 1));

export function setDesktopSite(on: boolean) {
  closePageMenu();
  withPage((id) => pages.setDesktopSite(id, on));
}

export function setBlockersOn(on: boolean) {
  const tab = selectedTab();
  const site = pageUi().menuSite;
  if (!tab || !site?.host) return;
  closePageMenu();
  rememberSite({ ...site, blockersEnabled: on }, tab.isPrivate);
  const url = usePages.getState().navigation[tab.id]?.url ?? tab.url;
  const host = site.host;
  quietly(async () => {
    await blocking.setEnabledForSite(url, on, tab.isPrivate);
    showToast(blockersToast(on, host), on ? "blocking" : "warning");
    await pageHandle(tab.id)?.reload();
  });
}

export function answerRequest(pageId: string, request: Request, answer: PageRequestAnswer) {
  storeRequest(pageId, null);
  quietly(() => pages.answerRequest(pageId, request.id, answer));
}

export const dismissPress = () => usePageUi.setState({ press: null });

export function pressAction(press: Press, action: PressAction) {
  dismissPress();
  const opener = findTab(currentTabs(), press.tabId);
  const plan = pressPlan(press, action, opener?.isPrivate ?? false, isSyncableUrl);
  switch (plan.kind) {
    case "open": {
      const tab = openNewTab({ url: plan.url, origin: "link", after: plan.after, selecting: false, isPrivate: plan.isPrivate });
      if (plan.background) void openPageInBackground(tab.id, plan.url, plan.isPrivate);
      else openTab(tab.id);
      return;
    }
    case "copy": {
      const link = linkToCopy(plan.url);
      quietly(() => copyText(link.text));
      quietly(successHaptic);
      showToast(link.acknowledgement, "link");
      return;
    }
    case "share":
      quietly(() => shareLink(plan.url, ""));
      return;
    case "download":
      quietly(() => pages.download(plan.pageId, plan.url));
      return;
    case "none":
      return;
  }
}

async function openPopup(openerId: string, popupId: string, url: string | null, isPrivate: boolean, inBackground: boolean) {
  const tab = openNewTab({ url: url ?? "about:blank", origin: "link", after: openerId, selecting: false, isPrivate });
  const opened = await settled(() => pages.openPopup(tab.id, popupId), false);
  if (!opened) closeTabById(tab.id);
  else if (!inBackground) openTab(tab.id);
}

const PRIVATE_STOPS_GATHER_MS = 250;
let privateStops = 0;
let privateStopsTimer: ReturnType<typeof setTimeout> | null = null;

function notePrivateDownloadStopped() {
  privateStops += 1;
  if (privateStopsTimer) return;
  privateStopsTimer = setTimeout(() => {
    const count = privateStops;
    privateStops = 0;
    privateStopsTimer = null;
    showToast(stoppedPrivateDownloadsToast(count), "warning", TOAST_LONG_DURATION_MS);
  }, PRIVATE_STOPS_GATHER_MS);
}

function downloadEvent(event: DownloadEvent) {
  if (event.name !== "downloads.finished") return;
  if (event.failure === "privateSessionEnded") {
    notePrivateDownloadStopped();
    return;
  }
  if (event.failure) {
    showToast(downloadFailedToast(event.fileName), "warning");
    return;
  }
  const uri = event.uri;
  showToast(downloadedToast(event.fileName), "download", TOAST_LONG_DURATION_MS, uri ? { label: actionWords.open, run: () => quietly(() => downloads.open(uri)) } : null);
}

function pageEvent(event: PageEngineEvent) {
  switch (event.name) {
    case "page.find":
      storeFind(event.pageId, event.result);
      return;
    case "page.request":
      storeRequest(event.pageId, event.request);
      return;
    case "page.fullscreen":
      storeFullscreen(event.pageId, event.isFullscreen);
      return;
    case "page.popup":
      void openPopup(event.pageId, event.popupId, event.url, event.isPrivate, event.inBackground === true);
      return;
    case "page.download":
      if (event.downloadId === null) showToast(downloadFailedToast(event.fileName), "warning");
      else showToast(downloadingToast(event.fileName), "download");
      return;
    case "page.longPress":
      if (event.pageId !== selectedId()) return;
      quietly(pressHaptic);
      usePageUi.setState({ press: { tabId: event.pageId, target: event.target, x: event.x, y: event.y } });
      return;
    case "page.externalAppMissing":
      showToast(NO_APP_FOR_LINK, "warning");
      return;
    case "page.summaryOpened": {
      const field = event.isPrivate ? null : pageSummaryOpenedCount(event.trigger);
      if (field) countUsage(field);
      return;
    }
    case "page.summarySettled":
      if (!event.isPrivate) for (const field of [...pageSummarySettledCounts(event.outcome, event.chatGPTFellBack), ...geminiNanoMissingCount(event.geminiNanoMissing)]) countUsage(field);
      return;
    default:
      return;
  }
}

let started = false;

export function startPageUi() {
  if (started) return;
  started = true;
  listenToPages(pageEvent);
  void refreshPageSummariesEnabled();
  try {
    downloads.addListener(downloadEvent);
  } catch {
    return;
  }
}

export const openInOtherApp = (url: string) => quietly(() => openExternal(url));

export function handleSystemBack(): boolean {
  if (onboardingBack()) return true;
  if (useVoice.getState().presented) {
    closeVoiceSearch();
    return true;
  }
  if (popSettings()) return true;
  if (libraryBack()) return true;
  const { surface, sheet } = useBrowse.getState();
  const id = selectedId();
  const ui = pageUi();
  if (searchState().open && surface !== "browsing") {
    cancelSearch();
    return true;
  }
  if (sheet) {
    const backToSettings = takeSheetFromSettings();
    closeArchive();
    if (backToSettings) openSettings();
    return true;
  }
  if (surface === "deck") return dismissArchiveCard();
  if (surface === "browsing" && deckPullCommitted()) return true;
  const layer = backLayer({
    isFullscreen: surface === "browsing" && pageIsFullscreen(id),
    hasRequest: surface === "browsing" && pageRequest(id) !== null,
    isSearching: searchState().open,
    hasPressMenu: ui.press !== null,
    isReading: ui.readerTabId !== null,
    isMenuOpen: ui.menuOpen,
    isOnMenuSubpage: ui.menuPage !== "main",
    isFinding: ui.findOpen,
    canGoBack: surface === "browsing" && Boolean(id && usePages.getState().navigation[id]?.canGoBack),
    hasTab: surface === "browsing" && id !== null,
  });
  switch (layer) {
    case "fullscreen":
      if (id) quietly(() => pages.exitFullscreen(id));
      return true;
    case "request": {
      const request = pageRequest(id);
      if (id && request) answerRequest(id, request as Request, { type: "dismiss" });
      return true;
    }
    case "tray":
      cancelSearch();
      return true;
    case "pressMenu":
      dismissPress();
      return true;
    case "reader":
      closeReader();
      return true;
    case "menuSubpage":
      closeMenuSubpage();
      return true;
    case "menu":
      closePageMenu();
      return true;
    case "find":
      closeFind();
      return true;
    case "pageHistory":
      void pageHandle(id)?.goBack();
      return true;
    case "deck":
      void showDeck();
      return true;
    default:
      return false;
  }
}

function closePageLayers() {
  const ui = pageUi();
  if (ui.menuOpen || ui.findOpen || ui.readerTabId || ui.press) {
    if (ui.findOpen) closeFind();
    usePageUi.setState({ menuOpen: false, readerTabId: null, press: null });
  }
  if (canSummarizePages()) quietly(() => pages.dismissSummaries());
}

useBrowse.subscribe((browse, previous) => {
  if (browse.surface !== previous.surface) closePageLayers();
});

useTabs.subscribe((tabs, previous) => {
  if (tabs.selectedId !== previous.selectedId) closePageLayers();
});

usePages.subscribe((pagesNow, pagesBefore) => {
  const id = selectedId();
  if (!id) return;
  const navigation = pagesNow.navigation[id];
  if (navigation && navigation !== pagesBefore.navigation[id] && !navigation.isLoading) preparePageMenu();
});

useLibrary.subscribe((library, before) => {
  const ui = pageUi();
  if (before.open && !library.open && ui.menuOpen && ui.menuPage === "library") closePageMenu();
});

usePageUi.subscribe((ui, before) => {
  if (before.menuOpen && !ui.menuOpen && ui.menuPage === "library" && useLibrary.getState().open) closeLibrary();
});
