#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

namespace ardia_files {

constexpr NSUInteger kMaxPathBytes = 1024;
constexpr NSUInteger kMaxNameBytes = 255;

NSString *_Nullable ChosenPath(id _Nullable path, NSString *_Nullable *_Nonnull reason);
NSString *_Nullable DownloadTarget(id _Nullable path, BOOL *folder, NSString *_Nullable *_Nonnull reason);
NSString *_Nullable FreePathIn(NSString *folder, NSString *_Nullable name, NSString *_Nullable *_Nonnull reason);
bool StillFree(NSString *target, NSString *_Nullable *_Nonnull reason);
NSDictionary<NSString *, id> *PlaceFile(NSString *source, NSString *target);

}

NS_ASSUME_NONNULL_END
