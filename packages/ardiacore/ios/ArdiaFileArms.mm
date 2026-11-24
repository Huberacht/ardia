#import "ArdiaHost.h"
#import "ArdiaFilePaths.h"
#import "ArdiaInternal.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaWindowController.h"

#include <os/lock.h>
#include <sys/stat.h>
#include <unistd.h>

#include <vector>

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaFileArm : NSObject
@property(nonatomic, copy) NSString *armId;
@property(nonatomic, copy) NSString *kind;
@property(nonatomic, copy, nullable) NSString *tabId;
@property(nonatomic, copy, nullable) NSString *windowId;
@property(nonatomic, copy) NSArray<NSString *> *paths;
@property(nonatomic, copy) NSArray<NSString *> *staged;
@property(nonatomic, copy, nullable) NSString *uploadFolder;
@property(nonatomic) BOOL folder;
@property(nonatomic) BOOL once;
@property(nonatomic) NSTimeInterval armedAt;
@property(nonatomic) NSTimeInterval expiresAt;
@property(nonatomic, copy) NSString *state;
@property(nonatomic, copy, nullable) NSString *reason;
@property(nonatomic, copy) NSArray<NSString *> *landed;
@property(nonatomic, strong) NSMutableArray<NSString *> *stagingFolders;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *claims;
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
constexpr int kPlaceTries = 8;

os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;

template <typename Work>
auto Locked(Work work) -> decltype(work()) {
  os_unfair_lock_lock(&gLock);
  struct Unlock {
    ~Unlock() { os_unfair_lock_unlock(&gLock); }
  } unlock;
  return work();
}

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

NSString *UploadRoot() {
  NSString *data = ArdiaLaunchConfig.shared.dataDirectory;
  return data.length ? [data stringByAppendingPathComponent:@"file-arms"] : nil;
}

void Purge(NSString *folder) {
  if (folder.length) [NSFileManager.defaultManager removeItemAtPath:folder error:nil];
}

void End(ArdiaFileArm *arm, NSString *state, NSString *_Nullable reason, NSMutableArray<NSString *> *purge) {
  const bool unused = Active(arm);
  arm.state = state;
  arm.reason = reason;
  arm.expiresAt = Now();
  if (unused && arm.uploadFolder) {
    [purge addObject:arm.uploadFolder];
    arm.uploadFolder = nil;
  }
}

NSMutableArray<NSString *> *SweepLocked() {
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  const NSTimeInterval now = Now();
  NSMutableArray<ArdiaFileArm *> *arms = Arms();
  for (ArdiaFileArm *arm in arms)
    if (Active(arm) && now >= arm.expiresAt) End(arm, @"expired", nil, purge);
  NSIndexSet *old = [arms indexesOfObjectsPassingTest:^BOOL(ArdiaFileArm *arm, NSUInteger, BOOL *) {
    return !Active(arm) && !arm.uploadFolder && !arm.claims.count && now - arm.expiresAt > kKeepEndedSeconds;
  }];
  [arms removeObjectsAtIndexes:old];
  while (arms.count > kMaxKeptArms) {
    NSUInteger oldest = [arms indexOfObjectPassingTest:^BOOL(ArdiaFileArm *arm, NSUInteger, BOOL *) { return !Active(arm) && !arm.uploadFolder; }];
    if (oldest == NSNotFound) break;
    [arms removeObjectAtIndex:oldest];
  }
  return purge;
}

void PurgeAll(NSArray<NSString *> *folders) {
  for (NSString *folder in folders) Purge(folder);
}

ArdiaFileArm *_Nullable ArmNamed(NSString *armId) {
  for (ArdiaFileArm *arm in Arms())
    if ([arm.armId isEqualToString:armId]) return arm;
  return nil;
}

NSDictionary *Refused(NSString *reason, NSString *_Nullable path) {
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

ArdiaWindowController *_Nullable ControllerOf(NSWindow *_Nullable parent) {
  NSWindow *w = parent;
  for (int depth = 0; w && depth < 8; depth++, w = w.sheetParent ?: w.parentWindow) {
    ArdiaWindowController *c = [ArdiaWindowController forNSWindow:w];
    if (c) return c;
  }
  return nil;
}

bool RegularWindow(ArdiaWindowController *_Nullable c) {
  if (!c || c.stray || c.standalone || !c.appWindowId.length) return false;
  ArdiaCoreProfile *profile = c.coreWindow.activeProfile;
  return profile && !profile.offTheRecord;
}

struct Candidate {
  NSString *armId;
  NSString *_Nullable tabId;
  NSTimeInterval armedAt;
};

std::vector<Candidate> CandidatesLocked(NSString *kind) {
  std::vector<Candidate> found;
  for (ArdiaFileArm *arm in Arms())
    if (Active(arm) && [arm.kind isEqualToString:kind]) found.push_back({arm.armId, arm.tabId, arm.armedAt});
  return found;
}

NSString *_Nullable PickArm(NSString *kind, NSWindow *_Nullable parent) {
  std::vector<Candidate> candidates = Locked([&] { return CandidatesLocked(kind); });
  if (candidates.empty()) return nil;
  ArdiaWindowController *panelWindow = ControllerOf(parent);
  if (!RegularWindow(panelWindow)) return nil;
  NSString *pick = nil;
  int pickRank = 0;
  NSTimeInterval pickAt = 0;
  for (const Candidate &candidate : candidates) {
    int rank = 1;
    if (candidate.tabId) {
      ArdiaCoreTab *tab = TabWithAppTabId(candidate.tabId);
      if (!tab || tab.profile.offTheRecord || [ArdiaWindowController holding:tab] != panelWindow) continue;
      rank = 2;
    }
    if (rank > pickRank || (rank == pickRank && candidate.armedAt >= pickAt)) {
      pick = candidate.armId;
      pickRank = rank;
      pickAt = candidate.armedAt;
    }
  }
  return pick;
}

NSArray<NSURL *> *_Nullable UploadPicks(NSString *armId, NSOpenPanel *panel) {
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  NSArray<NSURL *> *urls = Locked([&]() -> NSArray<NSURL *> * {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm || !Active(arm)) return nil;
    if (arm.staged.count > 1 && !panel.allowsMultipleSelection) {
      End(arm, @"failed", @"oneFileOnly", purge);
      return nil;
    }
    if (!panel.canChooseFiles) {
      End(arm, @"failed", @"wantsFolder", purge);
      return nil;
    }
    NSMutableArray<NSURL *> *picked = [NSMutableArray array];
    for (NSString *path in arm.staged) [picked addObject:[NSURL fileURLWithPath:path isDirectory:NO]];
    arm.landed = arm.paths;
    arm.answered += 1;
    if (arm.once) {
      arm.state = @"answered";
      arm.expiresAt = Now();
    }
    return picked;
  });
  PurgeAll(purge);
  return urls;
}

NSArray<NSURL *> *_Nullable DownloadPicks(NSString *armId, NSSavePanel *panel) {
  NSString *folder = nil;
  NSString *name = nil;
  bool consumed = Locked([&] {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm || !Active(arm)) return false;
    folder = arm.folder ? arm.paths.firstObject : arm.paths.firstObject.stringByDeletingLastPathComponent;
    name = arm.folder ? nil : arm.paths.firstObject.lastPathComponent;
    arm.answered += 1;
    if (arm.once) {
      arm.state = @"answered";
      arm.expiresAt = Now();
    }
    return true;
  });
  if (!consumed) return nil;
  NSString *reason = nil;
  NSString *staging = ardia_files::MakeStagingFolder(folder, armId, &reason);
  NSString *stagedName = name ?: ardia_files::SafeFileName(panel.nameFieldStringValue);
  Locked([&] {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm) return;
    if (staging) [arm.stagingFolders addObject:staging];
    else {
      arm.state = @"failed";
      arm.reason = reason ?: @"stagingFailed";
    }
  });
  if (!staging) return nil;
  return @[ [NSURL fileURLWithPath:[staging stringByAppendingPathComponent:stagedName] isDirectory:NO] ];
}

bool InStagingLocked(ArdiaFileArm *arm, NSString *path) {
  NSString *parent = path.stringByDeletingLastPathComponent;
  return [arm.stagingFolders containsObject:parent];
}

void SweepUploadRootOnce() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Purge(UploadRoot());
  });
}

}

bool HasArmedPanels() {
  return Locked([] {
    for (ArdiaFileArm *arm in Arms())
      if (Active(arm)) return true;
    return false;
  });
}

NSArray<NSURL *> *ArmedPanelPicks(NSSavePanel *panel, NSWindow *parent, bool *handled, NSString **armId) {
  *handled = false;
  PurgeAll(Locked([] { return SweepLocked(); }));
  const bool open = [panel isKindOfClass:NSOpenPanel.class];
  NSString *pick = PickArm(open ? @"upload" : @"download", parent);
  if (!pick) return nil;
  *handled = true;
  *armId = pick;
  return open ? UploadPicks(pick, (NSOpenPanel *)panel) : DownloadPicks(pick, panel);
}

}

using namespace ardia_host;

@implementation ArdiaHost (FileArms)

+ (void)armFiles:(NSDictionary<NSString *, id> *)spec completion:(void (^)(NSDictionary<NSString *, id> *result))completion {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    completion([self armFilesNow:spec]);
  });
}

+ (NSDictionary<NSString *, id> *)armFilesNow:(NSDictionary<NSString *, id> *)spec {
  SweepUploadRootOnce();
  NSString *armId = spec[@"id"];
  NSString *kind = spec[@"kind"];
  id tab = spec[@"tab"];
  id window = spec[@"window"];
  NSArray *paths = spec[@"paths"];
  NSNumber *once = spec[@"once"];
  NSNumber *seconds = spec[@"seconds"];
  if (![armId isKindOfClass:NSString.class] || !armId.length || [armId lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > kMaxIdBytes ||
      [armId rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"abcdef0123456789-"].invertedSet].location != NSNotFound)
    return Refused(@"badId", nil);
  if (![kind isEqualToString:@"upload"] && ![kind isEqualToString:@"download"]) return Refused(@"badKind", nil);
  const bool upload = [kind isEqualToString:@"upload"];
  NSString *tabId = [tab isKindOfClass:NSString.class] ? tab : nil;
  NSString *windowId = [window isKindOfClass:NSString.class] ? window : nil;
  if (upload && (!tabId || !windowId)) return Refused(@"noTab", nil);
  if (![paths isKindOfClass:NSArray.class] || !paths.count || paths.count > kMaxUploadPaths) return Refused(@"badPaths", nil);
  if (!upload && paths.count != 1) return Refused(@"badPaths", nil);
  const NSTimeInterval ttl = [seconds isKindOfClass:NSNumber.class] ? MIN(MAX(seconds.doubleValue, 1), kMaxSeconds) : 120;
  const BOOL onlyOnce = ![once isKindOfClass:NSNumber.class] || once.boolValue;
  NSMutableArray<NSString *> *resolved = [NSMutableArray array];
  BOOL folder = NO;
  for (id path in paths) {
    NSString *reason = nil;
    NSString *canonical = upload ? ardia_files::ChosenPath(path, &reason) : ardia_files::DownloadTarget(path, &folder, &reason);
    if (!canonical) return Refused(reason ?: @"badPath", [path isKindOfClass:NSString.class] ? path : nil);
    [resolved addObject:canonical];
  }
  if (!upload && !folder && !onlyOnce) return Refused(@"onceForFile", nil);
  NSString *uploadFolder = nil;
  NSMutableArray<NSString *> *staged = [NSMutableArray array];
  if (upload) {
    NSString *root = UploadRoot();
    if (!root || (mkdir(root.fileSystemRepresentation, 0700) != 0 && errno != EEXIST)) return Refused(@"stagingFailed", nil);
    uploadFolder = [root stringByAppendingPathComponent:armId];
    if (mkdir(uploadFolder.fileSystemRepresentation, 0700) != 0) return Refused(@"badId", nil);
    for (NSUInteger i = 0; i < resolved.count; i++) {
      NSString *reason = nil;
      NSString *copy = ardia_files::StageUpload(resolved[i], [uploadFolder stringByAppendingPathComponent:[NSString stringWithFormat:@"%lu", (unsigned long)i]], &reason);
      if (!copy) {
        Purge(uploadFolder);
        return Refused(reason ?: @"stagingFailed", resolved[i]);
      }
      [staged addObject:copy];
    }
  }
  NSString *busyWith = nil;
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  NSDictionary *result = Locked([&]() -> NSDictionary * {
    [purge addObjectsFromArray:SweepLocked()];
    if (ArmNamed(armId)) return Refused(@"badId", nil);
    NSUInteger active = 0;
    for (ArdiaFileArm *arm in Arms()) {
      if (!Active(arm)) continue;
      active += 1;
      if (upload && [arm.kind isEqualToString:@"upload"] && [arm.windowId isEqualToString:windowId]) busyWith = arm.armId;
    }
    if (busyWith) return @{@"ok" : @NO, @"reason" : @"windowBusy", @"arm" : busyWith};
    if (active >= kMaxActiveArms) return Refused(@"tooMany", nil);
    ArdiaFileArm *arm = [ArdiaFileArm new];
    arm.armId = armId;
    arm.kind = kind;
    arm.tabId = tabId;
    arm.windowId = windowId;
    arm.paths = resolved;
    arm.staged = staged;
    arm.uploadFolder = uploadFolder;
    arm.folder = folder;
    arm.once = onlyOnce;
    arm.armedAt = Now();
    arm.expiresAt = arm.armedAt + ttl;
    arm.state = @"armed";
    arm.landed = @[];
    arm.stagingFolders = [NSMutableArray array];
    arm.claims = [NSMutableDictionary dictionary];
    [Arms() addObject:arm];
    return @{@"ok" : @YES, @"arm" : Row(arm)};
  });
  if (![result[@"ok"] boolValue] && uploadFolder) [purge addObject:uploadFolder];
  PurgeAll(purge);
  return result;
}

+ (NSInteger)disarmFiles:(NSArray<NSString *> *)ids purge:(BOOL)purgeCopies {
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  NSMutableArray<NSString *> *emptyStaging = [NSMutableArray array];
  NSInteger cleared = Locked([&] {
    [purge addObjectsFromArray:SweepLocked()];
    NSInteger count = 0;
    for (ArdiaFileArm *arm in Arms()) {
      if (ids && ![ids containsObject:arm.armId]) continue;
      if (Active(arm)) {
        End(arm, @"cleared", nil, purge);
        count += 1;
      }
      if (purgeCopies && arm.uploadFolder) {
        [purge addObject:arm.uploadFolder];
        arm.uploadFolder = nil;
      }
      if (purgeCopies && !arm.claims.count) [emptyStaging addObjectsFromArray:arm.stagingFolders];
    }
    return count;
  });
  PurgeAll(purge);
  for (NSString *folder in emptyStaging) rmdir(folder.fileSystemRepresentation);
  return cleared;
}

+ (NSArray<NSDictionary<NSString *, id> *> *)fileArms {
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  NSArray *rows = Locked([&] {
    [purge addObjectsFromArray:SweepLocked()];
    NSMutableArray *list = [NSMutableArray array];
    for (ArdiaFileArm *arm in Arms()) [list addObject:Row(arm)];
    return list;
  });
  PurgeAll(purge);
  return rows;
}

+ (NSDictionary<NSString *, id> *)claimArmedDownload:(NSString *)armId download:(NSString *)downloadId path:(NSString *)path {
  if (!downloadId.length || !path.length) return Refused(@"noPath", nil);
  NSMutableArray<NSString *> *purge = [NSMutableArray array];
  NSDictionary *result = Locked([&]() -> NSDictionary * {
    [purge addObjectsFromArray:SweepLocked()];
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm || ![arm.kind isEqualToString:@"download"]) return Refused(@"noArm", nil);
    if (arm.claims[downloadId]) return @{@"ok" : @YES, @"mode" : InStagingLocked(arm, arm.claims[downloadId]) ? @"prompted" : @"automatic"};
    if (InStagingLocked(arm, path)) {
      arm.claims[downloadId] = path;
      return @{@"ok" : @YES, @"mode" : @"prompted"};
    }
    if (!Active(arm)) return Refused(@"taken", nil);
    arm.claims[downloadId] = path;
    arm.answered += 1;
    if (arm.once) {
      arm.state = @"claimed";
      arm.expiresAt = Now();
    }
    return @{@"ok" : @YES, @"mode" : @"automatic"};
  });
  PurgeAll(purge);
  return result;
}

+ (void)placeArmedDownload:(NSString *)armId download:(NSString *)downloadId path:(NSString *)path completion:(void (^)(NSDictionary<NSString *, id> *result))completion {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    completion([self placeArmedDownloadNow:armId download:downloadId path:path]);
  });
}

+ (NSDictionary<NSString *, id> *)placeArmedDownloadNow:(NSString *)armId download:(NSString *)downloadId path:(NSString *)path {
  NSString *claimed = nil;
  NSString *destination = nil;
  BOOL folder = NO;
  BOOL prompted = NO;
  Locked([&] {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm || ![arm.kind isEqualToString:@"download"]) return;
    claimed = arm.claims[downloadId];
    destination = arm.paths.firstObject;
    folder = arm.folder;
    prompted = claimed && InStagingLocked(arm, path);
  });
  if (!claimed) return Refused(@"notClaimed", nil);
  if (![claimed isEqualToString:path] && !prompted && ![claimed.stringByDeletingLastPathComponent isEqualToString:path.stringByDeletingLastPathComponent])
    return Refused(@"notClaimed", nil);
  NSDictionary *placed = nil;
  for (int attempt = 0; attempt < kPlaceTries; attempt++) {
    NSString *reason = nil;
    NSString *target = folder ? ardia_files::FreePathIn(destination, path.lastPathComponent, &reason) : destination;
    if (!target) {
      placed = Refused(reason ?: @"noFreeName", nil);
      break;
    }
    placed = ardia_files::PlaceFile(path, target);
    if ([placed[@"ok"] boolValue] || !folder || ![placed[@"reason"] isEqualToString:@"exists"]) break;
  }
  const bool ok = [placed[@"ok"] boolValue];
  NSMutableDictionary *answer = [placed mutableCopy];
  if (!ok && prompted) answer[@"stagedPath"] = path;
  Locked([&] {
    ArdiaFileArm *arm = ArmNamed(armId);
    if (!arm) return;
    if (ok) arm.landed = [arm.landed arrayByAddingObject:placed[@"path"]];
    else {
      arm.state = @"failed";
      arm.reason = placed[@"reason"];
    }
    [arm.claims removeObjectForKey:downloadId];
    if (ok && prompted) [arm.stagingFolders removeObject:path.stringByDeletingLastPathComponent];
  });
  if (ok && prompted) rmdir(path.stringByDeletingLastPathComponent.fileSystemRepresentation);
  return answer;
}

@end
