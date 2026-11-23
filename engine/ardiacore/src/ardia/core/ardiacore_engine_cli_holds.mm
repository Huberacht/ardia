#import "ardia/core/public/ArdiaCore.h"

#include <utility>
#include <vector>

#include "ardia/core/ac_discard_veto.h"
#include "base/time/time.h"
#include "content/public/browser/web_contents.h"
#import "ardia/core/ardiacore_internal.h"

@implementation ArdiaCoreEngine (CliHolds)

+ (NSInteger)holdTabsForCli:(NSArray<ArdiaCoreTab*>*)tabs
                    seconds:(NSArray<NSNumber*>*)seconds {
  std::vector<std::pair<content::WebContents*, base::TimeDelta>> held;
  for (NSUInteger i = 0; i < tabs.count && i < seconds.count; ++i) {
    if (content::WebContents* contents = tabs[i].contents) {
      held.emplace_back(contents, base::Seconds(seconds[i].doubleValue));
    }
  }
  ardiacore::SetCliHeldTabs(held);
  return ardiacore::TakeCliHoldVetoes();
}

@end
