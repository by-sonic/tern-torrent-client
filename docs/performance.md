# High-throughput downloads

Tern 1.0.3 addresses CPU spikes and an unresponsive window during fast, large downloads. The report below compares the download engine with the 1.0.2 baseline and records the bounded tests used to choose the final implementation. It does not predict CPU usage for every torrent or network.

## Why large downloads became expensive

At 60 MiB/s, 16 KiB peer blocks arrive about 3,840 times per second. WebTorrent 3.0.21 calls its peer refill routine after individual blocks. Each refill can revisit other peers and try to replace outstanding requests. The baseline CPU profile showed time in `_hotswap`, speed accounting and their repeated clock reads.

A separate cost grows with torrent size and download progress:

- `_checkDone` scans an unfinished file from its first piece after each completed piece. Repeatedly rechecking a long verified prefix creates quadratic work over a sequential download.
- `_updateWireInterest` starts its scan at piece zero for each peer even when the prefix is already verified.
- WebTorrent's file progress getter traverses a file's pieces. Previously the Files tab repeated those traversals independently of the list's progress cache.

The final engine batches refills within 5 ms, keeps verified frontiers for completion and peer interest, and shares one progress measurement between the list, Files tab and saved resume state. SHA-1 verification and the storage write path remain active. The original WebTorrent completion method still emits completion events and announces completion to trackers.

Torrent networking, verification and file operations also run in an Electron utility process. This separates engine work from the main process that handles the window. The transfer benchmark below measures engine CPU and delays; it does not include renderer/GPU activity or quantify the extra utility process's total memory.

## Reproduce the final benchmark

Install dependencies, then run from the repository root:

```console
node scripts/bench/active-profile.cjs --electron --mode both --size-mib 256 --piece-kib 4096 --peers 6 --repeat 3 --out .scratch/active-profile
```

Add `--profile` to save V8 CPU profiles and their hottest functions. Profiles add overhead, so the final numeric comparison uses the command above without profiling.

The `baseline` mode preserves 1.0.2's sequential strategy, sparse store, four cache slots and removed rarity map. It embeds the previous progress paths and does not install the new completion, interest or refill routines. The `optimized` mode uses the same transfer options and current optimizations. The historical rarest-first stress test is not involved.

The harness generates one random fixture of at most 256 MiB and runs the seeders in a separate process. Six peers collectively use a 60 MiB/s upload limit; the leecher also has a 60 MiB/s download limit. The token-bucket limiter permits a startup burst, so the overall measured rate can slightly exceed the configured limit. DHT, trackers, local discovery, PEX, NAT mapping, uTP and web seeds are disabled. Listeners bind to `127.0.0.1`; fixture metadata contains no trackers.

Each child has a 45-second time budget and runs below normal priority. The orchestrator stops owned children, verifies temporary-directory containment and removes fixtures in `finally`. It never opens the application's saved torrents or existing download directory. Reports and optional profiles are retained only in the selected output directory.

## Final transfer measurements

Environment: Windows x64, AMD Ryzen 7 5700X, 8 physical cores / 16 logical processors, Electron's Node **v24.21.0**, WebTorrent **3.0.21**. Three paired runs alternated baseline/optimized order. Each transferred 256 MiB with 4 MiB pieces and six loopback peers. Every downloaded file matched the source's SHA-256.

| Metric | 1.0.2 baseline | Final 5 ms batching |
| --- | ---: | ---: |
| CPU time, mean per transfer | 1.932 s | 1.510 s |
| CPU time, median per transfer | 1.875 s | 1.610 s |
| Throughput, mean | 59.56 MiB/s | 60.36 MiB/s |
| Event-loop p50, mean of runs | 5.64 ms | 5.77 ms |
| Event-loop p95, mean of runs | 16.88 ms | 17.49 ms |
| Event-loop p99, mean of runs | 22.64 ms | 23.14 ms |
| Maximum delay, each run | 516 / 586 / 541 ms | 28 / 31 / 30 ms |
| Peak RSS, mean | 165.7 MiB | 163.6 MiB |

The mean CPU reduction was **21.8%**; the median reduction was **14.1%**. Individual CPU readings varied: baseline 1.625–2.297 s, optimized 1.266–1.655 s. The consistent result was removal of the half-second engine stalls while maintaining throughput. Short p95/p99 delays and peak RSS showed no material improvement in this small-fixture test.

`cpuSeconds` includes the leecher process's user and system CPU, including its I/O/hash worker threads. It excludes the seeder process and Electron renderer/GPU. `cpuPctOfOneCore` is `100 × cpuSeconds / elapsedSeconds`; Windows Task Manager's percentage across 16 logical processors would be roughly that value divided by 16. These metrics are different from the user's total application CPU percentage during an Internet download.

## Model of a 150 GiB torrent

The synthetic scenario creates metadata for 38,400 × 4 MiB pieces, with 37,376 pieces already verified. Its last piece is shortened by 17 bytes to avoid the old aligned-file progress bug affecting the baseline comparison. It allocates no 150 GiB content file and performs no disk or network transfer.

| Operation | 1.0.2 baseline | Final implementation |
| --- | ---: | ---: |
| 1,024 new piece completion checks | 209.62 ms | 1.04 ms |
| Bitfield reads in those checks | 38,798,847 | 40,447 |
| 6,144 peer-interest updates | 555.82 ms | 0.54 ms |
| 1,024 list/Files progress reads within the cache TTL | 178.94 ms | 0.65 ms |
| Bitfield reads during those repeated progress requests | 39,321,600 | 0 |
| 4,096 refill requests in one batch | 4,096 refill passes | 1 refill pass |

Both modes emitted exactly one file-complete event and one torrent-complete event. Selected byte counts matched the expected verified prefix. Initial frontier construction and the initial progress measurement occur before the timed repeated loops; the synthetic numbers isolate repeated rescans rather than startup cost. Zero repeated progress reads means the already-built cache was shared, not that progress measurement costs nothing.

## Search ledger and limits

An initial `setImmediate` batching candidate looked promising under a profiler, but its CPU reduction did not repeat without profiling. It was replaced by the bounded 5 ms batch.

| Candidate | Runtime / fixture | Profiler | Mean CPU, baseline → candidate | Interpretation |
| --- | --- | --- | --- | --- |
| `setImmediate` | Node 24.19.0 / 128 MiB / 6 peers / 2 pairs | On | 1.719 → 1.242 s | Profile identified repeated refill/hotswap work; not sufficient for a CPU claim. |
| `setImmediate` | Node 24.19.0 / 256 MiB / 6 peers / 2 pairs | Off | 2.164 → 2.274 s | CPU reduction did not repeat; long stalls still fell. |
| Final 5 ms batch | Electron Node 24.21.0 / 256 MiB / 6 peers / 3 pairs | Off | 1.932 → 1.510 s | Retained after correctness checks and throughput comparison. |

Each comparison uses its own baseline in the same runtime. The runtimes and fixtures differ between rows, so absolute CPU times across rows should not be treated as an independent measurement of the batching change.

The small transfer fixture validates real peer traffic, storage and output correctness. The metadata-only scenario validates the expensive large-torrent mechanisms. Together they support the implementation choice; they do not replace a sustained 150 GiB Internet download with its actual peer population, antivirus activity, disk and renderer workload. The refill timer is requested at 5 ms, but OS scheduling can deliver it later.

Sanitized per-run measurements are saved in [benchmarks/high-throughput-1.0.3.json](benchmarks/high-throughput-1.0.3.json). Full local profiles and speed samples stay in `.scratch/` and are not published.

The tuning wrappers depend on WebTorrent's internal method contracts. Rerun correctness tests and this benchmark after changing WebTorrent, Electron or the storage implementation. Removing `installTorrentOptimizations` restores the baseline refill/completion/interest paths; process isolation and progress caching are separate changes.
