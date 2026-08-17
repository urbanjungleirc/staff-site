# What schools actually send us

Answer to [staff-site#48](https://github.com/urbanjungleirc/staff-site/issues/48),
part of the school-group booking map ([#46](https://github.com/urbanjungleirc/staff-site/issues/46)).

Three real lists, from three different schools, were examined on 2026-08-17.
**Everything below is structural.** The real files stay in `uj/private-archive`
and never enter this repo — no real student name, DOB or school name appears
here or in the fixtures beside it. They were inspected with `shape-report.py`
in this directory, which prints character-class patterns (`A A`, `9/9/9`) and
never a value, so the lists could be described without being read.

| | Format | Students | Fields |
|---|---|---|---|
| List 1 | plain text, **one field per line** | 21 | 6 |
| List 2 | `.xlsx` | 63 | 3 |
| List 3 | `.pdf` exported from Word | 18 | 3 |

Fixtures reproducing each shape, with invented data, are beside this file:
`fixture-1-vertical.txt`, `fixture-2-spreadsheet.tsv`, `fixture-3-word-table.txt`.

---

## The finding that matters most

**A pasted list is not necessarily tab-separated.** #46 decided that "copying a
selection out of Excel or Google Sheets already puts tab-separated text on the
clipboard, so one paste box covers xls, csv and typed lists with no file
parsing."

List 1 is a counter-example that already happened. It contains **no tab and no
comma at all** — every field sits on its own line, six lines per student, with a
six-line header block in front:

```
PreferredName
LastName
Dob
FormGroup
YearLevel
Email
<student 1 preferred name>
<student 1 last name>
...
```

That is what copying out of a web-based school system (rather than a
spreadsheet) produces. The paste-box decision survives — a paste box still
covers it — but **a parser that assumes one row per line silently reads 126
students out of 21**, and a header-detection rule that looks at "the first line"
finds a single word.

So the parsing rules ticket ([#52](https://github.com/urbanjungleirc/staff-site/issues/52))
needs a **layout detection step before field splitting**: is this one record per
line, or one *field* per line? The signal is reliable — if no line contains a
tab, two or more spaces, or a comma, and the line count is an exact multiple of
a small field count, it is vertical.

## Names

All three lists give **first and last name in separate fields**. None used
`Fernsby, Katie`, and none used a single `Katie Fernsby` column. That is a narrower
range than #48 anticipated, and it is worth not over-building for.

What does vary, and will break a naive split:

| Shape | Seen | Consequence |
|---|---|---|
| First name containing a space | 3 of 63 in list 2 | `split(/\s+/)` puts the second word in the wrong field |
| Surname containing a space | 1 of 63 | same |
| Hyphenated surname | 1 of 63 | fine if the delimiter is right |
| Apostrophe in surname | 1 in list 2, 1 in list 3 | must survive to the Clubworx query unescaped |

In list 3 the columns are aligned with **runs of 2–8 spaces** and nothing else —
no tab, no comma. Combined with the row above, this settles a rule: split on
**two or more** spaces, never on single whitespace.

### `PreferredName` is not the legal name

List 1's first column is headed **`PreferredName`**, not "First name". A school
system storing a preferred name means the list can carry *Katie* where Clubworx,
populated from a waiver or a membership form, holds *Katherine*.

This lands directly on #46's identity rule — "surname + DOB narrows the
candidate set; the first name breaks ties". Surname and DOB are unaffected, so
the rule holds, but **the tie-breaker is weaker than it looks**: a first-name
mismatch is now an expected outcome for a correct match, not a signal of a wrong
one. Twins remain the case the first name has to settle, and that is exactly the
case where a preferred name is least reliable.

## Dates of birth

**Both text lists are `d/m/yyyy`, unpadded, four-digit year** — and this is
proven rather than assumed: 14 of 21 dates in list 1 and 10 of 18 in list 3 have
a first field greater than 12, while **no date in either has a second field
greater than 12**.

The important consequence is the other side of that count: the remaining 7 and 8
dates are individually ambiguous — `5/3/2011` could be either orientation. So:

> Infer date orientation **once per pasted list**, from every date in it, and
> apply it to all rows. Never decide row by row.

If a whole list is ambiguous (small, or unlucky), that is a question for the
staff member, not a guess. Getting it wrong silently converts a March birthday
into May and quietly fails to match a student who is in fact in Clubworx.

**List 2 stores DOB as raw Excel serial numbers** — the 63 values run 40365 to
40731, which is 2010-07-06 to 2011-07-07 on the 1899-12-30 epoch, a plausible
Year 10 cohort. Worth being precise about when this bites: the serial is a
property of the *file*. Copying those cells to the clipboard yields the
*displayed* value, so the paste path would receive formatted dates — whose
format depends on the sender's locale, which is why the orientation rule above
is not optional. A five-digit integer in a DOB column should still be handled,
because it is what arrives the day anyone pastes from a tool that emits raw
values, or the day file upload is added.

## Junk to skip

Everything actually seen, so the rules can be specific rather than defensive:

| Junk | Where | Note |
|---|---|---|
| School name as a title line | list 3, line 1 | Leading indent, no date, not tabular |
| A prose sentence | list 3 | "List of students attending weekly Rock Climbing at Urban Jungle on Wednesdays." |
| Header row | all three | `First Name / Surname / DOB`, `First name / Surname / Birth date`, and list 1's six-line vertical block |
| Blank lines | lists 1 and 3 | Including between the header and the first record |
| Phantom empty columns | list 2 | Styled but empty cells at columns **J** and **W** make rows report as 5–7 wide when only 3 hold data |

One of those does **not** appear in the fixtures, and cannot: the phantom
columns arrive as *trailing tabs*, and trailing whitespace does not survive
being committed and reviewed — it would be invisible in the file and stripped
by half the tools that touch it. A parser test has to build that case itself:

```js
const withPhantomColumns = fixture.split('\n').map(l => l + '\t\t\t').join('\n');
```

Worth doing, because trailing empty fields are what turn "this list has 3
columns" into "this list has 6 columns, three of them blank" — and a
column-count heuristic is the obvious way to detect a header.

**Not** seen in any of the three: totals rows, merged cells (list 2 has zero
merged ranges), footnotes, medical notes, or consent flags. Those remain
possible but there is no evidence to design against yet.

The nearest thing to a non-student row is list 1's `FormGroup` column, which
holds a **teacher's surname** for 20 of 21 students and a class code of the form
`G10-4` for the twenty-first — a column that is inconsistent with itself inside a single list.
Nothing in this system needs `FormGroup`, so it is only a warning about
assuming any column is uniform.

## Extra columns

Beyond first name, surname and DOB, only list 1 carried anything: `FormGroup`
(teacher surname), `YearLevel` (`10` for every row), and `Email` — a school-issued
student address, present for all 21.

That email is worth flagging for [#49](https://github.com/urbanjungleirc/staff-site/issues/49)
and the marking scheme. #46 settled on writing
`noreply+<school>@urbanjungleirc.com` into the email field as the school marker
and search key. When a real student email is available, the two uses collide:
the marker is what makes the record findable as this tool's work, and the real
address is what a school might expect to be stored. The marker should win —
but this is the first evidence that a real address will sometimes be sitting
there unused, and someone will eventually ask why.

## Sizes

21, 63 and 18 students. At the pacing measured in
[#51](https://github.com/urbanjungleirc/staff-site/issues/51) — 75 requests per
minute, one in flight — the 63-student list is the one to design the progress
indicator around, not the 20-name case.
