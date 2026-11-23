#import "ArdiaPictureInPictureInternal.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaPiPZoomMath.h"

#import <objc/runtime.h>

#include <vector>

using namespace ardia_pip;

@implementation ArdiaPiPZoom (Routing)

static __weak NSWindow *gZoomGesture;
static ardia_pip_zoom::PinchLock gPinchLock;
static NSTimeInterval gLastPinchAt;
static NSTimer *gPinchStall;
static NSInteger gSeenEventWindow, gSeenRoutedTo, gSeenPinches;
static BOOL gSeenFromOtherApp, gSeenConsumed;

+ (BOOL)handle:(NSEvent *)event {
  return [self handle:event fromOtherApp:NO];
}

+ (BOOL)handleFromOtherApp:(NSEvent *)event {
  return [self handle:event fromOtherApp:YES];
}

+ (BOOL)handle:(NSEvent *)event fromOtherApp:(BOOL)fromOtherApp {
  const BOOL pinch = event.type == NSEventTypeMagnify;
  if (pinch && event.timestamp > 0 && event.timestamp == gLastPinchAt) return YES;
  if (pinch) gLastPinchAt = event.timestamp;
  BOOL handled = pinch ? [self routePinch:event fromOtherApp:fromOtherApp] : [self route:event];
  static BOOL trace = [ArdiaLaunchConfig.shared traced:@"pipZoom"];
  if (trace)
    NSLog(@"[pip-zoom] type %lu window %ld (%@) other app %d pointer %@ cmd %d phase %lu/%lu dy %.2f precise %d mag %.3f -> %@ %@",
          (unsigned long)event.type, (long)event.windowNumber, event.window.className, fromOtherApp, NSStringFromPoint(PointerOf(event)),
          (event.modifierFlags & NSEventModifierFlagCommand) != 0, (unsigned long)event.phase,
          (unsigned long)(event.type == NSEventTypeScrollWheel ? event.momentumPhase : 0),
          event.type == NSEventTypeScrollWheel ? event.scrollingDeltaY : 0,
          event.type == NSEventTypeScrollWheel ? event.hasPreciseScrollingDeltas : 0, pinch ? event.magnification : 0,
          handled ? @"zoomed" : @"passed", NSStringFromRect(event.window.frame));
  return handled;
}

+ (BOOL)anyZoomable {
  for (NSWindow *window in NSApp.windows)
    if ([self zooms:window]) return YES;
  return NO;
}

+ (std::vector<ardia_pip_zoom::Window>)zoomableWindows {
  std::vector<ardia_pip_zoom::Window> windows;
  for (NSNumber *number in [NSWindow windowNumbersWithOptions:0]) {
    NSWindow *window = [NSApp windowWithWindowNumber:number.integerValue];
    if (!window || ![self zooms:window]) continue;
    ArdiaPiPZoom *zoom = objc_getAssociatedObject(window, kZoomKey);
    const NSRect frame = window.frame;
    windows.push_back({(long)window.windowNumber, (long)[zoom standInNumber], {NSMinX(frame), NSMinY(frame), NSWidth(frame), NSHeight(frame)}});
  }
  return windows;
}

+ (NSWindow *)windowUnder:(NSPoint)pointer {
  if (!ardia_pip_zoom::UsablePointer({pointer.x, pointer.y})) return nil;
  const std::vector<ardia_pip_zoom::Window> windows = [self zoomableWindows];
  if (windows.empty()) return nil;
  const long topmost = [NSWindow windowNumberAtPoint:pointer belowWindowWithWindowNumber:0];
  const long number = ardia_pip_zoom::WindowUnder(windows, {pointer.x, pointer.y}, topmost);
  return number ? [NSApp windowWithWindowNumber:number] : nil;
}

+ (BOOL)route:(NSEvent *)event {
  BOOL command = (event.modifierFlags & NSEventModifierFlagCommand) != 0;
  NSEventPhase phase = event.phase, momentum = event.momentumPhase;
  BOOL wheel = phase == NSEventPhaseNone && momentum == NSEventPhaseNone;
  if (wheel || (phase & (NSEventPhaseBegan | NSEventPhaseMayBegin))) gZoomGesture = nil;
  NSWindow *window = gZoomGesture;
  const NSPoint pointer = PointerOf(event);
  if (!ardia_pip_zoom::UsablePointer({pointer.x, pointer.y})) return window != nil;
  if (!window) {
    if (!command) return NO;
    window = [self windowUnder:pointer];
  }
  if (!window || ![self zooms:window] || ![self enabled]) return NO;
  if (!wheel) gZoomGesture = window;
  if (momentum & (NSEventPhaseEnded | NSEventPhaseCancelled)) gZoomGesture = nil;
  double dy = event.scrollingDeltaY;
  if (dy == 0 || !std::isfinite(dy)) return YES;
  [[self forWindow:window] zoomBy:ardia_pip_zoom::ScrollFactor(dy, event.hasPreciseScrollingDeltas) at:pointer ease:!event.hasPreciseScrollingDeltas];
  return YES;
}

+ (BOOL)routePinch:(NSEvent *)event fromOtherApp:(BOOL)fromOtherApp {
  if (![self enabled]) return NO;
  const NSPoint pointer = PointerOf(event);
  if (!ardia_pip_zoom::UsablePointer({pointer.x, pointer.y})) return gPinchLock.owned;
  const NSEventPhase phase = event.phase;
  const ardia_pip_zoom::Phase step = (phase & (NSEventPhaseBegan | NSEventPhaseMayBegin)) ? ardia_pip_zoom::Phase::Began
                                     : (phase & (NSEventPhaseEnded | NSEventPhaseCancelled)) ? ardia_pip_zoom::Phase::Ended
                                     : phase == NSEventPhaseNone ? ardia_pip_zoom::Phase::None
                                                                 : ardia_pip_zoom::Phase::Changed;
  const BOOL looks = step == ardia_pip_zoom::Phase::Began || (!gPinchLock.owned && !gPinchLock.elsewhere);
  NSWindow *under = looks ? [self windowUnder:pointer] : nil;
  NSWindow *locked = gPinchLock.window ? [NSApp windowWithWindowNumber:gPinchLock.window] : nil;
  const ardia_pip_zoom::PinchStep next =
      ardia_pip_zoom::StepPinch(gPinchLock, step, under ? (long)under.windowNumber : 0, locked && [self zooms:locked]);
  [self apply:next magnification:event.magnification at:pointer fromOtherApp:fromOtherApp];
  [self watchForStall];
  gSeenEventWindow = event.windowNumber;
  gSeenRoutedTo = next.window;
  gSeenFromOtherApp = fromOtherApp;
  gSeenConsumed = next.consume;
  gSeenPinches++;
  return next.consume;
}

+ (void)apply:(ardia_pip_zoom::PinchStep)next magnification:(double)magnification at:(NSPoint)pointer fromOtherApp:(BOOL)fromOtherApp {
  if (NSWindow *finished = next.finish ? [NSApp windowWithWindowNumber:next.finish] : nil) [[self forWindow:finished] pinchEnded];
  NSWindow *window = next.window ? [NSApp windowWithWindowNumber:next.window] : nil;
  if (!window) return;
  ArdiaPiPZoom *zoom = [self forWindow:window];
  if (next.cancel) [zoom cancelStandIn];
  if (next.begin) {
    const BOOL unfocused = fromOtherApp || !window.keyWindow;
    [zoom pinchBegan];
    [zoom notePinchUnfocused:unfocused fromOtherApp:fromOtherApp];
  }
  if (next.apply) [zoom pinchBy:ardia_pip_zoom::MagnifyFactor(magnification) at:pointer];
  if (next.end) [zoom pinchEnded];
}

+ (void)watchForStall {
  if (!gPinchLock.owned || !gPinchLock.window || gPinchLock.stalled) {
    [gPinchStall invalidate];
    gPinchStall = nil;
    return;
  }
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:ardia_pip_zoom::kPinchStall];
  if (gPinchStall.valid) return (void)(gPinchStall.fireDate = deadline);
  gPinchStall = [[NSTimer alloc] initWithFireDate:deadline interval:0 repeats:NO block:^(NSTimer *) {
    gPinchStall = nil;
    [ArdiaPiPZoom apply:ardia_pip_zoom::StallPinch(gPinchLock) magnification:0 at:NSZeroPoint fromOtherApp:NO];
  }];
  [NSRunLoop.mainRunLoop addTimer:gPinchStall forMode:NSRunLoopCommonModes];
}

+ (NSDictionary *)devLastPinch {
  return @{
    @"eventWindow" : @(gSeenEventWindow),
    @"routedTo" : @(gSeenRoutedTo),
    @"fromOtherApp" : @(gSeenFromOtherApp),
    @"consumed" : @(gSeenConsumed),
    @"events" : @(gSeenPinches),
    @"locked" : @(gPinchLock.window),
    @"stalled" : @(gPinchLock.stalled),
    @"stallTimer" : @(gPinchStall.valid),
  };
}

@end
