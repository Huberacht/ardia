#import "ArdiaFilePaths.h"

#include <copyfile.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <unistd.h>

namespace ardia_files {

namespace {

class ScopedFd {
 public:
  explicit ScopedFd(int fd = -1) : fd_(fd) {}
  ~ScopedFd() {
    if (fd_ >= 0) close(fd_);
  }
  ScopedFd(const ScopedFd &) = delete;
  ScopedFd &operator=(const ScopedFd &) = delete;
  int get() const { return fd_; }
  bool valid() const { return fd_ >= 0; }

 private:
  int fd_;
};

NSDictionary *Failure(NSString *reason) {
  return @{@"ok" : @NO, @"reason" : reason};
}

NSUInteger Bytes(NSString *text) {
  return [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
}

NSString *WellFormed(id value, NSString **reason) {
  if (![value isKindOfClass:NSString.class] || ![(NSString *)value length]) {
    *reason = @"notAbsolute";
    return nil;
  }
  NSString *path = value;
  if ([path rangeOfString:@"\0"].location != NSNotFound || [path rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location != NSNotFound) {
    *reason = @"badCharacters";
    return nil;
  }
  if (![path hasPrefix:@"/"]) {
    *reason = @"notAbsolute";
    return nil;
  }
  if (Bytes(path) > kMaxPathBytes || !path.fileSystemRepresentation) {
    *reason = @"tooLong";
    return nil;
  }
  for (NSString *part in [path componentsSeparatedByString:@"/"])
    if ([part isEqualToString:@"."] || [part isEqualToString:@".."]) {
      *reason = @"traversal";
      return nil;
    }
  while (path.length > 1 && [path hasSuffix:@"/"]) path = [path substringToIndex:path.length - 1];
  return path;
}

NSString *Resolved(NSString *path) {
  char resolved[PATH_MAX];
  if (!realpath(path.fileSystemRepresentation, resolved)) return nil;
  return [NSFileManager.defaultManager stringWithFileSystemRepresentation:resolved length:strlen(resolved)];
}

bool ValidName(NSString *name) {
  return name.length && Bytes(name) <= kMaxNameBytes && ![name isEqualToString:@"."] && ![name isEqualToString:@".."] &&
         [name rangeOfString:@"/"].location == NSNotFound && [name rangeOfString:@"\0"].location == NSNotFound;
}

NSString *SafeName(NSString *name) {
  NSString *base = [name isKindOfClass:NSString.class] ? name : @"";
  base = [base stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  base = [base stringByReplacingOccurrencesOfString:@":" withString:@"_"];
  base = [base stringByReplacingOccurrencesOfString:@"\0" withString:@""];
  base = [[base componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet] componentsJoinedByString:@" "];
  base = [base stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  while ([base hasPrefix:@"."]) base = [base substringFromIndex:1];
  if (!base.length) base = @"download";
  while (Bytes(base) > kMaxNameBytes) base = [base substringToIndex:base.length - 1];
  return base;
}

NSString *Numbered(NSString *name, int n) {
  NSString *ext = name.pathExtension;
  NSString *stem = name.stringByDeletingPathExtension;
  if (!stem.length) {
    stem = name;
    ext = @"";
  }
  NSString *tail = ext.length ? [NSString stringWithFormat:@" (%d).%@", n, ext] : [NSString stringWithFormat:@" (%d)", n];
  while (stem.length > 1 && Bytes(stem) + Bytes(tail) > kMaxNameBytes) stem = [stem substringToIndex:stem.length - 1];
  return [stem stringByAppendingString:tail];
}

bool Missing(NSString *path) {
  struct stat info;
  return lstat(path.fileSystemRepresentation, &info) != 0 && errno == ENOENT;
}

}

NSString *ChosenPath(id value, NSString **reason) {
  NSString *path = WellFormed(value, reason);
  if (!path) return nil;
  NSString *canonical = Resolved(path);
  if (!canonical) {
    *reason = errno == ENOENT || errno == ENOTDIR ? @"missing" : @"unreadable";
    return nil;
  }
  struct stat info;
  if (lstat(canonical.fileSystemRepresentation, &info) != 0) {
    *reason = @"missing";
    return nil;
  }
  if (!S_ISREG(info.st_mode) && !S_ISDIR(info.st_mode)) {
    *reason = @"notAFile";
    return nil;
  }
  if (access(canonical.fileSystemRepresentation, S_ISDIR(info.st_mode) ? (R_OK | X_OK) : R_OK) != 0) {
    *reason = @"unreadable";
    return nil;
  }
  return canonical;
}

NSString *DownloadTarget(id value, BOOL *folder, NSString **reason) {
  *folder = NO;
  NSString *path = WellFormed(value, reason);
  if (!path) return nil;
  NSString *name = path.lastPathComponent;
  if (!ValidName(name)) {
    *reason = @"badName";
    return nil;
  }
  struct stat info;
  if (lstat(path.fileSystemRepresentation, &info) == 0) {
    if (S_ISLNK(info.st_mode)) {
      *reason = @"symlink";
      return nil;
    }
    if (!S_ISDIR(info.st_mode)) {
      *reason = @"exists";
      return nil;
    }
    NSString *canonical = Resolved(path);
    if (!canonical || access(canonical.fileSystemRepresentation, W_OK | X_OK) != 0) {
      *reason = @"folderNotWritable";
      return nil;
    }
    *folder = YES;
    return canonical;
  }
  if (errno != ENOENT) {
    *reason = errno == ENOTDIR ? @"notAFolder" : @"unreadable";
    return nil;
  }
  NSString *parent = Resolved(path.stringByDeletingLastPathComponent);
  if (!parent) {
    *reason = @"folderMissing";
    return nil;
  }
  if (stat(parent.fileSystemRepresentation, &info) != 0 || !S_ISDIR(info.st_mode)) {
    *reason = @"notAFolder";
    return nil;
  }
  if (access(parent.fileSystemRepresentation, W_OK | X_OK) != 0) {
    *reason = @"folderNotWritable";
    return nil;
  }
  NSString *target = [parent stringByAppendingPathComponent:name];
  if (!Missing(target)) {
    *reason = @"exists";
    return nil;
  }
  return target;
}

NSString *FreePathIn(NSString *folder, NSString *name, NSString **reason) {
  NSString *safe = SafeName(name ?: @"");
  NSString *candidate = [folder stringByAppendingPathComponent:safe];
  for (int n = 1; n < 100 && !Missing(candidate); n++) candidate = [folder stringByAppendingPathComponent:Numbered(safe, n)];
  if (!Missing(candidate)) {
    *reason = @"noFreeName";
    return nil;
  }
  return candidate;
}

bool StillFree(NSString *target, NSString **reason) {
  NSString *parent = target.stringByDeletingLastPathComponent;
  NSString *resolved = Resolved(parent);
  if (!resolved || ![resolved isEqualToString:parent]) {
    *reason = @"folderChanged";
    return false;
  }
  if (!Missing(target)) {
    *reason = @"exists";
    return false;
  }
  return true;
}

NSDictionary<NSString *, id> *PlaceFile(NSString *source, NSString *target) {
  if (![source isKindOfClass:NSString.class] || ![target isKindOfClass:NSString.class] || !source.length || !target.length) return Failure(@"sourceMissing");
  struct stat info;
  if (lstat(source.fileSystemRepresentation, &info) != 0 || !S_ISREG(info.st_mode)) return Failure(@"sourceMissing");
  if ([source isEqualToString:target]) return @{@"ok" : @YES, @"path" : target, @"bytes" : @(info.st_size)};
  NSString *parent = target.stringByDeletingLastPathComponent;
  NSString *name = target.lastPathComponent;
  if (!ValidName(name)) return Failure(@"badName");
  NSString *reason = nil;
  if (!StillFree(target, &reason)) return Failure(reason);
  ScopedFd dir(open(parent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (!dir.valid()) return Failure(@"folderChanged");
  char where[MAXPATHLEN];
  if (fcntl(dir.get(), F_GETPATH, where) != 0 || ![[NSFileManager.defaultManager stringWithFileSystemRepresentation:where length:strlen(where)] isEqualToString:parent])
    return Failure(@"folderChanged");
  const off_t bytes = info.st_size;
  if (renameatx_np(AT_FDCWD, source.fileSystemRepresentation, dir.get(), name.fileSystemRepresentation, RENAME_EXCL) == 0)
    return @{@"ok" : @YES, @"path" : target, @"bytes" : @(bytes)};
  if (errno == EEXIST) return Failure(@"exists");
  if (errno != EXDEV) return Failure(@"moveFailed");
  ScopedFd from(open(source.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
  if (!from.valid()) return Failure(@"sourceMissing");
  ScopedFd to(openat(dir.get(), name.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0644));
  if (!to.valid()) return Failure(errno == EEXIST ? @"exists" : @"moveFailed");
  if (fcopyfile(from.get(), to.get(), nullptr, COPYFILE_DATA | COPYFILE_STAT | COPYFILE_XATTR) != 0) {
    unlinkat(dir.get(), name.fileSystemRepresentation, 0);
    return Failure(@"moveFailed");
  }
  unlink(source.fileSystemRepresentation);
  return @{@"ok" : @YES, @"path" : target, @"bytes" : @(bytes)};
}

}
