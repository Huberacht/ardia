#import "ardia/core/public/ArdiaCore.h"

#include <vector>

#include "ardia/core/ac_discard_veto.h"
#include "content/public/browser/web_contents.h"
#import "ardia/core/ardiacore_internal.h"

@implementation ArdiaCoreEngine (CliHolds)

+ (NSInteger)holdTabsForCli:(NSArray<ArdiaCoreTab*>*)tabs {
  std::vector<content::WebContents*> held;
  for (ArdiaCoreTab* tab in tabs) {
    if (tab.contents) {
      held.push_back(tab.contents);
    }
  }
  ardiacore::SetCliHeldTabs(held);
  return ardiacore::TakeCliHoldVetoes();
}

@end
