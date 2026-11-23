// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_FAVICON_TOUCH_THROTTLE_H_
#define CHROME_BROWSER_ARDIA_AC_FAVICON_TOUCH_THROTTLE_H_

#include <cstddef>
#include <iterator>
#include <list>
#include <map>
#include <utility>

namespace ardia {

template <typename Key, typename Time, typename Duration>
class FaviconTouchThrottle {
 public:
  FaviconTouchThrottle(Duration touch_again_after, size_t max_entries)
      : touch_again_after_(touch_again_after),
        max_entries_(max_entries ? max_entries : 1) {}

  FaviconTouchThrottle(const FaviconTouchThrottle&) = delete;
  FaviconTouchThrottle& operator=(const FaviconTouchThrottle&) = delete;

  bool ShouldTouch(const Key& key, Time now) {
    DropExpired(now);
    auto found = index_.find(key);
    if (found != index_.end()) {
      if (!Expired(found->second->second, now)) {
        return false;
      }
      by_last_touch_.erase(found->second);
      index_.erase(found);
    }
    while (index_.size() >= max_entries_) {
      index_.erase(by_last_touch_.front().first);
      by_last_touch_.pop_front();
    }
    if (!by_last_touch_.empty() && now < by_last_touch_.back().second) {
      now = by_last_touch_.back().second;
    }
    by_last_touch_.emplace_back(key, now);
    index_.emplace(key, std::prev(by_last_touch_.end()));
    return true;
  }

  size_t size() const { return index_.size(); }

  bool Holds(const Key& key) const { return index_.count(key) != 0; }

 private:
  using Entries = std::list<std::pair<Key, Time>>;

  bool Expired(Time last, Time now) const {
    return now >= last && now - last >= touch_again_after_;
  }

  void DropExpired(Time now) {
    while (!by_last_touch_.empty() &&
           Expired(by_last_touch_.front().second, now)) {
      index_.erase(by_last_touch_.front().first);
      by_last_touch_.pop_front();
    }
  }

  const Duration touch_again_after_;
  const size_t max_entries_;
  Entries by_last_touch_;
  std::map<Key, typename Entries::iterator> index_;
};

}

#endif
