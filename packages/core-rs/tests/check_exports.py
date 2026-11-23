import pathlib
import platform
import re
import subprocess
import sys

CORE = pathlib.Path(__file__).resolve().parents[1]
HEADER = CORE / 'include/ardia_core.h'


def declared():
    return sorted(set(re.findall(r'^[A-Za-z0-9_ *]*?\b(ardia_[a-z0-9_]+)\(', HEADER.read_text(), re.M)))


def exported(library):
    if platform.system() == 'Darwin':
        listing = subprocess.run(['nm', '-gU', str(library)], capture_output=True, text=True, check=True).stdout
        names = [line.split()[-1].removeprefix('_') for line in listing.splitlines() if ' T ' in line]
    else:
        listing = subprocess.run(['nm', '-D', '--defined-only', str(library)], capture_output=True, text=True,
                                 check=True).stdout
        names = [line.split()[-1] for line in listing.splitlines() if ' T ' in line]
    return sorted(name for name in names if name.startswith('ardia'))


def main():
    suffix = 'dylib' if platform.system() == 'Darwin' else 'so'
    library = CORE / f'target/release/libardia_core.{suffix}'
    want, got = declared(), exported(library)
    if len(want) != 15 or got != want:
        print(f'header declares {want}', file=sys.stderr)
        print(f'{library.name} exports {got}', file=sys.stderr)
        return 1
    print(f'{library.name} exports exactly the {len(want)} functions the header declares')
    return 0


if __name__ == '__main__':
    sys.exit(main())
