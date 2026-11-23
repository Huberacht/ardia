import { useEffect, useRef } from "react";
import type { PageState } from "../../state/tabs/pageState";
import { consentToken, type ConsentToken } from "../../state/telemetry/client";
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

export const BEHIND_NEW_TAB = OVERLAY.permission | OVERLAY.externalApp | OVERLAY.engineOffer | OVERLAY.deviceChooser | OVERLAY.loading;

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

export type ShownOverlays = { previous: number; atShow: number; opened: number };

export function nextShownOverlays(was: ShownOverlays | null, shown: number): ShownOverlays {
  if (!was) return { previous: shown, atShow: overlayCount(shown), opened: 0 };
  return { previous: shown, atShow: 0, opened: overlayCount(shown & ~was.previous) };
}

export type KeptOverlays = { has: (overlay: Overlay) => boolean; entersLater: (overlay: Overlay) => boolean };

export function useKeptOverlays(on: number, shown: number): KeptOverlays {
  const atShow = useRef(on).current;
  const kept = useRef(0);
  kept.current |= on;
  const bits = kept.current;
  useShownOverlaysCount(shown);
  return {
    has: (overlay) => (bits & OVERLAY[overlay]) !== 0,
    entersLater: (overlay) => (atShow & OVERLAY[overlay]) === 0,
  };
}

function useShownOverlaysCount(shown: number) {
  const seen = useRef<ShownOverlays | null>(null);
  const unsent = useRef<{ atShow: number; opened: number; consent: ConsentToken | null } | null>(null);
  if (seen.current?.previous !== shown) {
    const next = nextShownOverlays(seen.current, shown);
    seen.current = next;
    if (next.atShow || next.opened) {
      const pending = unsent.current;
      unsent.current = pending ? { ...pending, atShow: pending.atShow + next.atShow, opened: pending.opened + next.opened } : { atShow: next.atShow, opened: next.opened, consent: consentToken() };
    }
  }
  useEffect(() => {
    const pending = unsent.current;
    if (!pending) return;
    unsent.current = null;
    for (let i = 0; i < pending.atShow; i++) notePageOverlay("paneOverlayAtShow", pending.consent);
    for (let i = 0; i < pending.opened; i++) notePageOverlay("paneOverlayOpened", pending.consent);
  }, [shown]);
}

export function useKeptWhile(on: boolean, alive: boolean): boolean {
  const kept = useRef(false);
  kept.current = alive && (kept.current || on);
  return kept.current;
}

export function useEligibleGate(on: boolean, eligible: boolean): { mounted: boolean; enter: boolean } {
  const gate = useRef({ mounted: false, enter: false, armed: false }).current;
  if (!eligible) Object.assign(gate, { mounted: false, enter: false, armed: false });
  else if (!gate.mounted && on) Object.assign(gate, { mounted: true, enter: gate.armed });
  else if (!gate.mounted) gate.armed = true;
  return { mounted: gate.mounted, enter: gate.enter };
}
