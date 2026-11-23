import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest

ENGINE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))
import series_base  # noqa: E402

spec = importlib.util.spec_from_file_location("series_zero_fuzz", ENGINE / "series-zero-fuzz.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

ORIGINAL = "".join(f"line {n}\n" for n in range(1, 41))


class FakeStep:
    def __init__(self, name, patch, kind="chromium", line=1):
        self.kind, self.name, self.patch, self.line = kind, name, patch, line

    def paths(self):
        return [(p, False) for p in sorted(touched_paths(self.patch))]

    def created(self):
        text = pathlib.Path(self.patch).read_text()
        out, new = set(), False
        for raw in text.splitlines():
            if raw.startswith("--- "):
                new = raw.strip() == "--- /dev/null"
            if raw.startswith("+++ b/") and new:
                out.add(raw[6:])
        return out


def touched_paths(patch):
    return {raw[6:] for raw in pathlib.Path(patch).read_text().splitlines() if raw.startswith("+++ b/")}


def make_patch(directory, name, path, before, after):
    a, b = os.path.join(directory, "a", path), os.path.join(directory, "b", path)
    for full, text in ((a, before), (b, after)):
        os.makedirs(os.path.dirname(full), exist_ok=True)
        pathlib.Path(full).write_text(text)
    diff = subprocess.run(["git", "diff", "--no-index", "--no-prefix", "a/" + path, "b/" + path], cwd=directory,
                          capture_output=True, text=True).stdout
    out = os.path.join(directory, name)
    pathlib.Path(out).write_text(diff)
    return out


def edited(text, **changes):
    lines = text.splitlines(keepends=True)
    for index, value in changes.items():
        lines[int(index[1:]) - 1] = value
    return "".join(lines)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ac-zero-fuzz-test-")
        self.tree = os.path.join(self.dir, "tree")
        os.makedirs(os.path.join(self.tree, "chrome"))
        self.patches = os.path.join(self.dir, "patches")
        os.makedirs(self.patches)

    def tearDown(self):
        subprocess.run(["rm", "-rf", self.dir])

    def patch(self, name, path="chrome/f.cc", before=ORIGINAL, after=None):
        after = after if after is not None else edited(before, l20="line twenty\n")
        return FakeStep(name, make_patch(os.path.join(self.patches, name + ".d"), name, path, before, after))

    def write_tree(self, text, path="chrome/f.cc"):
        pathlib.Path(self.tree, path).write_text(text)

    def run_tree(self, steps):
        return checker.check_tree(steps, self.tree, report=None)


class StrictApply(Fixture):
    def test_clean_patch_passes(self):
        step = self.patch("clean")
        self.write_tree(ORIGINAL)
        [result] = self.run_tree([step])
        self.assertTrue(result.ok)
        self.assertEqual(result.offsets, [])
        self.assertIn("line twenty\n", pathlib.Path(self.tree, "chrome/f.cc").read_text())

    def test_offset_fails(self):
        step = self.patch("offset")
        self.write_tree("extra a\nextra b\nextra c\n" + ORIGINAL)
        [result] = self.run_tree([step])
        self.assertEqual(result.offsets, [("chrome/f.cc", 1, 20, 3)])
        failing, warned, moves = checker.judge([("linux", [result])], strict=set())
        self.assertEqual(list(failing), ["offset"])
        self.assertEqual(checker.describe(failing["offset"]), ["chrome/f.cc hunk #1 lands at an offset on linux (+3)"])
        self.assertEqual(warned, {})
        self.assertEqual(moves, {step.patch: [("chrome/f.cc", 1, 20, 3)]})

    def test_offset_warns_for_an_unchanged_patch_and_fails_for_a_changed_one(self):
        step = self.patch("offset")
        self.write_tree("extra\n" + ORIGINAL)
        [result] = self.run_tree([step])
        failing, warned, _ = checker.judge([("linux", [result])], strict=set(), offsets="warn")
        self.assertEqual((list(failing), list(warned)), ([], ["offset"]))
        failing, warned, _ = checker.judge([("linux", [result])], strict={"offset"}, offsets="warn")
        self.assertEqual((list(failing), list(warned)), (["offset"], []))

    def test_a_shared_patch_needs_to_land_exactly_on_one_platform_only(self):
        step = self.patch("shared")
        self.write_tree("extra\n" + ORIGINAL)
        [shifted] = self.run_tree([step])
        self.write_tree(ORIGINAL)
        [exact] = self.run_tree([step])
        failing, warned, moves = checker.judge([("linux", [shifted]), ("mac", [exact])], strict=set())
        self.assertEqual((failing, warned, moves), ({}, {}, {}))
        self.write_tree("a\nb\n" + ORIGINAL)
        [shifted_more] = self.run_tree([step])
        failing, _, _ = checker.judge([("linux", [shifted]), ("mac", [shifted_more])], strict=set())
        self.assertEqual(checker.describe(failing["shared"]),
                         ["chrome/f.cc hunk #1 lands at an offset on linux (+1) and mac (+2)"])

    def test_fuzz_fails_and_names_the_hunk(self):
        step = self.patch("fuzzy", after=edited(ORIGINAL, l5="line five\n", l30="line thirty\n"))
        self.write_tree(edited(ORIGINAL, l28="drifted context\n"))
        [result] = self.run_tree([step])
        self.assertFalse(result.ok)
        self.assertEqual(len(result.problems), 1)
        self.assertIn("chrome/f.cc hunk #2", result.problems[0])
        self.assertIn("without fuzz", result.problems[0])
        text = pathlib.Path(self.tree, "chrome/f.cc").read_text()
        self.assertIn("line five\n", text)
        self.assertEqual(list(pathlib.Path(self.tree).rglob("*.rej")), [])

    def test_later_steps_still_run_after_a_failure(self):
        first = self.patch("first", after=edited(ORIGINAL, l5="line five\n"))
        second = self.patch("second", path="chrome/g.cc")
        self.write_tree(edited(ORIGINAL, l4="drift\n"))
        self.write_tree(ORIGINAL, "chrome/g.cc")
        results = self.run_tree([first, second])
        self.assertEqual([r.ok for r in results], [False, True])

    def test_missing_file_asks_for_a_repack(self):
        step = self.patch("needs-g", path="chrome/g.cc")
        missing = checker.missing_from_base([step], present={"chrome/f.cc"})
        self.assertEqual(missing, {"chrome/g.cc": "needs-g"})
        [message] = checker.missing_messages(missing)
        self.assertIn("chrome/g.cc (changed by needs-g) isn't in the series base", message)
        self.assertIn("series-base-pack.py", message)
        [result] = self.run_tree([step])
        self.assertIn("isn't in the scratch tree", result.problems[0])

    def test_a_file_a_patch_deletes_must_be_in_the_base(self):
        step = self.patch("deletes", path="chrome/gone.cc", before="bye\n", after="")
        text = pathlib.Path(step.patch).read_text().replace("+++ b/chrome/gone.cc", "+++ /dev/null")
        pathlib.Path(step.patch).write_text(text)
        required, _ = series_base.base_paths([step])
        self.assertEqual(required, {"chrome/gone.cc": "deletes"})
        recreate = self.patch("recreates", path="chrome/gone.cc", before="", after="back\n")
        text = pathlib.Path(recreate.patch).read_text().replace("--- a/chrome/gone.cc", "--- /dev/null")
        pathlib.Path(recreate.patch).write_text(text)
        required, _ = series_base.base_paths([step, recreate])
        self.assertEqual(required, {"chrome/gone.cc": "deletes"})
        required, _ = series_base.base_paths([recreate, step])
        self.assertEqual(required, {})

    def test_a_file_a_patch_creates_needs_no_base(self):
        step = self.patch("creates", path="chrome/new.cc", before="", after="hello\n")
        text = pathlib.Path(step.patch).read_text()
        text = text.replace("--- a/chrome/new.cc", "--- /dev/null")
        pathlib.Path(step.patch).write_text(text)
        self.assertEqual(checker.missing_from_base([step], present=set()), {})


class Refresh(Fixture):
    def test_refresh_moves_headers_so_the_patch_lands_exactly(self):
        step = self.patch("drifted", after=edited(ORIGINAL, l5="line five\n", l30="line thirty\n"))
        shifted = "x\ny\n" + edited(ORIGINAL, l10="", l11="")
        self.write_tree(shifted)
        [result] = self.run_tree([step])
        self.assertEqual([(o[1], o[3]) for o in result.offsets], [(1, 2)])
        expected = pathlib.Path(self.tree, "chrome/f.cc").read_text()
        before = pathlib.Path(step.patch).read_text()
        checker.refresh_offsets(step.patch, result.offsets)
        after = pathlib.Path(step.patch).read_text()
        self.assertEqual([l for l in before.splitlines() if not l.startswith("@@")],
                         [l for l in after.splitlines() if not l.startswith("@@")])
        self.write_tree(shifted)
        [again] = self.run_tree([step])
        self.assertTrue(again.ok)
        self.assertEqual(again.offsets, [])
        self.assertEqual(pathlib.Path(self.tree, "chrome/f.cc").read_text(), expected)


class SplitHunks(unittest.TestCase):
    def test_a_removed_line_that_looks_like_a_header_stays_in_its_hunk(self):
        patch = ("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n--- looks like a header\n+b\n c\n"
                 "@@ -10,2 +10,2 @@\n d\n-e\n+f\n")
        [entry] = checker.split_hunks(patch)
        self.assertEqual(entry["path"], "x")
        self.assertEqual(len(entry["hunks"]), 2)
        self.assertIn("--- looks like a header\n", entry["hunks"][0])

    def test_parse_offsets(self):
        output = "Checking patch a/b.cc...\nHunk #2 succeeded at 14 (offset -1 line).\nApplied patch a/b.cc cleanly.\n"
        self.assertEqual(checker.parse_offsets(output), [("a/b.cc", 2, 14, -1)])


class Archive(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ac-series-archive-test-")
        self.base = os.path.join(self.dir, "base")
        os.makedirs(os.path.join(self.base, "chrome"))
        pathlib.Path(self.base, "chrome/f.cc").write_text(ORIGINAL)
        pathlib.Path(self.base, "chrome/run.sh").write_text("#!/bin/sh\n")
        os.chmod(os.path.join(self.base, "chrome/run.sh"), 0o755)
        self.ident = {"platform": "linux", "cpu": "x64", "chromium": "1.2.3.4", "helium_chromium": "a" * 40,
                      "helium_platform": "b" * 40}
        self.out = os.path.join(self.dir, "archive.tar.xz")

    def tearDown(self):
        subprocess.run(["rm", "-rf", self.dir])

    def test_round_trip_keeps_content_and_modes_and_lists_absent_paths(self):
        manifest, _ = series_base.write_tarball(self.base, {"chrome/f.cc", "chrome/run.sh", "ardia/new.cc"}, self.ident,
                                                self.out)
        self.assertEqual(manifest["absent"], ["ardia/new.cc"])
        dest = os.path.join(self.dir, "out")
        os.makedirs(dest)
        got = series_base.extract(self.out, dest)
        self.assertEqual(got["chromium"], "1.2.3.4")
        self.assertEqual(pathlib.Path(dest, "chrome/f.cc").read_text(), ORIGINAL)
        self.assertTrue(os.access(os.path.join(dest, "chrome/run.sh"), os.X_OK))
        first = series_base.sha256_file(self.out)
        os.unlink(self.out)
        series_base.write_tarball(self.base, {"chrome/f.cc", "chrome/run.sh", "ardia/new.cc"}, self.ident, self.out)
        self.assertEqual(series_base.sha256_file(self.out), first)

    def test_a_directory_destination_names_the_archive_by_pins_and_content(self):
        directory = os.path.join(self.dir, "dest")
        os.makedirs(directory)
        manifest, out = series_base.write_tarball(self.base, {"chrome/f.cc"}, self.ident, directory)
        self.assertEqual(os.path.basename(out), series_base.asset_name(self.ident, series_base.content_revision(manifest)))
        pathlib.Path(self.base, "chrome/f.cc").write_text(ORIGINAL + "captured later\n")
        other = os.path.join(self.dir, "dest2")
        os.makedirs(other)
        _, second = series_base.write_tarball(self.base, {"chrome/f.cc"}, self.ident, other)
        self.assertNotEqual(os.path.basename(second), os.path.basename(out))

    def test_symlinks_are_neither_packed_nor_extracted(self):
        os.symlink("f.cc", os.path.join(self.base, "chrome/link.cc"))
        with self.assertRaises(series_base.Problem):
            series_base.write_tarball(self.base, {"chrome/link.cc"}, self.ident, self.out)
        manifest = dict(self.ident, format=series_base.FORMAT, files={"chrome/link.cc": {"sha256": "0" * 64}}, absent=[])
        body = json.dumps(manifest).encode()
        with tarfile.open(self.out, "w:xz") as tar:
            info = tarfile.TarInfo("manifest.json")
            info.size = len(body)
            tar.addfile(info, io.BytesIO(body))
            link = tarfile.TarInfo("src/chrome/link.cc")
            link.type, link.linkname = tarfile.SYMTYPE, "../../outside"
            tar.addfile(link)
        self.extract_fails("isn't a regular file")

    def test_an_archive_without_a_manifest_is_a_clear_error(self):
        with tarfile.open(self.out, "w:xz") as tar:
            info = tarfile.TarInfo("src/x")
            tar.addfile(info, io.BytesIO(b""))
        self.extract_fails("isn't a series base archive")

    def write_raw(self, files, entries):
        manifest = dict(self.ident, format=series_base.FORMAT, files=files, absent=[])
        body = json.dumps(manifest).encode()
        with tarfile.open(self.out, "w:xz") as tar:
            info = tarfile.TarInfo("manifest.json")
            info.size = len(body)
            tar.addfile(info, io.BytesIO(body))
            for name, data in entries:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))

    def extract_fails(self, needle):
        dest = os.path.join(self.dir, "out")
        os.makedirs(dest, exist_ok=True)
        with self.assertRaises(series_base.Problem) as caught:
            series_base.extract(self.out, dest)
        self.assertIn(needle, str(caught.exception))

    def test_a_tampered_file_is_refused(self):
        self.write_raw({"chrome/f.cc": {"sha256": "0" * 64, "mode": "644"}}, [("src/chrome/f.cc", b"evil")])
        self.extract_fails("sha256")

    def test_a_path_that_leaves_the_tree_is_refused(self):
        self.write_raw({"../escape": {"sha256": "0" * 64, "mode": "644"}}, [("src/../escape", b"x")])
        self.extract_fails("unsafe")

    def test_an_entry_missing_from_the_manifest_is_refused(self):
        self.write_raw({}, [("src/chrome/extra.cc", b"x")])
        self.extract_fails("isn't in its manifest")


class Pins(unittest.TestCase):
    def test_identity_comes_from_env_sh_and_helium_pins(self):
        ident = series_base.identity("linux")
        self.assertEqual(ident["cpu"], "x64")
        self.assertRegex(ident["helium_platform"], r"^[0-9a-f]{40}$")
        self.assertEqual(series_base.asset_name(ident, "0123456789ab"),
                         f"series-base-{ident['chromium']}-{ident['helium_chromium'][:12]}-linux-"
                         f"{ident['helium_platform'][:12]}-x64-0123456789ab.tar.xz")

    def test_mismatched_pins_are_refused(self):
        with tempfile.TemporaryDirectory() as build:
            pathlib.Path(build, "env.sh").write_text("export CHROMIUM_VERSION=1.2.3.4\n")
            pathlib.Path(build, "helium-pins.ini").write_text("[chromium]\nversion = 1.2.3.5\n")
            with self.assertRaises(series_base.Problem):
                series_base.pins(build)

    def test_every_table_row_names_its_pins(self):
        for row in series_base.read_table():
            ident = {k: row[k] for k in ("platform", "cpu", "chromium", "helium_chromium", "helium_platform")}
            self.assertTrue(row["asset"].startswith(series_base.asset_prefix(ident)), row["asset"])
            self.assertRegex(row["asset"][len(series_base.asset_prefix(ident)):], r"^[0-9a-f]{12}\.tar\.xz$")
            self.assertEqual(row["tag"], series_base.tag_name(ident))
            self.assertRegex(row["sha256"], r"^[0-9a-f]{64}$")

    def test_the_current_pins_have_a_published_base(self):
        for platform in ("linux", "mac"):
            self.assertIsNotNone(series_base.find_row(series_base.identity(platform)),
                                 f"no series-bases.tsv row for {platform} at the current pins: run series-base-pack.py")


class RealSeries(unittest.TestCase):
    def test_every_patch_path_is_safe_to_pack(self):
        series = series_base.load_series()
        for platform in ("linux", "mac"):
            required, optional = series_base.base_paths(series.read_series(platform))
            self.assertTrue(required)
            for path in list(required) + list(optional):
                self.assertTrue(series_base.safe_relative(path), path)


if __name__ == "__main__":
    unittest.main()
