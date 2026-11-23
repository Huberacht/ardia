#!/usr/bin/env python3
import pathlib
import re
import unittest

REPO = pathlib.Path(__file__).resolve().parents[4]
SERIES = REPO / 'engine/patches/series'
PATCHES = REPO / 'engine/patches'
SERIES_WIN = REPO / 'scripts/windows/engine/series-win'
WIN_PATCHES = REPO / 'scripts/windows/engine/patches'
ENGINE_DOC = REPO / 'docs/engine-build.md'
WINDOWS_DOC = REPO / 'docs/engine-build-windows.md'

ENGINE_HEADER = ('Patch', 'What it does', 'Removable when')
WINDOWS_HEADER = ('Patch', 'Line', 'What it does', 'Removable when')
PATCH_CELL = re.compile(r'^`([^`\s]+\.patch)`$')
UNESCAPED_PIPE = re.compile(r'(?<!\\)\|')


def series_entries(text, kinds):
    entries = []
    for number, raw in enumerate(text.splitlines(), 1):
        fields = raw.split('#', 1)[0].split()
        if fields and fields[0] in kinds:
            entries.append((fields[0], fields[1], number))
    return entries


def cells(row):
    return [cell.strip() for cell in UNESCAPED_PIPE.split(row.strip().removeprefix('|').removesuffix('|'))]


def table(doc_text, header, where):
    lines = doc_text.splitlines()
    starts = [n for n, line in enumerate(lines) if line.startswith('|') and tuple(cells(line)) == header]
    if len(starts) != 1:
        return None, [f'{where}: expected one table headed `| {" | ".join(header)} |`, found {len(starts)}']
    rows, problems = [], []
    n = starts[0] + 2
    while n < len(lines) and lines[n].startswith('|'):
        row = cells(lines[n])
        if len(row) != len(header):
            problems.append(f'{where}:{n + 1}: {len(row)} cells where the table has {len(header)} (a `|` inside a cell?)')
        else:
            match = PATCH_CELL.match(row[0])
            if not match:
                problems.append(f'{where}:{n + 1}: the first cell is not one `<name>.patch` in backticks: {row[0]}')
            else:
                rows.append((match.group(1), dict(zip(header, row)), n + 1))
        n += 1
    return rows, problems


def duplicates(rows, where):
    seen, problems = {}, []
    for name, _, line in rows:
        if name in seen:
            problems.append(f'{where}:{line}: `{name}` already has a row at line {seen[name]}')
        seen.setdefault(name, line)
    return problems


def empty_cells(rows, columns, where):
    return [f'{where}:{line}: `{name}` has an empty {column}'
            for name, row, line in rows for column in columns if not row[column]]


def engine_problems(series_text, doc_text, patch_files, where='docs/engine-build.md'):
    rows, problems = table(doc_text, ENGINE_HEADER, where)
    if rows is None:
        return problems
    listed = {name for _, name, _ in series_entries(series_text, ('chromium',))}
    documented = {name for name, _, _ in rows}
    problems += duplicates(rows, where)
    problems += empty_cells(rows, ('What it does', 'Removable when'), where)
    for name in sorted(listed - documented):
        problems.append(f'{where}: `{name}` is in engine/patches/series but has no row')
    for name, _, line in rows:
        if name not in listed:
            problems.append(f'{where}:{line}: `{name}` is not a chromium line of engine/patches/series')
        elif name not in patch_files:
            problems.append(f'{where}:{line}: `{name}` is not in engine/patches')
    return problems


def windows_problems(series_win_text, series_text, doc_text, win_patch_files, where='docs/engine-build-windows.md'):
    rows, problems = table(doc_text, WINDOWS_HEADER, where)
    if rows is None:
        return problems
    lines = {name: kind for kind, name, _ in series_entries(series_win_text, ('chromium', 'skip'))}
    shared = {name for _, name, _ in series_entries(series_text, ('chromium',))}
    documented = {name for name, _, _ in rows}
    problems += duplicates(rows, where)
    problems += empty_cells(rows, ('What it does', 'Removable when'), where)
    for name in sorted(set(lines) - documented):
        problems.append(f'{where}: `{lines[name]} {name}` is in series-win but has no row')
    for name in sorted(win_patch_files - set(lines)):
        problems.append(f'scripts/windows/engine/patches/{name} has no line in series-win')
    for name, row, line in rows:
        kind = lines.get(name)
        if kind is None:
            problems.append(f'{where}:{line}: `{name}` is not a line of series-win')
            continue
        if row['Line'] != kind:
            problems.append(f'{where}:{line}: `{name}` says `{row["Line"]}` where series-win has `{kind}`')
        if kind == 'chromium' and name not in win_patch_files:
            problems.append(f'{where}:{line}: `{name}` is not in scripts/windows/engine/patches')
        if kind == 'skip' and name not in shared:
            problems.append(f'{where}:{line}: `{name}` skips nothing in engine/patches/series')
    return problems


def patch_names(directory):
    return {path.name for path in directory.glob('*.patch')}


ENGINE_DOC_SAMPLE = '''# Doc

| Patch | What it does | Removable when |
|---|---|---|
| `chromium-a.patch` | Does a | Upstream fixes a |
| `chromium-b.patch` | Does b | Never: Ardia feature |

After.
'''

WINDOWS_DOC_SAMPLE = '''| Patch | Line | What it does | Removable when |
|---|---|---|---|
| `chromium-b.patch` | skip | Mac only | With the Mac patch |
| `chromium-win-c.patch` | chromium | Does c | Never |
'''


class RealDocs(unittest.TestCase):
    def test_every_series_patch_has_a_row_saying_when_it_can_go(self):
        problems = engine_problems(SERIES.read_text(encoding='utf-8'), ENGINE_DOC.read_text(encoding='utf-8'),
                                   patch_names(PATCHES))
        self.assertEqual(problems, [], '\n' + '\n'.join(problems))

    def test_every_series_win_line_has_a_row_saying_when_it_can_go(self):
        problems = windows_problems(SERIES_WIN.read_text(encoding='utf-8'), SERIES.read_text(encoding='utf-8'),
                                    WINDOWS_DOC.read_text(encoding='utf-8'), patch_names(WIN_PATCHES))
        self.assertEqual(problems, [], '\n' + '\n'.join(problems))


class EngineChecker(unittest.TestCase):
    series = 'chromium chromium-a.patch\nchromium chromium-b.patch mac\nlayer engine/chromium\n'
    files = {'chromium-a.patch', 'chromium-b.patch'}

    def test_a_complete_table_passes(self):
        self.assertEqual(engine_problems(self.series, ENGINE_DOC_SAMPLE, self.files, 'doc'), [])

    def test_a_patch_without_a_row_fails(self):
        problems = engine_problems(self.series + 'chromium chromium-new.patch linux\n', ENGINE_DOC_SAMPLE,
                                   self.files | {'chromium-new.patch'}, 'doc')
        self.assertEqual(problems, ['doc: `chromium-new.patch` is in engine/patches/series but has no row'])

    def test_an_empty_removable_when_fails(self):
        doc = ENGINE_DOC_SAMPLE.replace('Upstream fixes a', '')
        self.assertEqual(engine_problems(self.series, doc, self.files, 'doc'),
                         ['doc:5: `chromium-a.patch` has an empty Removable when'])

    def test_a_row_for_a_removed_patch_fails(self):
        problems = engine_problems('chromium chromium-a.patch\n', ENGINE_DOC_SAMPLE, {'chromium-a.patch'}, 'doc')
        self.assertEqual(problems, ['doc:6: `chromium-b.patch` is not a chromium line of engine/patches/series'])

    def test_a_listed_patch_missing_from_disk_fails(self):
        problems = engine_problems(self.series, ENGINE_DOC_SAMPLE, {'chromium-a.patch'}, 'doc')
        self.assertEqual(problems, ['doc:6: `chromium-b.patch` is not in engine/patches'])

    def test_a_commented_line_is_not_in_the_series(self):
        problems = engine_problems('chromium chromium-a.patch\n# chromium chromium-b.patch\n', ENGINE_DOC_SAMPLE,
                                   self.files, 'doc')
        self.assertEqual(problems, ['doc:6: `chromium-b.patch` is not a chromium line of engine/patches/series'])

    def test_a_pipe_inside_a_cell_fails(self):
        doc = ENGINE_DOC_SAMPLE.replace('Does a', 'Does a | b')
        self.assertIn('doc:5: 4 cells where the table has 3 (a `|` inside a cell?)',
                      engine_problems(self.series, doc, self.files, 'doc'))

    def test_an_escaped_pipe_stays_in_its_cell(self):
        doc = ENGINE_DOC_SAMPLE.replace('Does a', 'Does `a\\|b`')
        self.assertEqual(engine_problems(self.series, doc, self.files, 'doc'), [])

    def test_a_duplicate_row_fails(self):
        doc = ENGINE_DOC_SAMPLE.replace('\nAfter.', '| `chromium-a.patch` | Again | Later |\n\nAfter.')
        self.assertEqual(engine_problems(self.series, doc, self.files, 'doc'),
                         ['doc:7: `chromium-a.patch` already has a row at line 5'])

    def test_a_missing_table_fails(self):
        self.assertEqual(engine_problems(self.series, '# Doc\n', self.files, 'doc'),
                         ['doc: expected one table headed `| Patch | What it does | Removable when |`, found 0'])


class WindowsChecker(unittest.TestCase):
    series = 'chromium chromium-a.patch\nchromium chromium-b.patch mac\n'
    series_win = 'skip chromium-b.patch\nchromium chromium-win-c.patch\n'
    files = {'chromium-win-c.patch'}

    def check(self, series_win=None, doc=WINDOWS_DOC_SAMPLE, files=None, series=None):
        return windows_problems(self.series_win if series_win is None else series_win,
                                self.series if series is None else series, doc,
                                self.files if files is None else files, 'doc')

    def test_a_complete_table_passes(self):
        self.assertEqual(self.check(), [])

    def test_a_line_without_a_row_fails(self):
        self.assertEqual(self.check(series_win=self.series_win + 'chromium chromium-win-d.patch\n',
                                    files=self.files | {'chromium-win-d.patch'}),
                         ['doc: `chromium chromium-win-d.patch` is in series-win but has no row'])

    def test_a_patch_file_without_a_line_fails(self):
        self.assertEqual(self.check(files=self.files | {'chromium-win-e.patch'}),
                         ['scripts/windows/engine/patches/chromium-win-e.patch has no line in series-win'])

    def test_an_empty_removable_when_fails(self):
        self.assertEqual(self.check(doc=WINDOWS_DOC_SAMPLE.replace('With the Mac patch', '')),
                         ['doc:3: `chromium-b.patch` has an empty Removable when'])

    def test_a_row_for_a_removed_line_fails(self):
        self.assertEqual(self.check(series_win='chromium chromium-win-c.patch\n'),
                         ['doc:3: `chromium-b.patch` is not a line of series-win'])

    def test_a_wrong_line_kind_fails(self):
        self.assertEqual(self.check(doc=WINDOWS_DOC_SAMPLE.replace('| skip |', '| chromium |')),
                         ['doc:3: `chromium-b.patch` says `chromium` where series-win has `skip`'])

    def test_a_skip_of_nothing_fails(self):
        self.assertEqual(self.check(series='chromium chromium-a.patch\n'),
                         ['doc:3: `chromium-b.patch` skips nothing in engine/patches/series'])

    def test_a_windows_patch_missing_from_disk_fails(self):
        self.assertEqual(self.check(files=set()),
                         ['doc:4: `chromium-win-c.patch` is not in scripts/windows/engine/patches'])


if __name__ == '__main__':
    unittest.main()
