#!/usr/bin/env python3
"""Describe a school participant list without revealing anything in it.

    python shape-report.py <path> [txt|xlsx]

Every value is masked to a character-class pattern before it is printed —
letters collapse to `A`, digit runs to `9`, separators are kept. So
`Fernsby, Katie` prints as `A, A` and `23/4/2010` as `9/9/9`. Identical rows
collapse into one line with a count, which is exactly the description
staff-site#48 asks for.

The point is not tidiness. staff-site is a **public repo** and #46 forbids a
real student name, DOB or school name reaching any part of it — including an
agent's terminal output on the way to writing a summary. Masking at the source
means a list can be described by someone, or something, that never read it.

Real lists live in `uj/private-archive`. Run this from there; commit nothing
from there. What belongs in this repo is the *output's shape*, written up by
hand in README.md, and fixtures with invented data.

Reads .txt/.csv/.tsv directly, and .xlsx without any dependency (an xlsx is a
zip of XML). For .pdf, convert first:

    pdftotext -layout list.pdf list.txt
"""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
MAIN = f'{{{NS["m"]}}}'


def mask(value):
    """The only function that ever sees a value, and it returns a shape."""
    if value is None:
        return ''
    s = re.sub(r'[A-Za-zÀ-ɏ]+', 'A', str(value).strip())
    return re.sub(r'\d+', '9', s)


def read_delimited(path):
    raw = open(path, encoding='utf-8-sig', errors='replace').read()
    lines = raw.split('\n')
    tabs = sum(1 for l in lines if '\t' in l)
    commas = sum(1 for l in lines if ',' in l)
    gaps = sum(1 for l in lines if re.search(r'\S {2,}\S', l))

    print(f'file: {path}')
    print(f'lines: {len(lines)} (blank: {sum(1 for l in lines if not l.strip())})')
    print(f'lines with a tab: {tabs} | a comma: {commas} | a 2+ space gap: {gaps}')

    if tabs > len(lines) / 3:
        delim, label = '\t', 'tab'
    elif commas > len(lines) / 3:
        delim, label = ',', 'comma'
    elif gaps > len(lines) / 3:
        delim, label = None, 'runs of 2+ spaces'
    else:
        delim, label = None, 'NONE — every field may be on its own line (vertical)'
    print(f'delimiter: {label}\n')

    rows = []
    for l in lines:
        if not l.strip():
            continue
        rows.append(l.split(delim) if delim else re.split(r' {2,}', l.strip()))
    return rows


def read_xlsx(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            shared.append(''.join(t.text or '' for t in si.iter(f'{MAIN}t')))

    sheets = sorted(n for n in z.namelist() if n.startswith('xl/worksheets/sheet'))
    root = ET.fromstring(z.read(sheets[0]))
    merged = root.find('m:mergeCells', NS)

    print(f'file: {path}')
    print(f'sheets: {len(sheets)} (reading {sheets[0]})')
    print(f'merged cell ranges: {len(merged) if merged is not None else 0}\n')

    rows = []
    for row in root.iter(f'{MAIN}row'):
        cells = []
        for c in row.findall('m:c', NS):
            t, v = c.get('t'), c.find('m:v', NS)
            if t == 's' and v is not None:
                cells.append(shared[int(v.text)])
            elif t == 'inlineStr':
                cells.append(''.join(x.text or '' for x in c.iter(f'{MAIN}t')))
            elif v is not None:
                # A bare number in a DOB column is an Excel date serial. Kept
                # distinguishable from text, because that difference is the
                # whole point of looking.
                cells.append(f'<num:{v.text}>')
            else:
                cells.append('')
        rows.append(cells)
    return rows


def report(rows):
    print(f'rows with content: {len(rows)}')
    widths = Counter(len(r) for r in rows)
    print(f'fields per row: {dict(sorted(widths.items()))}')

    shapes = Counter(' | '.join(mask(c) for c in r) for r in rows)
    print(f'\ndistinct row shapes: {len(shapes)}')
    for shape, n in shapes.most_common(40):
        print(f'  {n:4d} x  {shape[:150]}')

    # Per column, because a totals row, a teacher row or one stray code hides
    # as a minority shape in an otherwise uniform column.
    print('\nper-column shapes (top 4):')
    for i in range(max(widths) if widths else 0):
        col = Counter(mask(r[i]) for r in rows if i < len(r) and str(r[i]).strip())
        blank = sum(1 for r in rows if i >= len(r) or not str(r[i]).strip())
        top = ', '.join(f'{s or "(empty)"}x{n}' for s, n in col.most_common(4))
        print(f'  col {i}: {top}   [blank/missing: {blank}]')

    # Orientation has to be decided per list, never per row: most d/m dates are
    # individually ambiguous, and the whole set is what disambiguates them.
    dates = [m for r in rows for c in r
             for m in re.findall(r'\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b', str(c))]
    if dates:
        first_over_12 = sum(1 for a, _, _ in dates if int(a) > 12)
        second_over_12 = sum(1 for _, b, _ in dates if int(b) > 12)
        print(f'\nslash dates: {len(dates)}')
        print(f'  first field > 12:  {first_over_12}  (proves day-first)')
        print(f'  second field > 12: {second_over_12}  (proves month-first)')
        print(f'  individually ambiguous: {len(dates) - first_over_12 - second_over_12}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    kind = sys.argv[2] if len(sys.argv) > 2 else ('xlsx' if path.endswith('.xlsx') else 'txt')
    report(read_xlsx(path) if kind == 'xlsx' else read_delimited(path))
