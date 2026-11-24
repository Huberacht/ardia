#import "../ios/ArdiaFilePaths.h"

#include <cstdio>
#include <cstdlib>
#include <sys/stat.h>
#include <unistd.h>

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

using namespace ardia_files;

static NSString *gRoot;

static NSString *At(NSString *relative) {
  return [gRoot stringByAppendingPathComponent:relative];
}

static NSString *Make(NSString *relative, NSString *text) {
  NSString *path = At(relative);
  [NSFileManager.defaultManager createDirectoryAtPath:path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
  [text writeToFile:path atomically:NO encoding:NSUTF8StringEncoding error:nil];
  return path;
}

static BOOL Exists(NSString *path) {
  struct stat info;
  return lstat(path.fileSystemRepresentation, &info) == 0;
}

static NSString *Text(NSString *path) {
  return [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
}

static void TestChosenPath() {
  NSString *reason = nil;
  NSString *file = Make(@"up/report.pdf", @"pdf");
  CHECK([ChosenPath(file, &reason) isEqualToString:file]);
  CHECK([ChosenPath(At(@"up"), &reason) isEqualToString:At(@"up")]);
  symlink(file.fileSystemRepresentation, At(@"up/link.pdf").fileSystemRepresentation);
  CHECK([ChosenPath(At(@"up/link.pdf"), &reason) isEqualToString:file]);
  for (id bad : @[ @"", @"relative/path", @"/a/../etc/passwd", @"/a/./b", @"/a\nb", [NSString stringWithFormat:@"/a%C", (unichar)0], @42, NSNull.null ]) {
    reason = nil;
    CHECK(ChosenPath(bad, &reason) == nil);
    CHECK(reason.length > 0);
  }
  NSMutableString *longPath = [NSMutableString stringWithString:@"/"];
  while (longPath.length <= kMaxPathBytes) [longPath appendString:@"aaaaaaaaaa/"];
  reason = nil;
  CHECK(ChosenPath(longPath, &reason) == nil && [reason isEqualToString:@"tooLong"]);
  reason = nil;
  CHECK(ChosenPath(At(@"up/missing.pdf"), &reason) == nil && [reason isEqualToString:@"missing"]);
  NSString *locked = Make(@"up/locked.txt", @"x");
  chmod(locked.fileSystemRepresentation, 0000);
  reason = nil;
  if (geteuid() != 0) CHECK(ChosenPath(locked, &reason) == nil && [reason isEqualToString:@"unreadable"]);
  chmod(locked.fileSystemRepresentation, 0600);
  mkfifo(At(@"up/fifo").fileSystemRepresentation, 0600);
  reason = nil;
  CHECK(ChosenPath(At(@"up/fifo"), &reason) == nil && [reason isEqualToString:@"notAFile"]);
}

static void TestDownloadTarget() {
  NSString *reason = nil;
  BOOL folder = YES;
  [NSFileManager.defaultManager createDirectoryAtPath:At(@"down") withIntermediateDirectories:YES attributes:nil error:nil];
  CHECK([DownloadTarget(At(@"down/new.zip"), &folder, &reason) isEqualToString:At(@"down/new.zip")] && !folder);
  CHECK([DownloadTarget(At(@"down"), &folder, &reason) isEqualToString:At(@"down")] && folder);
  CHECK([DownloadTarget([At(@"down") stringByAppendingString:@"/"], &folder, &reason) isEqualToString:At(@"down")] && folder);
  Make(@"down/taken.zip", @"x");
  reason = nil;
  CHECK(DownloadTarget(At(@"down/taken.zip"), &folder, &reason) == nil && [reason isEqualToString:@"exists"]);
  symlink(At(@"down/taken.zip").fileSystemRepresentation, At(@"down/alias.zip").fileSystemRepresentation);
  reason = nil;
  CHECK(DownloadTarget(At(@"down/alias.zip"), &folder, &reason) == nil && [reason isEqualToString:@"symlink"]);
  symlink(At(@"down").fileSystemRepresentation, At(@"downlink").fileSystemRepresentation);
  reason = nil;
  CHECK(DownloadTarget(At(@"downlink"), &folder, &reason) == nil && [reason isEqualToString:@"symlink"]);
  symlink("/nowhere/at/all", At(@"down/dangling").fileSystemRepresentation);
  reason = nil;
  CHECK(DownloadTarget(At(@"down/dangling"), &folder, &reason) == nil && [reason isEqualToString:@"symlink"]);
  CHECK([DownloadTarget(At(@"downlink/via.zip"), &folder, &reason) isEqualToString:At(@"down/via.zip")]);
  reason = nil;
  CHECK(DownloadTarget(At(@"nofolder/x.zip"), &folder, &reason) == nil && [reason isEqualToString:@"folderMissing"]);
  reason = nil;
  CHECK(DownloadTarget(At(@"down/taken.zip/inner"), &folder, &reason) == nil && [reason isEqualToString:@"notAFolder"]);
  reason = nil;
  CHECK(DownloadTarget(At(@"down/../escape.zip"), &folder, &reason) == nil && [reason isEqualToString:@"traversal"]);
  NSMutableString *longName = [NSMutableString string];
  while (longName.length <= kMaxNameBytes) [longName appendString:@"n"];
  reason = nil;
  CHECK(DownloadTarget([At(@"down") stringByAppendingPathComponent:longName], &folder, &reason) == nil && [reason isEqualToString:@"badName"]);
}

static void TestFreePathIn() {
  NSString *reason = nil;
  NSString *folder = At(@"free");
  [NSFileManager.defaultManager createDirectoryAtPath:folder withIntermediateDirectories:YES attributes:nil error:nil];
  CHECK([FreePathIn(folder, @"a.txt", &reason) isEqualToString:At(@"free/a.txt")]);
  Make(@"free/a.txt", @"x");
  CHECK([FreePathIn(folder, @"a.txt", &reason) isEqualToString:At(@"free/a (1).txt")]);
  CHECK([FreePathIn(folder, @"../../etc/passwd", &reason) isEqualToString:At(@"free/.._.._etc_passwd")] ||
        [FreePathIn(folder, @"../../etc/passwd", &reason) isEqualToString:At(@"free/_.._etc_passwd")]);
  CHECK([FreePathIn(folder, @"", &reason) isEqualToString:At(@"free/download")]);
  CHECK([FreePathIn(folder, @"..", &reason) isEqualToString:At(@"free/download")]);
  CHECK([FreePathIn(folder, @".hidden", &reason) isEqualToString:At(@"free/hidden")]);
  NSString *made = FreePathIn(folder, @"a:b/c\nd", &reason);
  CHECK(made && [made.stringByDeletingLastPathComponent isEqualToString:folder]);
}

static void TestPlaceFile() {
  [NSFileManager.defaultManager createDirectoryAtPath:At(@"place") withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *source = Make(@"staging/file.bin", @"payload");
  NSDictionary *placed = PlaceFile(source, At(@"place/file.bin"));
  CHECK([placed[@"ok"] boolValue]);
  CHECK([placed[@"bytes"] intValue] == 7);
  CHECK(!Exists(source));
  CHECK([Text(At(@"place/file.bin")) isEqualToString:@"payload"]);
  NSString *second = Make(@"staging/second.bin", @"other");
  placed = PlaceFile(second, At(@"place/file.bin"));
  CHECK(![placed[@"ok"] boolValue] && [placed[@"reason"] isEqualToString:@"exists"]);
  CHECK([Text(At(@"place/file.bin")) isEqualToString:@"payload"]);
  CHECK(Exists(second));
  symlink("/etc/hosts", At(@"place/trap").fileSystemRepresentation);
  placed = PlaceFile(second, At(@"place/trap"));
  CHECK(![placed[@"ok"] boolValue]);
  CHECK(Exists(second));
  placed = PlaceFile(At(@"staging/none.bin"), At(@"place/none.bin"));
  CHECK(![placed[@"ok"] boolValue] && [placed[@"reason"] isEqualToString:@"sourceMissing"]);
  placed = PlaceFile(At(@"place/file.bin"), At(@"place/file.bin"));
  CHECK([placed[@"ok"] boolValue]);
  symlink(At(@"place").fileSystemRepresentation, At(@"placelink").fileSystemRepresentation);
  placed = PlaceFile(second, At(@"placelink/through.bin"));
  CHECK(![placed[@"ok"] boolValue] && [placed[@"reason"] isEqualToString:@"folderChanged"]);
  CHECK(Exists(second));
  placed = PlaceFile(second, At(@"place/.."));
  CHECK(![placed[@"ok"] boolValue]);
}

int main() {
  @autoreleasepool {
    char base[] = "/tmp/ardia-file-paths-XXXXXX";
    char *made = mkdtemp(base);
    char resolved[PATH_MAX];
    realpath(made, resolved);
    gRoot = @(resolved);
    TestChosenPath();
    TestDownloadTarget();
    TestFreePathIn();
    TestPlaceFile();
    [NSFileManager.defaultManager removeItemAtPath:gRoot error:nil];
    if (failures) return 1;
    std::printf("file-paths: ok\n");
  }
  return 0;
}
