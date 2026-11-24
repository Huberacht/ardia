import { makeMutable, runOnJS, runOnUI } from "react-native-reanimated";
import { create } from "zustand";
import { labTrace } from "../../platform/lab";
import { pageNavigation, usePages } from "../pages/store";
import { currentTabs } from "../tabs/store";
import { findTab } from "../tabs/tabsState";
import { pageBarPreviewShown, pageBarShown, previewPageBar } from "./deckPull";
import { commitBarAction, holdBarAction, takeBarAction, useBrowse, whenPageCoverHidden, type BarAction } from "./store";

export const destination = {
  id: makeMutable(""),
  turn: makeMutable(0),
  cover: makeMutable({ id: "", name: "" }),
};

export type DestinationAddress = { host: string; spoken: string; isPrivate: boolean; insecure: boolean; fill: string };

export const destinationAddresses = makeMutable<Record<string, DestinationAddress>>({});

export const DESTINATION_COVER_ID = "destinationCover";

export const DESTINATION_HELD_MS = 4_000;

export function liftDestination(id: string) {
  "worklet";
  destination.turn.value += 1;
  destination.id.value = id;
  pageBarShown.value = 1;
  pageBarPreviewShown.value = 1;
}

export function destinationFaceShows(faceId: string, liftedId: string, barShown: number): boolean {
  "worklet";
  return faceId !== "" && faceId === liftedId && barShown > 0;
}

export function destinationHeldFill(liftedId: string, barShown: number, table: Record<string, DestinationAddress>): string | null {
  "worklet";
  return liftedId !== "" && barShown > 0 ? (table[liftedId]?.fill ?? null) : null;
}

export function destinationHeldUntil(liftedId: string, cover: { id: string; name: string }): string | null {
  "worklet";
  return liftedId !== "" && cover.id === liftedId && cover.name !== "" ? cover.name : null;
}

export function destinationLeafShows(liftedId: string, shownId: string, leafId: string | null, previewShown: number): boolean {
  "worklet";
  return previewShown > 0 && liftedId !== "" && liftedId !== shownId && leafId === liftedId;
}

export function destinationStandsIn(liftedId: string, shownId: string, previewShown: number): boolean {
  "worklet";
  return previewShown > 0 && liftedId !== "" && liftedId !== shownId;
}

type DestinationState = { prepared: string | null; arriving: string | null; cover: string | null; spent: Readonly<Record<string, number>> };

export const useDestination = create<DestinationState>()(() => ({ prepared: null, arriving: null, cover: null, spent: {} }));

const spentAfter = (spent: Readonly<Record<string, number>>, id: string | null) => (id === null ? spent : { ...spent, [id]: (spent[id] ?? 0) + 1 });

export const destinationFaceKey = (id: string, spent: Readonly<Record<string, number>>) => `${id}:${spent[id] ?? 0}`;

function spendFace(id: string) {
  useDestination.setState((now) => (now.arriving === id ? now : { spent: spentAfter(now.spent, id) }));
}

const faceHolds = new Map<string, number>();

export const useDestinationFaces = create<{ ids: readonly string[] }>()(() => ({ ids: [] }));

const publishFaces = () => {
  const ids = [...faceHolds.keys()];
  const was = useDestinationFaces.getState().ids;
  if (was.length !== ids.length || was.some((id, at) => id !== ids[at])) useDestinationFaces.setState({ ids });
};

export function holdDestinationFace(id: string): () => void {
  faceHolds.set(id, (faceHolds.get(id) ?? 0) + 1);
  publishFaces();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (faceHolds.get(id) ?? 1) - 1;
    if (left > 0) faceHolds.set(id, left);
    else faceHolds.delete(id);
    publishFaces();
  };
}

export function destinationFaceIds(held: readonly string[], prepared: string | null, arriving: string | null): readonly string[] {
  const extra = [prepared, arriving].filter((id, at, all): id is string => id !== null && !held.includes(id) && all.indexOf(id) === at);
  return extra.length === 0 ? held : [...held, ...extra];
}

export const deckScope = (turn: number) => `deck:${turn}`;

export function pressDestination(id: string) {
  previewPageBar(id);
  prepareDestination(id);
}

export function prepareDestination(id: string) {
  const now = useDestination.getState();
  if (now.arriving === id || (now.arriving === null && now.prepared === id)) return;
  if (now.arriving !== null) {
    stopWaiting();
    destination.cover.value = { id: "", name: "" };
  }
  useDestination.setState({ prepared: id, arriving: null, cover: null, spent: spentAfter(now.spent, now.arriving) });
}

let coverSeq = 0;
let stopWait: (() => void) | null = null;

const stopWaiting = () => {
  const stop = stopWait;
  stopWait = null;
  stop?.();
};

export const barFencedForDestination = (_shownId: string) => {
  if (useBrowse.getState().surface !== "deck") return false;
  const lifted = destination.id.value;
  return lifted !== "" && useDestination.getState().arriving !== lifted;
};

export function routeBarToDestination(shownId: string, action: BarAction): boolean {
  if (!barFencedForDestination(shownId)) return false;
  holdBarAction(destination.id.value, action, deckScope(destination.turn.value));
  return true;
}

export const takeDestinationAction = (id: string): BarAction | null => takeBarAction(deckScope(destination.turn.value), id);

export function arriveFromDeck(id: string, held: BarAction | null = null) {
  stopWaiting();
  if (held && currentTabs().selectedId === id) commitBarAction(id, held);
  if (destination.id.value !== id) runOnUI(liftDestination)(id);
  coverSeq += 1;
  const cover = `${DESTINATION_COVER_ID}-${coverSeq}`;
  const replaced = useDestination.getState().arriving;
  useDestination.setState((now) => ({ prepared: id, arriving: id, cover, spent: replaced !== null && replaced !== id ? spentAfter(now.spent, replaced) : now.spent }));
  destination.cover.value = { id, name: cover };
  const failed = () => {
    if (pageNavigation(id)?.failure && useDestination.getState().cover === cover) releaseDestination(id);
  };
  const stopFailure = usePages.subscribe(failed);
  const wait = (): (() => void) =>
    whenPageCoverHidden(
      id,
      DESTINATION_HELD_MS,
      (reason) => {
        const now = useDestination.getState();
        if (now.arriving !== id || now.cover !== cover) return;
        if (reason === "lost" && findTab(currentTabs(), id) && currentTabs().selectedId === id && !pageNavigation(id)?.failure) {
          labTrace(`PAGELAB destination ${id} still undrawn after ${DESTINATION_HELD_MS} ms, its face stays and waits again`);
          const again = wait();
          stopWait = () => {
            stopFailure();
            again();
          };
          return;
        }
        stopFailure();
        releaseDestination(id);
      },
      cover,
    );
  const stopCover = wait();
  stopWait = () => {
    stopFailure();
    stopCover();
  };
}

export function releaseDestination(id: string | null = null) {
  const now = useDestination.getState();
  if (id !== null && now.prepared !== id && now.arriving !== id) return;
  if (id === null || now.arriving === id) stopWaiting();
  useDestination.setState({ prepared: null, arriving: null, cover: null });
  destination.cover.value = { id: "", name: "" };
  runOnUI((released: string | null, spent: string | null) => {
    "worklet";
    if (released === null || destination.id.value === released) destination.id.value = "";
    if (spent !== null) runOnJS(spendFace)(spent);
  })(id, now.arriving);
}

export function dropPreparedDestination() {
  const now = useDestination.getState();
  if (now.arriving !== null) return;
  if (now.prepared !== null) useDestination.setState({ prepared: null });
  runOnUI(() => {
    "worklet";
    destination.id.value = "";
  })();
}

export function destinationPageFailed(id: string) {
  const now = useDestination.getState();
  if (now.arriving === id || now.prepared === id) releaseDestination(id);
}

export const destinationCoverOf = (id: string) => {
  const { arriving, cover } = useDestination.getState();
  return arriving === id ? cover : null;
};

export const destinationCovers = (id: string) => useDestination.getState().arriving === id;

export const useDestinationCover = (id: string) => useDestination((s) => (s.arriving === id ? s.cover : null));

export function publishDestinationAddresses(addresses: Record<string, DestinationAddress>) {
  destinationAddresses.value = addresses;
}
