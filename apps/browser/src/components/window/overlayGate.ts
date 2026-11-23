import { useEffect, useRef } from "react";
import type { PageState } from "../../state/tabs/pageState";
import { consentToken } from "../../state/telemetry/client";
import { notePageOverlay } from "../../state/telemetry/usage";

export const OVERLAY = {
  find: 1 << 0,
  status: 1 << 1,
  sadTab: 1 << 2,
  permission: 1 << 3,
  password: 1 << 4,
  autofill: 1 << 5,
  verificationCode: 1 << 6,
  newTabNotice: 1 << 7,
  externalApp: 1 << 8,
  engineOffer: 1 << 9,
  sharePicker: 1 << 10,
  deviceChooser: 1 << 11,
  castPicker: 1 << 12,
  historyMenu: 1 << 13,
  selection: 1 << 14,
  loading: 1 << 15,
  control: 1 << 16,
} as const;

export type Overlay = keyof typeof OVERLAY;

export const pageOverlays = (p: PageState): number =>
  (p.status ? OVERLAY.status : 0) |
  (p.crashed || p.unresponsive ? OVERLAY.sadTab : 0) |
  (p.permission ? OVERLAY.permission : 0) |
  (p.passwordPrompt ? OVERLAY.password : 0) |
  (p.autofillPrompt ? OVERLAY.autofill : 0) |
  (p.verificationCode ? OVERLAY.verificationCode : 0) |
  (p.externalApp ? OVERLAY.externalApp : 0);

export const overlayBits = (on: Partial<Record<Overlay, boolean>>): number => {
  let bits = 0;
  for (const key in on) if (on[key as Overlay]) bits |= OVERLAY[key as Overlay];
  return bits;
};

export const overlayCount = (bits: number): number => {
  let count = 0;
  for (let rest = bits; rest; rest &= rest - 1) count++;
  return count;
};

export type KeptOverlays = { has: (overlay: Overlay) => boolean; entersLater: (overlay: Overlay) => boolean };

export function useKeptOverlays(on: number): KeptOverlays {
  const atShow = useRef(on).current;
  const kept = useRef(0);
  kept.current |= on;
  const bits = kept.current;
  const counted = useRef(-1);
  useEffect(() => {
    const atFirst = counted.current < 0;
    const opened = atFirst ? bits : bits & ~counted.current;
    counted.current = bits;
    if (!opened) return;
    const consent = consentToken();
    for (let i = overlayCount(opened); i > 0; i--) notePageOverlay(atFirst ? "paneOverlayAtShow" : "paneOverlayOpened", consent);
  }, [bits]);
  return {
    has: (overlay) => (bits & OVERLAY[overlay]) !== 0,
    entersLater: (overlay) => (atShow & OVERLAY[overlay]) === 0,
  };
}

export function useKeptWhile(on: boolean, alive: boolean): boolean {
  const kept = useRef(false);
  kept.current = alive && (kept.current || on);
  return kept.current;
}
