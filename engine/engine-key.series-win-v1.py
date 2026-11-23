import io
import os

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
HOOK_HEADERS = ['ardia/core/ac_hooks.h', 'ardia/core/ac_content_hooks.h', 'ardia/core/ac_host_visibility.h']
LAUNCH_SWITCHES = 'ardia/core/ac_launch_switches'
WINDOWS_TAGS = ('all', 'mac')
SERIES_TAGS = ('all', 'mac', 'linux')
SERIES_REL = 'engine/patches/series'
SERIES_WIN_REL = 'scripts/windows/engine/series-win'
WIN_PATCHES_REL = 'scripts/windows/engine/patches'
ARDIACORE_SRC_REL = 'engine/ardiacore/src'
ENGINE_API_REL = 'apps/browser/windows/Ardia/EngineApi.h'
RESOURCE_LISTS = ('engine/patches/build/ardia_resources.txt', 'scripts/windows/engine/ardia_resources_win.txt')
KEY_TREES = ('engine/chromium/src', 'engine/patches/build', 'apps/browser/assets/offline-game',
             'apps/browser/assets/offline-game-pipeline', 'scripts/windows/engine')
KEY_FILES = ('engine/patches/series.py',)
KEY_TOOLING = ('engine/patches/build/tests', 'scripts/windows/engine/check_inputs.py', 'scripts/windows/engine/prebuilt.json')


class InputError(Exception):
    pass


def where(path, line):
    return f'{os.path.relpath(path, REPO)}:{line}'


def checkout_path(rel):
    return os.path.join(REPO, *rel.split('/'))


def series_lines(text, path, tags=WINDOWS_TAGS):
    if text is None:
        return []
    out = []
    for n, raw in enumerate(io.StringIO(text), 1):
        fields = raw.split('#', 1)[0].split()
        if not fields or fields[0] != 'chromium':
            continue
        if len(fields) not in (2, 3):
            raise InputError(f'{where(path, n)}: expected `chromium <patch> [{"|".join(SERIES_TAGS)}]`: {raw.strip()}')
        tag = fields[2] if len(fields) == 3 else 'all'
        if tag not in SERIES_TAGS:
            raise InputError(f'{where(path, n)}: unknown platform `{tag}`; this script knows {", ".join(SERIES_TAGS)}')
        if tag in tags:
            out.append(fields[1])
    return out


def skip_names(text):
    if text is None:
        return set()
    return {l.split(None, 1)[1].strip() for l in (r.split('#', 1)[0].strip() for r in io.StringIO(text))
            if l.startswith('skip ')}


def plan_patches(read):
    skips = skip_names(read(SERIES_WIN_REL))
    shared = [n for n in series_lines(read(SERIES_REL), checkout_path(SERIES_REL)) if n not in skips]
    own = series_lines(read(SERIES_WIN_REL), checkout_path(SERIES_WIN_REL))
    return [(n, f'engine/patches/{n}') for n in shared] + [(n, f'{WIN_PATCHES_REL}/{n}') for n in own]


def resource_sources(text, rel):
    sources = []
    for n, line in enumerate((text or '').splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split()
        if len(parts) != 2:
            raise InputError(f'{rel}:{n}: expected `<source> <dest>`')
        sources.append(parts[0])
    return sources


def under(path, prefix):
    return path == prefix or path.startswith(prefix + '/')


class KeyInputs:
    def __init__(self, patches, files, excluded):
        self.patches, self.files, self.excluded = patches, files, excluded
        self.trees, self.series, self.listed = KEY_TREES, (SERIES_REL, SERIES_WIN_REL), frozenset(files)

    def counts(self, path):
        if path in self.series:
            return False
        if path in self.listed:
            return True
        return any(under(path, tree) for tree in self.trees) and not any(under(path, out) for out in self.excluded)


def key_inputs(files, read):
    patches = [rel for _, rel in plan_patches(read)]
    applied = set(patches)
    listed = set(KEY_FILES) | {ENGINE_API_REL}
    listed |= {f'{ARDIACORE_SRC_REL}/{rel}' for rel in HOOK_HEADERS}
    listed |= {f'{ARDIACORE_SRC_REL}/{LAUNCH_SWITCHES}{ext}' for ext in ('.cc', '.h')}
    listed |= applied
    for listing in RESOURCE_LISTS:
        listed.update(resource_sources(read(listing), listing))
    excluded = set(KEY_TOOLING)
    excluded |= {path for path in files if under(path, WIN_PATCHES_REL) and path not in applied}
    excluded |= {path for path in files if under(path, 'scripts/windows/engine') and path.endswith('_test.py')}
    return KeyInputs(patches, sorted(listed), sorted(excluded))
