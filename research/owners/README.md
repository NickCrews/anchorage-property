# Answer keys: owner type and voter match

This folder holds two small CSV files. Each row carries a label that we added
by hand. We use the files to measure how well a program can answer two
questions about a parcel:

1. What kind of thing owns it — a person, a company, a trust?
2. Which registered Alaska voter is the owner?

| File | Rows | One row is |
|------|-----:|------------|
| [`owner_type.csv`](owner_type.csv) | 300 | one parcel, with a label for the kind of owner |
| [`voter_match.csv`](voter_match.csv) | 230 | one person named on a parcel (150 parcels, split into the people they name), with a label for the voter match |

## Why these files exist

For about 51,000 parcels, the lake already tells you the kind of owner, and it
costs nothing to find out. A parcel with a church exemption is owned by a
church. See
[notebooks/owner_type_from_exemptions.py](../../notebooks/owner_type_from_exemptions.py).
For the other ~47,000 parcels there is no exemption to read, so a program must
guess from the owner name.

There is an easy mistake here, and the exemption notebooks hit it again and
again: **the parcels you score on are not the parcels you use the program on.**
You can test a program on the 51,000 parcels that already carry a label, get a
high score, and believe the program is good. But nobody needs the program on
those parcels. They need it on the 47,000 parcels with no label, and those
parcels are different — they are the hard ones that were left over. A high
score on the easy group tells you nothing about the hard group.

So we took both samples from the unlabeled group only, never from the labeled
one. For the full argument, see the section "Where a model goes" in
[notebooks/owner_type_from_names.py](../../notebooks/owner_type_from_names.py).
Issue #9 holds the model of owner identity that these files use.

## Warning: a model wrote these labels, not a person

**Claude (Opus 4.8) wrote every label.** No independent human wrote or checked
them.

If you test a model against labels that a model wrote, you measure how much two
models agree. You do not measure how often they are correct. Use the files with
that in mind:

- Read them as a good first draft that makes human review quick — not as the
  truth. Every row has a `confidence` column and a `notes` column, so a
  reviewer can go directly to the doubtful rows.
- **Look at the `low` and `medium` rows first.** For example: a voter with the
  same rare name but a different address; a co-owner who registered under a
  different surname; a trust name that the source cut short; an institution
  whose name does not say what it is. The `high` rows are almost mechanical —
  the name and the address agree exactly, or the name contains a word such as
  `LLC`.
- If you publish a score against these files, say that a model wrote the
  labels. Do not call them the truth.

## How we count owners (issue #9)

A parcel does not have one owner. The `owner_name` field frequently names more
than one person:

```
SMITH JOHN & JANE
```

That is two people, not one. We cut the name into one row for each person:

```
1  SMITH JOHN
2  SMITH JANE      <- we took the surname from the person before
```

Each person then gets their own share of the property and their own link to the
voter file. This is why we do not keep the two names together as one group
record: a voter link belongs to one person, and you cannot attach it to a
group.

Each owner gets two labels:

- **`kind`** — one of `person`, `org`, `trust` or `other`. Empty means "we do
  not know". A trust is its own kind, and a trust never gets a voter link.
- **`org_category`** — more detail about an org: `government`, `native_corp`,
  `nonprofit`, `hoa` or `business`. Empty unless `kind` is `org`.

We would rather miss a true match than make a false one. The lake makes the
owner-to-voter link public, so a false match is a public statement about a real
person: it says that this named voter owns this address. Therefore we accept a
match only when the address agrees as well as the name.

## How we chose the rows

We did not use a random number generator, and we did not use `USING SAMPLE`.
Both of those can give you different rows on a different DuckDB version, or
when the rows arrive in a different order. Instead we sort the parcels by a
hash of the parcel ID, and take the first N:

```sql
... ORDER BY hash(parcel_id || '<salt>') LIMIT <n>
```

The salt is a fixed text, different for each sample, which is what makes the
two samples different from each other. The order never changes, so anyone can
get the same rows again.

The two salts are `gold-owner-type-v1` and `gold-voter-match-v1`. They still
start with `gold-` because this folder used to be called `gold/`. **Do not
rename them to match the folder.** The salt is fed to `hash()`, so changing
one character changes which parcels the sample holds, and the CSV files in
this folder would no longer be the rows the code draws.

The data is from **2026-07-15**: the `workspaces/default/anchorage.duckdb` lake
and the Alaska state voter file `sources/voterfile.csv` (~600k voters). Neither
of those files is in git — you must get them again yourself — so the CSV files
in this folder are the part that lasts. [`check.py`](check.py) takes the
samples again and makes sure they still agree with the CSV files.

### `owner_type.csv` — the leftover parcels

The pool is the parcels that are left over, which the code calls the
**residual**. A parcel is in the pool if the exemption rules gave it no owner
type, and its cleaned `owner_name`:

- has no company word in it (`LLC`, `INC`, `CORP`, `LP`, `LTD`), and
- has no trust word in it (`TRUST`, `TR`, `TRS`, `TTE`, `TTES`, `TRUSTEE`), and
- is not the placeholder text `PROPERTY OWNER OF RECORD`.

These are exactly the parcels where a program must do the work, from the
"needs a model" group in `owner_type_from_names.py`.

```sql
clean = trim(regexp_replace(regexp_replace(owner_name,
          '\s(%\s*[A-Z]|C/O\s|C\\O\s|ATTN:?\s).*$', ''), '\s{2,}', ' ', 'g'))
residual = categorize_by_exemption(parcels_current) WHERE owner_type IS NULL
  AND clean <> 'PROPERTY OWNER OF RECORD'
  AND NOT regexp_matches(clean, '(^| )(LLC|INC|CORP|LP|LTD)(\.|,|$| )')
  AND NOT contains(clean, 'TRUST')
  AND NOT regexp_matches(clean, '(^| )(TR|TRS|TTE|TTES|TRUSTEE)(\.|,|/|$| )')
```

The pool holds **31,379** parcels. From it we took `n = 300` with the salt
`gold-owner-type-v1`. The columns are `parcel_id, owner_name,
owner_name_clean, kind, org_category, confidence, notes`. What we found:

| kind / org_category | n | notes |
|---------------------|--:|-------|
| person | 275 | almost all the leftover parcels are a plain personal name |
| trust | 7 | trust names that the word filter did not catch, because the source cut them short or shortened them (`LIVING T`, `REVOCABLE`, `TRST`). Trusts are still in the pool |
| org / business | 9 | includes two more escapes: `CORPORATION` (the filter looks for `CORP` as a whole word only) and `L P` written with a space |
| org / government | 3 | Municipality of Anchorage ×2; one is probably the Alaska Railroad (`ARR`) |
| org / nonprofit | 2 | both `low` — a low-cost housing company and an insurance pool for public bodies |
| org / hoa | 2 | |
| org / native_corp | 1 | Bering Straits Native Corporation (also an escape through `CORPORATION`) |
| other | 1 | the estate of a dead person |

Two calls could have gone the other way, and both rows say so:

- A living trust or revocable trust named after a person → we wrote
  `kind=trust`, because issue #9 makes a trust its own kind.
- A sole trader with a "doing business as" name → we wrote `kind=person`,
  because the legal owner is a real person.

Note that nothing in the muni data can tell you whether `business` is correct.
A human can only look at each one and judge.

### `voter_match.csv` — the owners that look like people

We start from the same leftover pool and keep the owner names that look like a
person: the name must start with a word of letters, and it must contain none of
a long list of business and institution words (`LLC`, `CHURCH`, `ESTATES`,
`SCHOOL`, `BANK`, `AUTHORITY`, and many more). Then we cut each name into its
people, as shown above.

This test is rough, and it makes two kinds of error on purpose:

- It throws away the rare real person whose surname contains one of the words.
- It lets an institution through now and then. The row for
  `SECRETARY OF VETERANS AFFAIRS` is an example. We kept those rows, because
  they test that a program can say "this is not a person".

The pool holds **29,412** parcels, one owner name each. From it we took
`n = 150` parcels with the salt `gold-voter-match-v1`, and those became **230
person rows**. The columns:

| column | what it means |
|--------|---------------|
| `parcel_id`, `owner_name_clean` | the parcel, and its full cleaned owner text |
| `person_idx`, `person_name` | one person out of that text (the first person is 1) |
| `share` | the part of the property this person owns, as the source gives it (`0.5`, `1/3`). Empty if the source does not say (joint tenancy) |
| `name_inferred` | `true` if we took the surname from the person before, as with `SMITH JANE`. Issue #9 says these rows can need more proof than the others |
| `kind` | `person`, `org` and so on. An org or a trust gets no voter link |
| `label` | `match`, `no_match` or `ambiguous` |
| `matched_ascension` | the `ASCENSION` number from the voter file. This is the number that identifies one voter. (`UN` is a status code, not an identifier.) Empty unless the label is `match` |
| `confidence`, `notes` | help for the reviewer |

For each person we looked for voters in two ways, then compared the name and
the address:

1. **By surname** — the voter `LAST_NAME` is exactly the same.
2. **By address** — the voter lives at the parcel address, after we make both
   addresses look the same. This finds an owner who lives on their own parcel,
   whatever their surname is.

The result: **191 match** (127 high, 58 medium, 6 low), **29 no_match** (9
high, 20 medium) and **10 ambiguous**. So many owners match because Alaska
signs people up to vote when they apply for the Permanent Fund Dividend.

Four kinds of row are worth keeping, because each one shows a different
problem:

1. **The owner lives outside Alaska.** The voter file holds Alaska voters only,
   so an owner who gets mail in another state cannot be in it.
2. **An institution got through the filter** — the Veterans Affairs row, which
   we labeled `kind=org`. There is no person to match.
3. **The address agrees but the person does not.** The owner lives in another
   state, and their relatives live in the property they own (`01914105000`,
   `05021165000`). We labeled these `no_match`: the voter at that address is
   not the owner.
4. **The surname changed.** A co-owner registered to vote under their partner's
   surname (`BYRNE ASHLEY` is the voter `ASHLEY ROERICK`; `CRABTREE FE G` is
   the voter `FE GARDIOLA`), or a person uses a maiden name in one file and a
   married name in the other. We matched these on the address and the first
   name, and wrote why in `notes`.

## How to check the files

[`check.py`](check.py) is a marimo notebook. It builds both pools again,
takes both samples again, and then makes sure that:

- the parcel IDs it samples are still exactly the parcel IDs in the CSV files;
- every `kind`, `org_category`, `label` and `confidence` value is one we allow;
- each `(parcel_id, person_idx)` pair appears once only;
- a row has a `matched_ascension` if, and only if, its label is `match`;
- where the source gives a share for every person on a parcel, the shares add
  up to 1.

If `sources/voterfile.csv` is on your machine, it also makes sure that every
`matched_ascension` number is a real voter. To run it:

```sh
uvx marimo edit --sandbox research/owners/check.py
```
