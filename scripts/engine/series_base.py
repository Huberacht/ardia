import configparser
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import stat
import sys
import tarfile

REPO = pathlib.Path(__file__).resolve().parents[2]
BUILD = REPO / "engine/patches/build"
TABLE = REPO / "scripts/engine/series-bases.tsv"
TABLE_FIELDS = ("platform", "cpu", "chromium", "helium_chromium", "helium_platform", "tag", "asset", "sha256")
DEFAULT_CPU = {"mac": "arm64", "linux": "x64"}
PLATFORM_HELIUM = {"mac": "helium-macos", "linux": "helium-linux"}
BRANDING_INPUTS = ("03-helium.py", "ardia_namesub.py", "ardia_resources.txt", "domsub-keep-store.txt", "ardia-icons")
MANIFEST = "manifest.json"
FILES_ROOT = "src/"
FORMAT = 1


class Problem(Exception):
    pass


def load_series():
    spec = importlib.util.spec_from_file_location("ardia_series", REPO / "engine/patches/series.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pins(build=BUILD):
    env = pathlib.Path(build, "env.sh").read_text()
    match = re.search(r"^export CHROMIUM_VERSION=([0-9.]+)$", env, re.M)
    if not match:
        raise Problem(f"{build}/env.sh sets no CHROMIUM_VERSION")
    ini = configparser.ConfigParser()
    ini.read(pathlib.Path(build, "helium-pins.ini"))
    if ini.get("chromium", "version", fallback=None) != match.group(1):
        raise Problem(f"env.sh pins Chromium {match.group(1)} but helium-pins.ini pins {ini.get('chromium', 'version', fallback='none')}")
    out = {"chromium": match.group(1)}
    for section in ("helium-chromium", "helium-macos", "helium-linux"):
        commit = ini.get(section, "commit", fallback="")
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise Problem(f"helium-pins.ini: [{section}] has no 40-hex commit")
        out[section] = commit
    return out


def identity(platform, cpu=None, build=BUILD):
    if platform not in DEFAULT_CPU:
        raise Problem(f"unknown platform {platform}")
    pinned = pins(build)
    return {"platform": platform, "cpu": cpu or DEFAULT_CPU[platform], "chromium": pinned["chromium"],
            "helium_chromium": pinned["helium-chromium"], "helium_platform": pinned[PLATFORM_HELIUM[platform]]}


def tag_name(ident):
    return f"series-base-{ident['chromium']}-{ident['helium_chromium'][:12]}"


def asset_prefix(ident):
    return (f"series-base-{ident['chromium']}-{ident['helium_chromium'][:12]}-{ident['platform']}-"
            f"{ident['helium_platform'][:12]}-{ident['cpu']}-")


def content_revision(manifest):
    files = json.dumps({"files": manifest["files"], "absent": manifest["absent"]}, sort_keys=True)
    return hashlib.sha256(files.encode()).hexdigest()[:12]


def asset_name(ident, revision):
    return f"{asset_prefix(ident)}{revision}.tar.xz"


def branding_digest(build=BUILD):
    digest = hashlib.sha256()
    for name in BRANDING_INPUTS:
        root = pathlib.Path(build, name)
        paths = sorted(p for p in root.rglob("*") if p.is_file()) if root.is_dir() else [root]
        for path in paths:
            digest.update(path.relative_to(build).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest() if path.exists() else b"absent")
    return digest.hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative(path):
    return bool(path) and not path.startswith("/") and "\\" not in path and \
        all(part not in ("", ".", "..") for part in path.split("/"))


def deleted_paths(step):
    if step.kind != "chromium":
        return []
    out, old = [], None
    for line in pathlib.Path(step.patch).read_text(encoding="utf-8", errors="surrogateescape").splitlines():
        if line.startswith("--- "):
            match = re.match(r"^--- (?:a/)?(\S+)", line)
            old = match.group(1) if match else None
        elif line.startswith("+++ ") and line.split()[1] == "/dev/null" and old and old != "/dev/null":
            out.append(old)
    return out


def base_paths(steps):
    created = set()
    for step in steps:
        created |= step.created()
    required, optional, created_before = {}, {}, set()
    for step in steps:
        for path in deleted_paths(step):
            if path not in created_before:
                required.setdefault(path, step.name)
        created_before |= step.created()
        for path, is_dir in step.paths():
            if is_dir or path in created:
                continue
            if step.kind == "chromium":
                required.setdefault(path, step.name)
            else:
                optional.setdefault(path, step.name)
    for path in required:
        optional.pop(path, None)
    return required, optional


def read_table(table=TABLE):
    rows = []
    if not pathlib.Path(table).exists():
        return rows
    for number, line in enumerate(pathlib.Path(table).read_text().splitlines(), 1):
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) != len(TABLE_FIELDS):
            raise Problem(f"{table}:{number}: expected {len(TABLE_FIELDS)} tab-separated fields")
        rows.append(dict(zip(TABLE_FIELDS, fields)))
    return rows


IDENTITY = ("platform", "cpu", "chromium", "helium_chromium", "helium_platform")


def find_row(ident, table=TABLE):
    for row in read_table(table):
        if all(row[key] == ident[key] for key in IDENTITY):
            return row
    return None


def write_row(row, table=TABLE):
    rows = [r for r in read_table(table) if any(r[key] != row[key] for key in IDENTITY)] + [row]
    rows.sort(key=lambda r: (r["chromium"], r["platform"], r["cpu"], r["asset"]))
    pathlib.Path(table).write_text("".join("\t".join(r[k] for k in TABLE_FIELDS) + "\n" for r in rows))


def _tar_info(name, size=0, mode=0o644, kind=tarfile.REGTYPE, link=""):
    info = tarfile.TarInfo(name)
    info.size, info.mode, info.type, info.linkname = size, mode, kind, link
    info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, "", ""
    return info


def write_tarball(base, paths, manifest_fields, out):
    files, absent = {}, []
    entries = []
    for path in sorted(paths):
        if not safe_relative(path):
            raise Problem(f"unsafe path in the series: {path!r}")
        full = os.path.join(base, path)
        if os.path.islink(full):
            raise Problem(f"{full} is a symlink: the series base holds regular files only")
        if os.path.isfile(full):
            data = pathlib.Path(full).read_bytes()
            mode = 0o755 if os.stat(full).st_mode & stat.S_IXUSR else 0o644
            files[path] = {"sha256": hashlib.sha256(data).hexdigest(), "mode": f"{mode:o}"}
            entries.append((path, data, mode))
        else:
            absent.append(path)
    manifest = dict(manifest_fields, format=FORMAT, files=files, absent=absent)
    body = (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode()
    if os.path.isdir(out):
        out = os.path.join(out, asset_name(manifest_fields, content_revision(manifest)))
    if os.path.exists(out):
        raise Problem(f"{out} exists; give a new destination")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with tarfile.open(out, "w:xz", format=tarfile.PAX_FORMAT, preset=9) as tar:
        tar.addfile(_tar_info(MANIFEST, len(body)), io.BytesIO(body))
        for path, data, mode in entries:
            tar.addfile(_tar_info(FILES_ROOT + path, len(data), mode), io.BytesIO(data))
    return manifest, out


def read_manifest(tarball):
    try:
        with tarfile.open(tarball, "r:xz") as tar:
            member = tar.getmember(MANIFEST)
            if not member.isfile():
                raise Problem(f"{tarball}: {MANIFEST} isn't a file")
            manifest = json.loads(tar.extractfile(member).read())
    except (OSError, KeyError, ValueError, tarfile.TarError) as error:
        raise Problem(f"{tarball} isn't a series base archive: {error}")
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT or \
            not isinstance(manifest.get("files"), dict) or not isinstance(manifest.get("absent"), list):
        raise Problem(f"{tarball}: not a format {FORMAT} series base manifest")
    return manifest


def extract(tarball, dest):
    manifest = read_manifest(tarball)
    files = manifest["files"]
    seen = set()
    dest = os.path.realpath(dest)
    if os.listdir(dest):
        raise Problem(f"{dest} isn't empty")
    with tarfile.open(tarball, "r:xz") as tar:
        for member in tar:
            if member.name == MANIFEST:
                continue
            if not member.name.startswith(FILES_ROOT):
                raise Problem(f"{tarball}: unexpected entry {member.name!r}")
            path = member.name[len(FILES_ROOT):]
            if not safe_relative(path) or path not in files or path in seen:
                raise Problem(f"{tarball}: entry {member.name!r} isn't in its manifest, or is unsafe or repeated")
            if not member.isfile():
                raise Problem(f"{tarball}: {path} isn't a regular file")
            seen.add(path)
            parent = dest
            for part in path.split("/")[:-1]:
                parent = os.path.join(parent, part)
                if os.path.islink(parent) or (os.path.exists(parent) and not os.path.isdir(parent)):
                    raise Problem(f"{tarball}: {path} goes through something that isn't a directory")
                if not os.path.exists(parent):
                    os.mkdir(parent)
            data = tar.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != files[path].get("sha256"):
                raise Problem(f"{tarball}: {path} doesn't match its manifest's sha256")
            target = os.path.join(dest, path)
            with open(target, "xb") as handle:
                handle.write(data)
            os.chmod(target, int(files[path].get("mode", "644"), 8) & 0o755)
    missing = sorted(set(files) - seen)
    if missing:
        raise Problem(f"{tarball}: its manifest lists {len(missing)} files it doesn't hold, e.g. {missing[0]}")
    return manifest


def die(message, code=1):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(code)
