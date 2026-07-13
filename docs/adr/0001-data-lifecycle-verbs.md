# ADR 0001 — A decomposed-verb data lifecycle

Status: accepted (2026-07-10)

## Context

The data lifecycle grew one flag at a time and is now hard to explain. The
symptoms the maintainer named — "like r2? wtf is up with how complicated
`daily:prod` is?" — trace to four concrete problems.

### 1. `DB_TARGET` is one enum secretly doing four unrelated jobs

`DB_TARGET=r2` simultaneously selects the local directory, decides whether to
restore from the bucket, decides whether to publish, and (via its `:prod` twin)
decides whether `.env` is loaded:

| Job | Where |
| --- | --- |
| Which local directory to work in | `src/config.ts:31` |
| Whether to restore from the bucket first | `src/ingest.ts:54` |
| Whether to publish at the end | `src/ingest.ts:96` |
| Whether to load `.env` (via the `:prod` script twin) | `package.json:17` |

Because config owns the directory but `package.json` and CI re-hardcode it as
`DB_ATTACH=data/db-r2/...`, the same path is spelled in three places
(`package.json:16-17`, `.github/workflows/daily-refresh.yml:52-53`). Override
`DB_DIR` and the DQ suite silently checks a different, older file than the one
ingest just wrote — and passes.

### 2. The "verify before publish" gate is decorative

`daily:prod` is `node ... src/ingest.ts && vitest run test/dq.test.ts`. But
`publishObject` runs *inside* `ingest.ts` (`src/ingest.ts:97-98`), before that
process exits. The `&&` only fires afterward. **The data is already public
before the first check runs.** CONTRIBUTING.md:156 claims an ingest is checked
before it ships; it is not.

### 3. A stale working copy can silently clobber remote history

`restoreArchive` only downloads when the local file is *missing*
(`src/ingest.ts:54`), and `publishObject` is an unconditional `PUT`
(`src/publish.ts:34`). So a week-old `data/db-r2/anchorage.duckdb` on a laptop,
re-run through ingest, merges today's snapshot into week-old history and
overwrites R2 — destroying a week of history with no check catching it. The
CI `concurrency:` group does not help; the clobbering run is local.

### 4. Dead DuckLake corpse

`src/lake.ts` is already deleted in the working tree, but
`data/lake-r2/catalog.ducklake` (5.7 MB) lingers, and DuckLake references
survive in `README.md:186` and the notebooks. The public `r2.dev` URL is
hardcoded in eight hand-written files plus `.env`.

The deeper issue: `ingest.ts` `main()` welds five actions — fetch, restore,
merge, export, publish — into one process, then `daily:prod` tries to bolt a
gate on from outside with `&&`, which cannot work because publish already
happened inside. The fix is not a better weld. It is to split the verbs.

## Decision

Model the lifecycle on `git`: **the archive in R2 is the only source of truth;
a working copy is a local, ETag-validated cache of it, living in a named
workspace; a sandbox is just another workspace.** Each action is an
independently runnable verb. The daily automation is nothing more than a
canned sequence of those verbs, and every prefix of that sequence is a
legitimate place to stop.

### The verbs

| Verb | Does | Network |
| --- | --- | --- |
| `pull [path]` | remote archive → workspace; records the source ETag; refuses to overwrite a locally-born database (see below) | in only |
| `ingest [path]` | fetch upstream + SCD2-merge into the workspace's working copy | upstream in only; **never touches remote** |
| `verify [path]` | run the checks against a copy (or the published file) | none, or HTTPS if pointed at the published URL |
| `push [path]` | working copy → remote, guarded (see below) | out only |

`ingest` no longer restores and no longer publishes. "Don't push" becomes the
default, not something you must prevent.

```
pnpm pull            # prod -> workspaces/<name>/anchorage.duckdb, remembers ETag
pnpm ingest          # merge today's snapshot into it, local only
pnpm sql -- "..."    # inspect
# walk away: remote untouched, nothing published
pnpm push            # only if and when you decide to
```

The daily cron becomes `pull && ingest && verify && push` — a script, not a
special mode.

### Workspaces replace `DB_TARGET`

A workspace is a directory `workspaces/<name>/` holding one working copy and
everything that belongs to it: the archive, the browser artifact derived from
it, the ETag sidecar recording which remote object it descends from, and the
per-run raw downloads that fed it. `WORKSPACE=<name>` selects it; the default
is `default`. Every verb targets the selected workspace (or an explicit path,
when given).

The name is only a label for a local context — "default", "r2", a throwaway
experiment. Whether a sync is *possible* is decided by credentials: `pull` and
`push` are the only verbs that talk to the bucket, and they require the `R2_*`
variables, failing with a clear "no remote configured" message without them.
Whether a sync is *safe* is decided by lineage, tracked per working copy by
the ETag sidecar — never by the workspace's name. `ingest` and `verify` need
neither credentials nor lineage; they act on whatever file they are pointed
at.

### `push` self-verifies (the gate is intrinsic)

`push` runs the error-severity checks in-process against the copy it is about
to upload and refuses on any failure, with `--force` as the escape hatch. The
gate belongs to the dangerous verb, so it cannot be forgotten or bypassed by a
manual push. `verify` remains separately runnable for auditing an
already-published file.

### `push` is a compare-and-swap (the remote-clobber guard)

`pull` records the archive's ETag; `push` sends `If-Match: <that etag>` on the
archive PUT. If prod moved since the pull (CI ran, someone else pushed), the
push fails with HTTP 412 instead of silently clobbering. The very first push
(empty bucket) uses `If-None-Match: *` to create-if-absent.

**Verified against the live bucket (2026-07-10):** a throwaway conditional PUT
returned 412 on `If-Match:<bogus>` and on `If-None-Match:*` when the object
existed, and 200 on `If-Match:<correct-etag>`. R2 honors both forms; the CAS
design rests on observed behavior, not documentation.

The browser artifact is published after the archive with no precondition — it
is a pure derivative and the two objects are already documented as allowed to
disagree briefly mid-refresh.

### `pull` refuses unrelated histories (the local-clobber guard)

The mirror image of the CAS: a workspace database that has *no* ETag sidecar
was born locally — its history was never the remote's, and pulling over it
would destroy that history (a contributor's weeks of credential-less local
ingests, say). `pull` refuses to overwrite an archive with no recorded ETag,
with `--force` as the escape hatch. Refreshing a tracked copy (sidecar
present) overwrites freely, exactly like `git pull` fast-forwarding a clone
versus refusing unrelated histories.

### Sandbox = a throwaway workspace

A throwaway clone of prod is just another workspace:

```
WORKSPACE=exp pnpm pull            # clone prod to workspaces/exp/
WORKSPACE=exp pnpm sql -- "..."    # poke at it
rm -rf workspaces/exp              # discard
```

Its archive, browser artifact, ETag, and raw downloads all live and die
together in that one directory. Nothing aims a `push` at it, and even a
mistaken `push` from it is caught by the CAS unless it genuinely descends
from the current remote object. On APFS the pull's write is the only cost;
`workspaces/` is gitignored wholesale. Every verb also accepts an explicit
file path for the odd case a directory-per-context is too much ceremony.

### `.env` loading moves into config

A single guarded `process.loadEnvFile()` in `config.ts` (verified present on
the maintainer's Node; shell env correctly wins over the file, and CI's `env:`
block still overrides) replaces every `--env-file` flag. This deletes the
entire `:prod` script family. CI already runs plain `pnpm run ingest`, so
`:prod` was only ever local sugar.

### Checks get one home

`CHECKS` moves out of `test/dq.test.ts` into `src/checks.ts` exporting
`runChecks(conn, { errorOnly })`. `push` calls it in-process; `verify` and
`test/dq.test.ts` become thin wrappers over the same list. One definition, so
the gate and the audit can never drift.

## Consequences

Removed:

- `daily`, `daily:prod`, `ingest:prod`, `sql:prod` scripts — `pnpm ingest` /
  `pnpm sql` do the right thing in all contexts (contributor, laptop with
  `.env`, CI).
- `DB_ATTACH` / `DB_ATTACH_CURRENT` path duplication in `package.json` and CI.
- The `DB_DIR` / `RAW_DIR` overrides — `WORKSPACE` is the one selector, so
  there is no second axis on which the checked file and the written file can
  silently diverge.
- `data/` entirely: the working copy, browser artifact, and raw downloads all
  move inside `workspaces/<name>/`.
- `data/lake-r2/catalog.ducklake`; DuckLake prose in README and notebooks.

Added / changed scripts: `pull`, `push`, `verify` (thin); `ingest` loses
restore+publish; new `src/checks.ts`; `config.ts` gains `loadEnvFile` and
`WORKSPACE`; `publish.ts` gains ETag capture + conditional PUT.

The public `r2.dev` URL is centralized to one exported constant that the four
tests import, instead of eight literals.

Docs: CONTRIBUTING.md "How it works" / "Layout" / "Commands" rewritten around
the verbs; the false "checked before it ships" claim becomes true.

### Migration

The on-disk archive format is unchanged, so existing published files keep
working. Local directories move: `data/db/` → `workspaces/default/`,
`data/db-r2/` (if present) → `workspaces/r2/`; the bucket is untouched. First
`push` after the change has no recorded ETag, so it sends `If-None-Match: *`
harmlessly against the existing object → 412 → the error message says to
`pull` first (adopting the current object and its ETag) or `--force` to
overwrite blind. This adoption step is the one rough edge and is called out
for review.

## Implementation order

1. `src/checks.ts` — extract `CHECKS` + `runChecks`; repoint `test/dq.test.ts`.
2. `config.ts` — `loadEnvFile`, `WORKSPACE`, the `workspaces/<name>/` layout.
3. Split `ingest.ts` into `pull.ts` / `ingest.ts` / `push.ts` / `verify.ts`;
   `publish.ts` gains ETag capture and conditional PUT.
4. `package.json` scripts; `.github/workflows/daily-refresh.yml` → verb
   sequence.
5. Delete `data/lake-r2`; purge DuckLake prose; centralize the URL constant.
6. Rewrite the CONTRIBUTING.md lifecycle sections.

## Open questions

- First-push ETag adoption (above): auto-adopt on 412, or require an explicit
  `pull` / `--force`? Leaning explicit.
- Do we keep a standalone `sandbox` script, or is `WORKSPACE=exp` enough?
  Leaning env-only to avoid another script.
