# Privacy: what Ardia itself contacts

This is the list of every host Ardia (not the pages you open) talks to, how each request travels, and every Google or
Chromium service that is turned off. `apps/browser/src/privacyEndpoints.test.mjs` keeps it honest: it scans the
shipped sources of the Mac, Linux and Windows apps for hard-coded `http(s)://` and `ws(s)://` hosts and fails when one
isn't on this page, and it fails when a row below cites a file that's gone or a literal that's no longer in it.
Reserved names (`.example`, `.test`, `.invalid`, `.localhost`, `.local`) and IP literals are skipped; tests, fixtures,
build scripts and docs aren't shipped and aren't scanned.

## How requests travel

- **The profile's Chromium network context.** Chromium's own stack for that profile: it follows the system proxy, an
  extension's `chrome.proxy` setting and a `ProxySettings` policy for that profile, and it can send that profile's
  cookies. A private window's profile is its own off-the-record context. There is no Ardia proxy setting: `ACMainDelegate`
  strips `--proxy-server` and `--proxy-pac-url` from the command line (`engine/ardiacore/src/ardia/core/ac_main_delegate.cc`,
  `docs/engine-build.md`), so Chromium follows the system proxy.
- **Chromium's system network context.** Chromium's stack with no profile: system proxy and policy, no profile's
  cookies, no extension proxy. The Linux app sends its own requests (telemetry, reports, updates, kill switches, the
  bang list) this way, with credentials omitted.
- **URLSession, WinHTTP and the app's `fetch`.** Requests outside Chromium (React Native's `fetch` is `NSURLSession` on
  the Mac and `Windows.Web.Http` on Windows). They follow the system proxy, but no extension or Chromium policy proxy,
  and they belong to no profile: they never carry a site's Chromium cookies. Ardia's own URLSession sessions are
  ephemeral with no cookie store.
- **`NWConnection`.** Plugins' `net.fetch` opens its own TLS connection after checking the resolved address, so it
  doesn't go through any HTTP proxy.

## Endpoints Ardia contacts

| Host | Purpose | Stack | System proxy | Private windows | Other profiles | Cookies and credentials | Gate | Off switch | Code |
|---|---|---|---|---|---|---|---|---|---|
| `ardia.dev` | Usage counts and crash reports (`/otel/v1/logs`) | App `fetch` (Mac, Windows); Chromium system context (Linux) | Yes | App-wide counts; a private window adds to counts, never a URL or a title | App-wide, no profile | None | Sharing on only | Settings › General › Share anonymous crash reports | `apps/browser/src/state/telemetry/config.ts`, `engine/ardiacore-linux/src/ardia/linux/ac_linux_telemetry_policy.h` |
| `ardia.dev` | Kill switches (`/switches.json`), once a launch | App `fetch` with `credentials: "omit"`; Chromium system context (Linux) | Yes | App-wide, nothing from the window | App-wide | None | Automatic update checks on | Settings › General › Install updates automatically | `apps/browser/src/platform/killSwitches.ts`, `engine/ardiacore-linux/src/ardia/linux/ac_linux_updates_policy.h` |
| `ardia.dev` | Update feed (`/appcast.xml`), Sparkle on the Mac | Sparkle's URLSession | Yes | App-wide | App-wide | No Chromium cookies | Automatic update checks on, or Check for Updates | Settings › General › Install updates automatically | `apps/browser/macos/Ardia-macOS/Info.plist` |
| `ardia.dev` | Reports you send (`/api/feedback`); attachments go to the upload addresses it hands back | App `fetch`, attachments over an ephemeral URLSession (Mac); Chromium system context (Linux) | Yes | Only what you attach | Only what you attach | None | You press Send | Don't send a report | `apps/browser/src/state/report/actions.ts`, `engine/ardiacore-linux/src/ardia/linux/ac_linux_report_core.h` |
| `github.com` | Update downloads (redirected to GitHub's asset hosts), the Windows and Linux update feeds, official plugin downloads | Sparkle's URLSession (Mac), WinHTTP (Windows), Chromium system context (Linux), ephemeral URLSession (plugins) | Yes | App-wide | App-wide | None | Updates: automatic checks or Check for Updates; plugins: you install or update one | Install updates automatically; don't install the plugin | `apps/browser/official-plugins.json`, `apps/browser/windows/Ardia/UpdateModule.h`, `packages/shell/ios/AppUpdater.swift` |
| `api.github.com` | Linux release list for updates | Chromium system context | Yes | App-wide | App-wide | None | Automatic update checks on | Install updates automatically | `engine/ardiacore-linux/src/ardia/linux/ac_linux_updates_policy.h` |
| `services.helium.imput.net` | The `!bang` list (`/bangs.json`), refreshed at most once a day when you type `!`; no query is sent | Ephemeral URLSession with no cookies (Mac), WinHTTP (Windows), Chromium system context (Linux) | Yes | Never refreshed from a private window: it uses the copy on disk or the bundled list | App-wide | None | You type `!` in the address bar | None; the bundled list works offline | `packages/shell/ios/BangListFetch.swift`, `apps/browser/windows/Ardia/ShellModule.h`, `engine/ardiacore-linux/src/ardia/linux/ac_linux_bang_list_policy.h` |
| `www.google.com`, `api.bing.com`, `duckduckgo.com`, `ac.ecosia.org`, `search.brave.com`, `www.startpage.com`, `search.yahoo.com`, `www.baidu.com`, `suggest.yandex.com` | Search suggestions from the profile's search engine as you type | The window profile's Chromium network context | Yes, plus extension and policy proxies | Off | Each window asks with its own profile | Mac: that engine's own cookies from the profile, as Chrome does, never saved; Linux: none | Suggest while typing on | Settings › Profiles › Suggest while typing | `packages/core/src/engines.ts`, `engine/chromium/src/chrome/browser/ardia/ac_search_suggest.cc`, `engine/ardiacore-linux/src/ardia/linux/ac_linux_suggest_policy.h` |
| A page's icon host (from the page) | Favicons the app fetches when Chromium hasn't stored one | The tab's own profile's Chromium network context | Yes, plus extension and policy proxies | Never fetched for a private tab; a private window only reads other profiles' local icon stores, without network, and keeps the answers in its own cache, dropped when it closes | Only the tab's own profile fetches | No cookies | Shown tabs only | None | `packages/ardiacore/ios/ArdiaFavicons.mm`, `apps/browser/src/state/favicons/favicons.ts` |
| Website notification icons (from the page) | The icon of a site's notification | The tab's own profile's Chromium network context, then a local file or `data:` image; the notification layer refuses anything else | Yes | Private windows post no notifications | The tab's own profile only | No cookies | The site has notification permission | Block the site's notifications | `apps/browser/src/state/site/webNotifications.ts`, `packages/shell/ios/NotificationHub.swift` |
| `clients2.google.com` | Chrome Web Store installs, extension updates and Google's extension kill switch | Chromium's extension downloader on the profile's network context | Yes, plus extension and policy proxies | Chromium's rules: updates are per regular profile | Per profile | Chromium's rules: retries with the profile's Google cookies only when the store asks for them | You install an extension | Remove the extensions | `engine/patches/chromium-webstore-direct.patch`, `engine/patches/chromium-extension-updates.patch` |
| `update.googleapis.com` | Security components only: CRLSet, PKI metadata (CT logs, root store), the SSL error assistant | Chromium's component updater, system context | Yes | App-wide | App-wide | None | Always | None | `engine/patches/chromium-component-updater-security-only.patch` |
| `api.github.com`, `github.com`, `api.bitbucket.org`, `bitbucket.org`, `api.notion.com`, `oauth2.googleapis.com`, `www.googleapis.com` | Live Folders: your GitHub, Bitbucket, Notion and Google Drive items, and signing in to them | App `fetch` (Mac, Windows); the app profile's Chromium context with credentials omitted (Linux) | Yes | Refused in private windows | The account you connected, app-wide | The token you granted, no cookies | You connect an account | Settings › Automations › Connected accounts | `apps/browser/src/state/live/net.ts`, `apps/browser/src/state/live/sources.ts`, `engine/ardiacore-linux/src/ardia/linux/ac_linux_live.cc` |
| Your Confluence site (user-chosen) | Live Folders for Confluence | App `fetch` | Yes | Refused in private windows | App-wide | The token you granted | You connect it | Disconnect it | `apps/browser/src/state/live/sources.ts` |
| Hosts a plugin declares (plugin-chosen) | A plugin's `net.fetch`, https only, to the hosts in its manifest | `NWConnection` (Mac) | No: direct | Not tied to a window | App-wide | Only what the plugin sends | The plugin has the network permission and you installed it | Remove or turn off the plugin | `packages/shell/ios/PluginHostFetch.swift`, `apps/browser/src/state/plugins/channelData.ts` |
| Your omnibox provider's host (user-chosen) | A suggestion provider you added in config | App `XMLHttpRequest`, `withCredentials = false` | Yes | Off | Per profile cache | None | You approve the provider | Remove it from config | `apps/browser/src/state/omnibox/remoteProvider.ts` |

Sync makes no network request: it writes sealed files to a folder you pick and the folder's own service carries them
(`docs/sync.md`). The phone app (`apps/phone`) is out of scope here; `docs/phone.md` covers it.

### Private windows and other profiles

- Nothing outside Chromium starts from a private window: suggestions, providers, plugins' omnibox rows, Live Folders,
  the bang list refresh, notifications and favicon fetches are all off there.
- A private window may still show icons it finds in other profiles' local icon stores (as Chrome's incognito shows the
  original profile's). That is a local read with no network and no write: the answers go into the private window's own
  cache and leave with it, and nothing about a private page is written into another profile's cache or store. A
  favicon drawn in a private window with no profile given asks as that window.
- A normal window drawing an icon with no profile given (the command bar, history menus) may read any profile's local
  icon store. That is also local and writes only into the profile that answered.

## Hosts named in the source that Ardia doesn't contact

Pages, links and patterns: Ardia opens these only as pages you navigate to, or matches them as text.

- Search engines' result pages (searches open as pages): `www.google.com`, `www.bing.com`, `duckduckgo.com`,
  `www.ecosia.org`, `search.brave.com`, `www.startpage.com`, `search.yahoo.com`, `www.baidu.com`, `yandex.com`,
  `kagi.com`, `www.perplexity.ai`, `chatgpt.com`.
- Site search and quick-create shortcuts: `developer.mozilla.org`, `en.wikipedia.org`, `hn.algolia.com`, `mail.google.com`,
  `drive.google.com`, `open.spotify.com`, `stackoverflow.com`, `translate.google.com`, `www.amazon.com`, `www.ebay.com`,
  `www.figma.com`, `www.imdb.com`, `www.linkedin.com`, `www.notion.so`, `www.npmjs.com`, `www.pinterest.com`,
  `www.reddit.com`, `www.youtube.com`, `x.com`, `confluence.new`, `docs.new`, `excel.new`, `figjam.new`, `figma.new`,
  `forms.new`, `gist.new`, `jira.new`, `linear.new`, `meet.new`, `meeting.new`, `notion.new`, `powerpoint.new`,
  `repo.new`, `sheets.new`, `slides.new`, `word.new`.
- Bang list entries kept as examples in the parser: `finanza-mercati.ilsole24ore.com`, `forum.lametayel.co.il`,
  `ocw.mit.edu`, `psychologytoday.com`, `www.freedesktop.org`, `www.jedisjeux.net`, `www.opencaching.us`,
  `www.vanguardinvestments.com.au`.
- Onboarding's suggested sites (bundled icons, nothing fetched): `app.slack.com`, `calendar.google.com`,
  `docs.google.com`, `linear.app`, `outlook.office.com`.
- Links Ardia opens as pages: `chromewebstore.google.com` (an extension's store page), `accounts.google.com` (Google's
  sign-in page for Live Folders, opened in a tab), `www.atlassian.com`, `your-team.atlassian.net` (a placeholder),
  `crbug.com`.
- XML and schema namespaces, never fetched: `www.w3.org`, `www.apple.com`, `schemas.microsoft.com`, `json-schema.org`.
- Licence text: `www.apache.org`, `www.gnu.org`, `fsf.org`.
- Placeholders: `example.com`, and Helium's unresolvable services host `services-disabled.qjz9zk`.

## Google and Chromium endpoints that are off

Ardia's engine is Chromium with Helium's and ungoogled-chromium's patches (pinned in
`engine/patches/build/helium-pins.ini`) and our own series. Helium's domain substitution rewrites Google hosts in
Chromium's source to unresolvable `*.qjz9zk` names, except the Web Store and extension update hosts listed in
`domsub-keep-store.txt`; that covers the many services ungoogled-chromium removes (Google sign-in and sync, metrics
upload, variations, Safe Browsing lookups, Translate, spell-check downloads, Google host detection, network time,
domain reliability, GCM). Each row cites the file that turns it off and a literal the test finds in it.

| Endpoint | What it was | Off by | Proof |
|---|---|---|---|
| Google hosts in Chromium's source | Every Google service Helium's list names | `engine/patches/build/03-helium.py`, `engine/patches/build/domsub-keep-store.txt` | `domain_substitution.py` |
| Google APIs (keys and OAuth client) | Sign-in, sync and Google API calls | `engine/patches/build/gn_defines.sh` | `google_api_key=""` |
| Safe Browsing (`safebrowsing.googleapis.com`) | URL reputation lookups | `engine/patches/build/gn_defines.sh` | `safe_browsing_mode=0` |
| Field trial config | Chromium's built-in experiment config | `engine/patches/build/gn_defines.sh` | `disable_fieldtrial_testing_config=true` |
| Chrome Remote Desktop and Hangouts services | Remoting host and the Hangouts extension | `engine/patches/build/gn_defines.sh` | `enable_remoting=false` |
| Chrome's own updater | Google Update / Keystone | `engine/patches/build/gn_defines.sh` | `enable_updater=false` |
| Helium's services (`services.helium.imput.net` from the engine), its update feed and crash server | Helium's services and updates | `engine/patches/chromium-helium-branding.patch` | `services-disabled.qjz9zk` |
| Helium's onboarding consent | The page that turns Helium's services on | `engine/patches/chromium-helium-onboarding-off.patch` | `onboarding` |
| Helium's services settings page | Switches for Helium's services | `engine/patches/chromium-helium-services-page-off.patch` | `services` |
| Helium's web push server | An autopush WebSocket for site push messages | `engine/patches/chromium-helium-web-push-off.patch` | `ShouldAccessPushService` |
| Helium's bang list in Chromium | `BangManager` fetching bangs | `engine/patches/chromium-helium-bangs-off.patch` | `LoadBangs` |
| Helium's translation providers | Page text sent to a translation provider | `engine/patches/chromium-helium-translate-providers-off.patch` | `HasTranslationProvider` |
| Helium's search engine assets | Non-free search engine icons fetched at build time | `engine/patches/chromium-helium-search-assets-off.patch` | `enable_builtin_search_provider_assets` |
| Helium's crash upload prompt (`crash.helium.computer`) | An infobar asking to upload crashes | `engine/patches/build/03-helium.py` | `crash-dialog.patch` |
| Helium's Sparkle updater in the engine | A second updater inside the framework | `engine/patches/build/03-helium.py` | `sparkle-integration.patch` |
| Component updater, everything but security components | Widevine, hints, models and other downloads | `engine/patches/chromium-component-updater-security-only.patch` | `GetCrxComponents` |
| Gemini in Chrome (Glic) and contextual cueing | Google's in-browser assistant | `engine/ardiacore/src/ardia/core/ac_main_delegate.cc` | `Glic,GlicActor` |
| Proxy and remote debugging switches | Command-line routes around the system proxy and into the profile | `engine/ardiacore/src/ardia/core/ac_main_delegate.cc` | `proxy-server` |
