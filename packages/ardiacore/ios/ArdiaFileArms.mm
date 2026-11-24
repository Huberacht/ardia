#import "ArdiaHost.h"
#import "ArdiaFilePaths.h"
#import "ArdiaInternal.h"

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaFileArm : NSObject
@property(nonatomic, copy) NSString *armId;
@property(nonatomic, copy) NSString *kind;
@property(nonatomic, copy, nullable) NSString *tabId;
@property(nonatomic, copy) NSArray<NSString *> *paths;
@property(nonatomic) BOOL folder;
@property(nonatomic) BOOL once;
@property(nonatomic) NSTimeInterval armedAt;
@property(nonatomic) NSTimeInterval expiresAt;
@property(nonatomic, copy) NSString *state;
@property(nonatomic, copy, nullable) NSString *reason;
@property(nonatomic, copy) NSArray<NSString *> *landed;
@property(nonatomic) NSInteger answered;
@end

@implementation ArdiaFileArm
@end

NS_ASSUME_NONNULL_END

namespace ardia_host {

namespace {

constexpr NSUInteger kMaxActiveArms = 16;
constexpr NSUInteger kMaxKeptArms = 64;
constexpr NSUInteger kMaxUploadPaths = 64;
constexpr NSTimeInterval kMaxSeconds = 600;
constexpr NSTimeInterval kKeepEndedSeconds = 600;
constexpr NSUInteger kMaxIdBytes = 64;

NSMutableArray<ArdiaFileArm *> *Arms() {
  static NSMutableArray<ArdiaFileArm *> *arms = [NSMutableArray array];
  return arms;
}

NSTimeInterval Now() {
  return NSDate.date.timeIntervalSince1970;
}

bool Active(ArdiaFileArm *arm) {
  return [arm.state isEqualToString:@"armed"];
}

void End(ArdiaFileArm *arm, NSString *state, NSString *reason) {
  arm.state = state;
  arm.reason = reason;
  arm.expiresAt = Now();
}

void Sweep() {
  const NSTimeInterval now = Now();
  NSMutableArray<ArdiaFileArm *> *arms = Arms();
  for (ArdiaFileArm *arm in arms)
    if (Active(arm) && now >= arm.expiresAt) End(arm, @"expired", nil);
  NSIndexSet *old = [arms indexesOfObjectsPassingTest:^BOOL(ArdiaFileArm *arm, NSUInteger, BOOL *) {
    return !Active(arm) && now - arm.expiresAt > kKeepEndedSeconds;
  }];
  [arms removeObjectsAtIndexes:old];
  while (arms.count > kMaxKeptArms) {
    NSUInteger oldest = [arms indexOfObjectPassingTest:^BOOL(ArdiaFileArm *arm, NSUInteger, BOOL *) { return !Active(arm); }];
    if (oldest == NSNotFound) break;
    [arms removeObjectAtIndex:oldest];
  }
}

ArdiaFileArm *ArmNamed(NSString *armId) {
  for (ArdiaFileArm *arm in Arms())
    if ([arm.armId isEqualToString:armId]) return arm;
  return nil;
}

NSDictionary *Refused(NSString *reason, NSString *path) {
  return path ? @{@"ok" : @NO, @"reason" : reason, @"path" : path} : @{@"ok" : @NO, @"reason" : reason};
}

NSDictionary *Row(ArdiaFileArm *arm) {
  NSMutableDictionary *row = [@{
    @"id" : arm.armId,
    @"kind" : arm.kind,
    @"tab" : arm.tabId ?: NSNull.null,
    @"paths" : arm.paths,
    @"folder" : @(arm.folder),
    @"once" : @(arm.once),
    @"armedAt" : @(arm.armedAt * 1000),
    @"expiresAt" : @(arm.expiresAt * 1000),
    @"state" : arm.state,
    @"landed" : arm.landed,
    @"answered" : @(arm.answered),
  } mutableCopy];
  if (arm.reason) row[@"reason"] = arm.reason;
  return row;
}

bool SameWindow(NSWindow *tabWindow, NSWindow *parent) {
  if (tabWindow == parent) return true;
  if (!tabWindow || !parent) return false;
  return tabWindow.sheetParent == parent || parent.sheetParent == tabWindow || tabWindow.parentWindow == parent || parent.parentWindow == tabWindow;
}

ArdiaFileArm *ArmFor(NSString *kind, NSWindow *parent) {
  ArdiaFileArm *pick = nil;
  int pickRank = 0;
  for (ArdiaFileArm *arm in Arms()) {
    if (!Active(arm) || ![arm.kind isEqualToString:kind]) continue;
    int rank = 1;
    if (arm.tabId) {
      ArdiaCoreTab *tab = TabWithAppTabId(arm.tabId);
      if (!tab) {
        End(arm, @"cleared", @"tabClosed");
        continue;
      }
      if (!SameWindow(tab.view.window, parent)) continue;
      rank = 2;
    }
    if (rank > pickRank || (rank == pickRank && arm.armedAt >= pick.armedAt)) {
      pick = arm;
      pickRank = rank;
    }
  }
  return pick;
}

void Spend(ArdiaFileArm *arm) {
  arm.answered += 1;
  if (arm.once) End(arm, @"answered", nil);
}

NSArray<NSURL *> *UploadPicks(ArdiaFileArm *arm, NSOpenPanel *panel) {
  if (arm.paths.count > 1 && !panel.allowsMultipleSelection) {
    End(arm, @"failed", @"oneFileOnly");
    return nil;
  }
  NSMutableArray<NSURL *> *urls = [NSMutableArray array];
  for (NSString *path in arm.paths) {
    NSString *reason = nil;
    NSString *now = ardia_files::ChosenPath(path, &reason);
    if (!now || ![now isEqualToString:path]) {
      End(arm, @"failed", reason ?: @"changed");
      return nil;
    }
    BOOL directory = NO;
    [NSFileManager.defaultManager fileExistsAtPath:path isDirectory:&directory];
    if (directory ? !panel.canChooseDirectories : !panel.canChooseFiles) {
      End(arm, @"failed", directory ? @"wantsFiles" : @"wantsFolder");
      return nil;
    }
    [urls addObject:[NSURL fileURLWithPath:path isDirectory:directory]];
  }
  arm.landed = [urls valueForKey:@"path"];
  Spend(arm);
  return urls;
}

NSArray<NSURL *> *DownloadPicks(ArdiaFileArm *arm, NSSavePanel *panel) {
  NSString *reason = nil;
  NSString *target = arm.folder ? ardia_files::FreePathIn(arm.paths.firstObject, panel.nameFieldStringValue, &reason) : arm.paths.firstObject;
  if (!target || !ardia_files::StillFree(target, &reason)) {
    End(arm, @"failed", reason ?: @"exists");
    return nil;
  }
  arm.landed = [arm.landed arrayByAddingObject:target];
  Spend(arm);
  return @[ [NSURL fileURLWithPath:target isDirectory:NO] ];
}

}

bool HasArmedPanels() {
  for (ArdiaFileArm *arm in Arms())
    if (Active(arm)) return true;
  return false;
}

NSArray<NSURL *> *ArmedPanelPicks(NSSavePanel *panel, NSWindow *parent, bool *handled, NSString **armId) {
  *handled = false;
  Sweep();
  const bool open = [panel isKindOfClass:NSOpenPanel.class];
  ArdiaFileArm *arm = ArmFor(open ? @"upload" : @"download", parent);
  if (!arm) return nil;
  *handled = true;
  *armId = arm.armId;
  return open ? UploadPicks(arm, (NSOpenPanel *)panel) : DownloadPicks(arm, panel);
}

}

using namespace ardia_host;

@implementation ArdiaHost (FileArms)

+ (NSDictionary<NSString *, id> *)armFiles:(NSDictionary<NSString *, id> *)spec {
  Sweep();
  NSString *armId = spec[@"id"];
  NSString *kind = spec[@"kind"];
  id tab = spec[@"tab"];
  NSArray *paths = spec[@"paths"];
  NSNumber *once = spec[@"once"];
  NSNumber *seconds = spec[@"seconds"];
  if (![armId isKindOfClass:NSString.class] || !armId.length || [armId lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > kMaxIdBytes || ArmNamed(armId))
    return Refused(@"badId", nil);
  if (![kind isEqualToString:@"upload"] && ![kind isEqualToString:@"download"]) return Refused(@"badKind", nil);
  if (tab && tab != NSNull.null && (![tab isKindOfClass:NSString.class] || !TabWithAppTabId(tab))) return Refused(@"noTab", nil);
  if ([kind isEqualToString:@"upload"] && (!tab || tab == NSNull.null)) return Refused(@"noTab", nil);
  if (![paths isKindOfClass:NSArray.class] || !paths.count || paths.count > kMaxUploadPaths) return Refused(@"badPaths", nil);
  if ([kind isEqualToString:@"download"] && paths.count != 1) return Refused(@"badPaths", nil);
  const NSTimeInterval ttl = [seconds isKindOfClass:NSNumber.class] ? MIN(MAX(seconds.doubleValue, 1), kMaxSeconds) : 120;
  NSUInteger active = 0;
  for (ArdiaFileArm *arm in Arms()) active += Active(arm) ? 1 : 0;
  if (active >= kMaxActiveArms) return Refused(@"tooMany", nil);
  NSMutableArray<NSString *> *resolved = [NSMutableArray array];
  BOOL folder = NO;
  for (id path in paths) {
    NSString *reason = nil;
    NSString *canonical = [kind isEqualToString:@"upload"] ? ardia_files::ChosenPath(path, &reason) : ardia_files::DownloadTarget(path, &folder, &reason);
    if (!canonical) return Refused(reason ?: @"badPath", [path isKindOfClass:NSString.class] ? path : nil);
    [resolved addObject:canonical];
  }
  const BOOL onlyOnce = ![once isKindOfClass:NSNumber.class] || once.boolValue;
  if ([kind isEqualToString:@"download"] && !folder && !onlyOnce) return Refused(@"onceForFile", nil);
  ArdiaFileArm *arm = [ArdiaFileArm new];
  arm.armId = armId;
  arm.kind = kind;
  arm.tabId = tab == NSNull.null ? nil : tab;
  arm.paths = resolved;
  arm.folder = folder;
  arm.once = onlyOnce;
  arm.armedAt = Now();
  arm.expiresAt = arm.armedAt + ttl;
  arm.state = @"armed";
  arm.landed = @[];
  [Arms() addObject:arm];
  return @{@"ok" : @YES, @"arm" : Row(arm)};
}

+ (NSInteger)disarmFiles:(NSArray<NSString *> *)ids {
  Sweep();
  NSInteger cleared = 0;
  for (ArdiaFileArm *arm in Arms()) {
    if (!Active(arm) || (ids && ![ids containsObject:arm.armId])) continue;
    End(arm, @"cleared", nil);
    cleared += 1;
  }
  return cleared;
}

+ (NSArray<NSDictionary<NSString *, id> *> *)fileArms {
  Sweep();
  NSMutableArray *rows = [NSMutableArray array];
  for (ArdiaFileArm *arm in Arms()) [rows addObject:Row(arm)];
  return rows;
}

+ (NSDictionary<NSString *, id> *)placeArmedDownload:(NSString *)armId from:(NSString *)path {
  Sweep();
  ArdiaFileArm *arm = ArmNamed(armId);
  if (!arm || ![arm.kind isEqualToString:@"download"]) return Refused(@"noArm", nil);
  if ([arm.landed containsObject:path]) return ardia_files::PlaceFile(path, path);
  if (!Active(arm)) return Refused(arm.reason ?: arm.state, nil);
  NSString *reason = nil;
  NSString *target = arm.folder ? ardia_files::FreePathIn(arm.paths.firstObject, path.lastPathComponent, &reason) : arm.paths.firstObject;
  if (!target) {
    End(arm, @"failed", reason);
    return Refused(reason, nil);
  }
  NSDictionary *placed = ardia_files::PlaceFile(path, target);
  if (![placed[@"ok"] boolValue]) {
    End(arm, @"failed", placed[@"reason"]);
    return placed;
  }
  arm.landed = [arm.landed arrayByAddingObject:target];
  Spend(arm);
  return placed;
}

@end
