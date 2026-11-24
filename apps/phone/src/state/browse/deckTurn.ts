import { makeMutable, runOnUI } from "react-native-reanimated";
import { create } from "zustand";

export type DeckControl = "more" | "spaces" | "privacy" | "search" | "plus";

export type DeckBounds = { left: number; top: number; right: number; bottom: number };

export type DeckControls = Partial<Record<DeckControl, DeckBounds>>;

export type PreparedDeck = { tabId: string; order: readonly string[]; revision: string; layout: number; phone: number; controls: DeckControls };

export type DeckPress = { control: DeckControl; turn: number; phone: number; deck: string; bounds: DeckBounds };

export type DeckHitCommand = { seq: number; turn: number; phone: number; control: DeckControl | "card"; label: string; deck: string; tabId?: string; posedTurn?: number };

export const DECK_PRESS_SLOP = 12;

export const deckTurn = {
  live: makeMutable(0),
  seq: makeMutable(0),
  reconciled: makeMutable(0),
  phone: makeMutable(0),
  prepared: makeMutable<PreparedDeck | null>(null),
  press: makeMutable<DeckPress | null>(null),
  pressed: makeMutable(""),
  hitMark: makeMutable(""),
  hitSeq: makeMutable(0),
};

export function deckOwnsInput(): boolean {
  "worklet";
  return deckTurn.live.value !== 0;
}

function deckAwaitsEntrance(): boolean {
  "worklet";
  const live = deckTurn.live.value;
  return live !== 0 && deckTurn.reconciled.value !== live;
}

export function deckReadyFor(id: string): boolean {
  "worklet";
  const prepared = deckTurn.prepared.value;
  return prepared !== null && prepared.tabId === id && prepared.phone === deckTurn.phone.value && prepared.order.includes(id);
}

export function takeDeckTurn(): number {
  "worklet";
  const turn = deckTurn.seq.value + 1;
  deckTurn.seq.value = turn;
  deckTurn.reconciled.value = 0;
  deckTurn.press.value = null;
  deckTurn.pressed.value = "";
  deckTurn.live.value = turn;
  return turn;
}

function claimDeckTurnOnUI() {
  "worklet";
  if (deckTurn.live.value === 0) takeDeckTurn();
  deckTurn.reconciled.value = deckTurn.live.value;
}

export function releaseDeckTurnOnUI(turn: number) {
  "worklet";
  if (turn !== 0 && deckTurn.live.value !== turn) return;
  deckTurn.live.value = 0;
  deckTurn.reconciled.value = 0;
  deckTurn.press.value = null;
  deckTurn.pressed.value = "";
  deckTurn.hitMark.value = "";
}

function revokeDeckTurnOnUI(phone: number) {
  "worklet";
  deckTurn.phone.value = phone;
  deckTurn.prepared.value = null;
  releaseDeckTurnOnUI(0);
}

const within = (bounds: DeckBounds, x: number, y: number, slop: number) => {
  "worklet";
  return x >= bounds.left - slop && x <= bounds.right + slop && y >= bounds.top - slop && y <= bounds.bottom + slop;
};

const sameBounds = (a: DeckBounds, b: DeckBounds) => {
  "worklet";
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
};

export function pressDeckControl(control: DeckControl, x: number, y: number): boolean {
  "worklet";
  const prepared = deckTurn.prepared.value;
  const bounds = prepared?.controls[control];
  if (!deckAwaitsEntrance() || !prepared || !bounds || prepared.phone !== deckTurn.phone.value || !within(bounds, x, y, DECK_PRESS_SLOP)) return false;
  deckTurn.press.value = { control, turn: deckTurn.live.value, phone: prepared.phone, deck: prepared.tabId, bounds };
  deckTurn.pressed.value = control;
  deckTurn.hitMark.value = "";
  return true;
}

export function deckPressHolds(control: DeckControl): boolean {
  "worklet";
  return deckTurn.press.value?.control === control;
}

export function dropDeckPress(control: DeckControl) {
  "worklet";
  if (deckTurn.press.value?.control === control) deckTurn.press.value = null;
  if (deckTurn.pressed.value === control) deckTurn.pressed.value = "";
}

export function liftDeckControl(control: DeckControl, x: number, y: number): DeckHitCommand | null {
  "worklet";
  const press = deckTurn.press.value;
  dropDeckPress(control);
  if (!press || press.control !== control) return null;
  if (deckTurn.live.value !== press.turn || deckTurn.phone.value !== press.phone) return null;
  const prepared = deckTurn.prepared.value;
  const now = prepared?.controls[control];
  if (!prepared || !now || prepared.tabId !== press.deck || !sameBounds(now, press.bounds) || !within(press.bounds, x, y, DECK_PRESS_SLOP)) return null;
  const seq = deckTurn.hitSeq.value + 1;
  deckTurn.hitSeq.value = seq;
  const label = `deck-hit:${control}`;
  deckTurn.hitMark.value = label;
  return { seq, turn: press.turn, phone: press.phone, control, label, deck: press.deck };
}

export function markDeckCardHit(): number {
  "worklet";
  if (deckTurn.live.value === 0) return 0;
  deckTurn.hitMark.value = "deck-hit:card";
  return deckTurn.live.value;
}

let phoneGeneration = 0;

export const usePhoneTurn = create<{ generation: number }>()(() => ({ generation: 0 }));

export const currentPhoneGeneration = () => phoneGeneration;

export function advancePhoneGeneration(): number {
  phoneGeneration += 1;
  const generation = phoneGeneration;
  runOnUI(revokeDeckTurnOnUI)(generation);
  usePhoneTurn.setState({ generation });
  return generation;
}

type PreparedBase = { tabId: string; order: readonly string[]; revision: string };

let preparedBase: PreparedBase | null = null;
let preparedControls: DeckControls = {};
let layoutSeq = 0;
let publishQueued = false;
let publishedPhone = -1;

export function prepareDeck(base: PreparedBase | null) {
  const same = base !== null && preparedBase !== null && publishedPhone === phoneGeneration && base.tabId === preparedBase.tabId && base.revision === preparedBase.revision && base.order.length === preparedBase.order.length && base.order.every((id, at) => id === preparedBase!.order[at]);
  if (same) return;
  preparedBase = base;
  publishPrepared();
}

export function placeDeckControl(control: DeckControl, bounds: DeckBounds | null) {
  const was = preparedControls[control];
  if (bounds === null ? was === undefined : was !== undefined && sameRect(was, bounds)) return;
  const next = { ...preparedControls };
  if (bounds === null) delete next[control];
  else next[control] = bounds;
  preparedControls = next;
  if (publishQueued) return;
  publishQueued = true;
  void Promise.resolve().then(() => {
    publishQueued = false;
    publishPrepared();
  });
}

const sameRect = (a: DeckBounds, b: DeckBounds) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

function publishPrepared() {
  const base = preparedBase;
  layoutSeq += 1;
  publishedPhone = phoneGeneration;
  const prepared: PreparedDeck | null = base ? { ...base, order: [...base.order], layout: layoutSeq, phone: phoneGeneration, controls: { ...preparedControls } } : null;
  runOnUI((next: PreparedDeck | null) => {
    "worklet";
    deckTurn.prepared.value = next;
  })(prepared);
}

export function forgetPreparedDeck() {
  preparedBase = null;
  preparedControls = {};
  publishPrepared();
}

export const useDeckHits = create<{ hit: DeckHitCommand | null }>()(() => ({ hit: null }));

const consumedHits = new Set<number>();

export function queueDeckHit(hit: DeckHitCommand) {
  if (consumedHits.has(hit.seq)) return false;
  useDeckHits.setState({ hit });
  return true;
}

export function takeDeckHit(hit: DeckHitCommand): boolean {
  if (consumedHits.has(hit.seq) || hit.phone !== phoneGeneration) {
    if (useDeckHits.getState().hit === hit) useDeckHits.setState({ hit: null });
    return false;
  }
  consumedHits.add(hit.seq);
  if (useDeckHits.getState().hit === hit) useDeckHits.setState({ hit: null });
  return true;
}

export const peekDeckHit = () => useDeckHits.getState().hit;

export function dropDeckHits() {
  if (useDeckHits.getState().hit) useDeckHits.setState({ hit: null });
}

let cardHits = 0;

export function cardHitSeq() {
  cardHits -= 1;
  return cardHits;
}

let reconciledTurn = 0;

export const deckTurnReconciled = (turn: number) => turn !== 0 && turn === reconciledTurn;

export function noteDeckTurnReconciled(turn: number) {
  reconciledTurn = turn;
}

export function markDeckEntranceCommitted(turn: number) {
  runOnUI((committed: number) => {
    "worklet";
    if (committed === 0) {
      claimDeckTurnOnUI();
      return;
    }
    if (deckTurn.live.value === committed) deckTurn.reconciled.value = committed;
  })(turn);
}
