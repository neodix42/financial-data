# financial-data

Weekly category-grouped Dukascopy historical data, downloaded with
[`dukascopy-node`](https://github.com/Leo4815162342/dukascopy-node).

The workflow runs **Saturday at 00:00 UTC**, with **50 concurrent download slots**
by default. It downloads H1 and D1 for all 1,499 instruments in the pinned
`dukascopy-node@1.51.1` catalog. Each history begins on January 1, 2000, or at that
instrument's first available date for the requested period if later. H1
availability currently starts no earlier than May 2003.

## Run it

Push these files to the repository's default branch and enable GitHub Actions.
The workflow requests `contents: write` and `actions: read` using the built-in `GITHUB_TOKEN`; no
personal access token or external storage is required. Repository rules must
permit this token to create and delete releases and create snapshot tags.

For the initial backfill, open **Actions → Historical data → Run workflow**.
The same button starts a manual update or resumes an unfinished backfill at any time.
With the GitHub CLI, the equivalent command is:

```bash
gh workflow run historical-data.yml -f threads=50 -f budget_minutes=300
```

The optional inputs are:

| Input | Default | Meaning |
| --- | --- | --- |
| `threads` | `50` | Maximum simultaneous provider requests, from 1 to 200. |
| `budget_minutes` | `300` | Time from the attempt's first step until downloads stop; maximum 300 minutes. |

The next Saturday run resumes an unfinished backfill automatically. You can also
run the workflow manually to resume sooner. Workflow concurrency prevents two
attempts from modifying release storage simultaneously.

The schedule uses UTC: Saturday 00:00 UTC is Saturday 04:00 in Dubai. For Dubai
midnight instead, change the cron to `0 20 * * 5` (Friday 20:00 UTC). GitHub
scheduling is best-effort and can be delayed or dropped at busy times; scheduled
workflows run on the default branch and can be disabled after 60 days of public
repository inactivity. See [scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Release contents

Data is grouped by the 38 requested category names, including their emoji in the
index and manifest. The upstream list also has one instrument in **Ungrouped**,
which is retained so coverage includes all supported instruments.
[`data/categories.json`](data/categories.json) records the exact category
memberships and their pinned upstream source. Filename slugs omit emoji and
spaces, for example `forex-major-currencies`, `united-states-etfs`, and
`agricultural-commodities`.

Each category has separate H1 and D1 TAR archives containing the individual
instrument ZIPs:

```text
latest published release
  index.txt
  manifest.json
  forex-major-currencies-h1-part001.tar
    eurusd-h1.zip
      eurusd-h1.csv
    gbpusd-h1.zip
      gbpusd-h1.csv
    ...
  forex-major-currencies-d1-part001.tar
    eurusd-d1.zip
      eurusd-d1.csv
    ...
  united-states-h1-part001.tar
  ...
```

Published archives have stable category/period names; consult `index.txt` for the
exact filename. Categories larger
than 1.8 GiB are split into additional TAR parts, each containing complete ZIPs.
A single ZIP too large for one part fails explicitly instead of losing data.
Normally there are 78 category/period archives plus the index and manifest.

To extract a chosen instrument after downloading its category archive:

```bash
tar -xf forex-major-currencies-h1-part001.tar eurusd-h1.zip
unzip eurusd-h1.zip
```

CSV files are UTF-8 with this header:

```csv
timestamp,open,high,low,close,volume
```

Timestamps are ISO 8601 UTC bar-opening times. Prices are **bid**; volume uses the
provider tool's **millions** unit. Only bars closed by the attempt's captured
cutoff are stored. Actual zero-volume/flat provider candles are preserved;
synthetic gap candles inserted by the library are removed. Weekends and market
holidays are not filled with invented bars.

Invalid OHLCV bars are omitted, including non-finite values, open/close outside
the high/low range, inverted high/low, and negative volume. The workflow logs a
warning with the instrument, period, count and an example timestamp, then keeps
processing the chunk. CSV rows remain contiguous with no blank lines or
placeholders; valid timestamps and prices are unchanged. A removed bar's timestamp
is absent: replacement prices or timestamps are not invented. A bad update does
not overwrite an existing valid bar.

`index.txt` is tab-separated, one row per instrument and period:

```text
instrument  period  category  first_bar_utc  last_bar_utc  rows  status  archive  zip
```

First/last datetimes come from the stored CSV, not the fetch time. A successfully
empty history has `-` datetimes, zero rows and `no_data` status, plus a header-only
CSV in its ZIP. Inactive instruments retain their existing histories. Network,
access-denied and malformed-data errors are never reported as empty history.
An instrument-level download or processing error logs a warning, retains that
chunk's cursor for retry on the next attempt, and lets other instruments and
categories continue checkpointing. An attempt with pending failed chunks exits
successfully as `checkpointed`; it does not publish an incomplete replacement.
Errors writing or validating a durable checkpoint still stop the run so unsafe
state cannot replace the last recoverable checkpoint.

An instrument withdrawn from the current provider API is recorded separately as
`unavailable`, not `no_data`. This classification requires both a successful,
validated live-catalog response omitting its code and the detail endpoint's
explicit `Unknown instrument` response; an arbitrary HTTP 400 or a network error
never qualifies. Any previously downloaded history is retained, and an instrument
with no obtainable history gets a header-only CSV. The manifest records the
provider code, reason, source and verification time. These confirmed unavailable
entries do not block publication of the available histories. A later snapshot
checks the symbol again and backfills from its original start if it returns.

`manifest.json` records the full category and instrument mapping, progress,
cutoff, configuration, archive sizes and SHA-256 checksums. Data files are stored
only in releases; the workflow makes no dataset commits. Local working files
under `.data/` are ignored by Git.

## Five-hour cutoff and recovery

The first backfill can span several attempts. Each attempt processes one
category/period at a time, downloading up to 50 instrument date chunks in
parallel. H1 chunks cover at most one month and D1 chunks at most one year. The
underlying tool's request batch size is one, so nested batches do not multiply
the configured concurrency.

The downloader saves a release checkpoint after every completed category and
about every 20 minutes within a large category. A checkpoint includes partial
instrument histories and the next date chunk to request. Completed work is
packaged and uploaded to a **draft** release, so recovery does not depend on the
runner disk, Actions caches, or workflow artifact retention.

At **five hours from attempt start**, in-flight provider work is terminated,
completed chunk results are merged, and the current category is checkpointed.
A budget stop succeeds with `checkpointed` in the workflow summary and publishes
nothing. The job has a six-hour timeout, leaving time for ZIP/TAR creation and
checkpoint uploads. GitHub transfers and retries have a separate deadline at
5 hours 55 minutes to avoid running into the hard timeout.

The next attempt restores the draft, validates checksums, and resumes from each
saved cursor using the draft's original cutoff. Completed instruments and category
archives stay complete; only unfinished histories are downloaded before publishing
that snapshot. After publication, the next update creates a new snapshot with a
fresh cutoff and fetches the latest-bar overlap. A runner crash or forced cancellation
can lose work since the last durable checkpoint, but never invalidates the last
committed checkpoint or the preceding published snapshot. No software can
finish a new checkpoint after a runner is forcibly killed.

On subsequent weekly updates, each ZIP is extracted and the latest saved bar is
requested **inclusively**. Fresh bars replace matching timestamps and newer bars
are appended in order. This prevents duplicate or stale overlapping bars. An
empty update preserves old bars. Updates do not discover arbitrary corrections
to older history; a separate full-refresh policy would be needed for that.

Checkpoint uploads use new filenames. The new checkpoint manifest is uploaded
last; only then are superseded draft files deleted. Failed or uncommitted uploads
are discarded on recovery, including GitHub's incomplete `starter` assets.

Draft archive names retain an internal checkpoint suffix such as `v00000024`.
It is a sequence number, not an instrument or data-format version: a new archive
must coexist with the previous valid one until its checkpoint commits. Before
publication, archives are renamed by asset ID to their stable public filenames,
without re-uploading or changing their bytes. An interrupted rename remains
recoverable because checkpoint downloads use asset IDs and checksums.

## Saturday handoff

If a Saturday run is triggered while another attempt is active, it queues behind
the current run. Every 30 seconds, the active downloader checks for a newer
scheduled run of this workflow. Its presence is a cooperative stop signal:

1. Stop launching new date chunks.
2. Allow already-started chunks to finish within their existing request timeout,
   merge their bars, and upload a draft-release checkpoint.
3. Exit normally with `scheduled handoff` in the workflow summary.
4. Let GitHub start the queued Saturday run, which restores that checkpoint.

The preceding published release stays available; partial data is saved to a draft
and is published as latest only when coverage is complete. An already-started
checkpoint or final publication transaction is allowed to finish. Manual starts
also queue safely, but only newer scheduled runs request this early handoff.

The workflow deliberately keeps `cancel-in-progress: false`. GitHub's native
cancellation gives a process only about ten seconds before killing its process
tree, which is too short to upload a large checkpoint. The handoff instead waits
for the download drain and checkpoint upload before the successor takes over.
See [workflow cancellation behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation).
Polling failures are logged and retried; they never trigger an unsafe forced kill.

## Publishing and retention

The published release remains available while its replacement is prepared:

1. Restore the preceding managed snapshot, or resume the existing managed draft.
2. Download, merge, validate, package and checkpoint all categories.
3. Verify complete coverage, CSV ordering and uniqueness, row counts, ZIP/TAR
   integrity, and uploaded archive sizes/checksums.
4. Rename completed category archives to stable public filenames by asset ID.
5. Upload `index.txt` and `manifest.json`, remove checkpoint metadata, publish
   the completed draft, and explicitly mark it latest.
6. Verify publication and the published manifest, then delete preceding managed
   releases. Unrelated releases are left alone.

After successful cleanup, only the new published snapshot remains. During an
update, the old published release and an unfinished draft coexist. A cleanup
failure can temporarily leave older published snapshots; cleanup retries on the
next attempt. Generated Git tags are retained; there are no data commits.

The draft-first sequence also supports immutable releases. If a checkpoint's
catalog or configuration differs from the downloader, recovery stops rather than
mixing histories. Keep the dependency and lockfile pinned; category/catalog
changes require a deliberate migration review.

## Limits and expected performance

GitHub permits **1,000 files per release**, each **smaller than 2 GiB**. Individual
H1/D1 ZIPs would require 2,998 attachments before metadata, which is why they are
bundled by category. Splitting is checked against both limits before upload.
GitHub documents no total release-size or release-bandwidth limit. See
[release storage limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#storage-and-bandwidth-quotas).

GitHub-hosted jobs have a [six-hour limit](https://docs.github.com/en/actions/reference/limits).
Ubuntu runners have [14 GB storage](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Processing bounded categories, keeping completed instruments zipped, and deleting
restored/packed TARs after use reduces working disk usage. The downloader stops
and attempts a checkpoint when free disk falls below 512 MiB; unusually large
categories can still require a runner with more disk for packaging.

Release API mutations are serialized and paced at least eight seconds apart.
Rate-limit responses honor reset/`Retry-After` headers with bounded retries;
ordinary permission failures stop immediately. The repository token normally has
1,000 REST requests/hour, and secondary content-creation limits also apply. See
[GitHub API limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

The initial backfill is estimated at roughly 155,000 provider bucket requests.
Weekly updates require much less provider history, but the containing months and
years are still fetched, and the full resulting category archives must be
uploaded to each new release. HTTP 429, WAF challenges, network speed and release
upload time can affect duration, so fitting every weekly update into one attempt
is not guaranteed. The workflow installs Chromium for the tool's supported WAF
recovery; ordinary HTTP 403 remains an error.

## Local development

Requires Node.js 22+, npm, `tar`, `zip` and `unzip`:

```bash
npm ci
npm test
npm run catalog
npx --no-install dukascopy-node --install-browser --with-deps
```

To run the actual release-backed downloader locally, supply a repository and a
token with release write access (this creates/updates/deletes managed releases):

```bash
export GITHUB_REPOSITORY=owner/financial-data
export GH_TOKEN=your-token
DOWNLOAD_THREADS=50 DOWNLOAD_BUDGET_MINUTES=300 npm run download
```

Tests use fake GitHub/provider transports with real CSV, ZIP and TAR processing.
They cover category coverage, timestamp overlap, empty/malformed data, chunk
cursors, worker cancellation, scheduled handoffs, stable archive naming,
checksums, interrupted uploads, recovery, and safe
release rotation. The provider adapter works around the pinned tool's
empty-bucket aggregation bug without modifying the installed package.
