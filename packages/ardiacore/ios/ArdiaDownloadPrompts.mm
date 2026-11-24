#import "ArdiaDownloadPrompts.h"

#include <os/lock.h>

namespace ardia_files {

namespace {

constexpr NSTimeInterval kAwaitingSeconds = 120;
constexpr NSUInteger kMaxAwaiting = 256;

os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;

NSMutableDictionary<NSString *, NSNumber *> *Awaiting() {
  static NSMutableDictionary<NSString *, NSNumber *> *awaiting = [NSMutableDictionary dictionary];
  return awaiting;
}

void DropStale(NSTimeInterval now) {
  NSMutableDictionary<NSString *, NSNumber *> *awaiting = Awaiting();
  for (NSString *key in awaiting.allKeys)
    if (now - awaiting[key].doubleValue > kAwaitingSeconds) [awaiting removeObjectForKey:key];
}

}

void NoteDownloadEvent(NSDictionary *event, NSTimeInterval now) {
  if (![event isKindOfClass:NSDictionary.class]) return;
  NSString *downloadId = event[@"id"];
  if (![downloadId isKindOfClass:NSString.class] || !downloadId.length) return;
  NSString *path = event[@"path"];
  NSString *state = event[@"state"];
  const bool offTheRecord = [event[@"offTheRecord"] isKindOfClass:NSNumber.class] && [event[@"offTheRecord"] boolValue];
  const bool waiting = !offTheRecord && [state isEqual:@"downloading"] && (![path isKindOfClass:NSString.class] || !path.length);
  os_unfair_lock_lock(&gLock);
  DropStale(now);
  if (!waiting) [Awaiting() removeObjectForKey:downloadId];
  else if (!Awaiting()[downloadId] && Awaiting().count < kMaxAwaiting) Awaiting()[downloadId] = @(now);
  os_unfair_lock_unlock(&gLock);
}

bool AwaitingDownloadTarget(NSTimeInterval now) {
  os_unfair_lock_lock(&gLock);
  DropStale(now);
  const bool any = Awaiting().count > 0;
  os_unfair_lock_unlock(&gLock);
  return any;
}

bool LooksLikeDownloadPicker(bool awaitingTarget, NSString *message) {
  return awaitingTarget && !message.length;
}

void ForgetDownloadPrompts() {
  os_unfair_lock_lock(&gLock);
  [Awaiting() removeAllObjects];
  os_unfair_lock_unlock(&gLock);
}

}
