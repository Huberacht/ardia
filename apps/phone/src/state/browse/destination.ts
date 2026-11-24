import { makeMutable, runOnUI } from "react-native-reanimated";
import { create } from "zustand";
import { labTrace } from "../../platform/lab";
import { pageNavigation } from "../pages/store";
import { currentTabs } from "../tabs/store";
import { findTab } from "../tabs/tabsState";
import { pageBarPreviewShown, pageBarShown, previewPageBar } from "./deckPull";
import { commitBarAction, holdBarAction, takeBarAction, whenPageCoverHidden, type BarAction } from "./store";

export const destination = {
  id: makeMutable(""),
  turn: makeMutable(0),
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

export function destinationFaceMark(faceId: string, liftedId: string, barShown: number): string {
  "worklet";
  return destinationFaceShows(faceId, liftedId, barShown) ? `dest-face:${faceId}` : "";
}

export function destinationBarMark(liftedId: string, barShown: number): string {
  "worklet";
  return liftedId !== "" && barShown > 0 ? `dest-bar:${liftedId}` : "";
}

export function destinationHeldFill(liftedId: string, barShown: number, table: Record<string, DestinationAddress>): string | null {
  "worklet";
  return liftedId !== "" && barShown > 0 ? (table[liftedId]?.fill ?? null) : null;
}

export function destinationLeafShows(liftedId: string, shownId: string, leafId: string | null, previewShown: number): boolean {
  "worklet";
  return previewShown > 0 && liftedId !== "" && liftedId !== shownId && leafId === liftedId;
}

export function destinationStandsIn(liftedId: string, shownId: string, previewShown: number): boolean {
  "worklet";
  return previewShown > 0 && liftedId !== "" && liftedId !== shownId;
}

type DestinationState = { prepared: string | null; arriving: string | null; cover: string | null };

export const useDestination = create<DestinationState>()(() => ({ prepared: null, arriving: null, cover: null }));

export const deckScope = (turn: number) => `deck:${turn}`;

export function pressDestination(id: string) {
  previewPageBar(id);
  prepareDestination(id);
}

export function prepareDestination(id: string) {
  const now = useDestination.getState();
  if (now.arriving !== null || now.prepared === id) return;
  useDestination.setState({ prepared: id });
}

let coverSeq = 0;
let stopWait: (() => void) | null = null;

const stopWaiting = () => {
  const stop = stopWait;
  stopWait = null;
  stop?.();
};

export function routeBarToDestination(shownId: string, action: BarAction): boolean {
  const lifted = destination.id.value;
  if (!lifted || lifted === shownId || useDestination.getState().arriving === lifted) return false;
  holdBarAction(lifted, action, deckScope(destination.turn.value));
  return true;
}

export const barFencedForDestination = (shownId: string) => {
  const lifted = destination.id.value;
  return lifted !== "" && lifted !== shownId && useDestination.getState().arriving !== lifted;
};

export const takeDestinationAction = (id: string): BarAction | null => takeBarAction(deckScope(destination.turn.value), id);

export function arriveFromDeck(id: string, held: BarAction | null = null) {
  stopWaiting();
  if (held && currentTabs().selectedId === id) commitBarAction(id, held);
  if (destination.id.value !== id) runOnUI(liftDestination)(id);
  coverSeq += 1;
  const cover = `${DESTINATION_COVER_ID}-${coverSeq}`;
  useDestination.setState({ prepared: id, arriving: id, cover });
  const wait = (): (() => void) =>
    whenPageCoverHidden(
      id,
      DESTINATION_HELD_MS,
      (reason) => {
        stopWait = null;
        const now = useDestination.getState();
        if (now.arriving !== id || now.cover !== cover) return;
        if (reason === "lost" && findTab(currentTabs(), id) && currentTabs().selectedId === id && !pageNavigation(id)?.failure) {
          labTrace(`PAGELAB destination ${id} still undrawn after ${DESTINATION_HELD_MS} ms, its face stays and waits again`);
          stopWait = wait();
          return;
        }
        releaseDestination(id);
      },
      cover,
    );
  stopWait = wait();
}

export function releaseDestination(id: string | null = null) {
  const now = useDestination.getState();
  if (id !== null && now.prepared !== id && now.arriving !== id) return;
  if (id === null || now.arriving === id) stopWaiting();
  useDestination.setState({ prepared: null, arriving: null, cover: null });
  if (id === null || destination.id.value === id) destination.id.value = "";
  runOnUI((released: string | null) => {
    "worklet";
    if (released !== null && destination.id.value !== released) return;
    destination.id.value = "";
  })(id);
}

export function dropPreparedDestination() {
  const now = useDestination.getState();
  if (now.arriving !== null) return;
  if (now.prepared !== null) useDestination.setState({ prepared: null });
  destination.id.value = "";
  runOnUI(() => {
    "worklet";
    destination.id.value = "";
  })();
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
