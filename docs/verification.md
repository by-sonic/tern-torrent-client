# Checking existing files

The 1.0.3 transfer benchmark did not cover the full initial scan of existing files. A report of a 151 GB torrent showed the app checking files at about 803 MB/s and using roughly 11.6% CPU while the window still displayed 0%. This is a separate operation from receiving torrent data at 50–60 MB/s.

## What changed in 1.1.0

WebTorrent 3.0.21 reads a piece and hashes it with synchronous native SHA-1. Its file store also allocated and copied every piece, including pieces contained in a single file. Tern's store now returns the read buffer directly for the single-file case; shared boundaries still use the original implementation.

The verification wrapper preserves SHA-1 comparison, the shortened final piece, read-error handling, startup bitfield probes and corruption fallback. It yields between refills and replaces quadratic fallback deduplication with a Set. Verification progress counts completed attempts, including invalid or absent pieces. The UI labels these as **checked**, separately from downloaded bytes. A failed probe starts a separate fallback pass, so its denominator and progress reset.

All active torrents share a default **256 MiB/s verification budget**. The budget applies after a successful read and before hashing. Missing/read-error pieces bypass it, so a newly added empty torrent starts downloading promptly. At most two read/hash tasks per torrent remain in flight. A bounded 16 ms scheduling credit avoids a separate Windows timer delay for every small piece; a small initial burst is possible, so this is a sustained budget rather than an instantaneous ceiling. The limit reduces sustained CPU and disk pressure, at the cost of a longer full scan. Under ideal conditions, reading 151 GiB at 256 MiB/s takes about ten minutes. Actual elapsed time depends on the disk, file sizes, missing data and timer scheduling.

Change **Settings → File verification limit** to use a different budget; zero removes the limit. It affects checking existing data, not the network download limit. Pausing, closing a torrent or changing the limit cancels/reschedules waiting work. The budget does not bypass hash comparisons, and the saved bitfield schema and original resume policy remain unchanged. An interrupted initial full scan may have to be repeated, as in 1.0.3; partial startup verification is not persisted as fully trusted data.

## Bounded comparison

Environment: Windows x64, AMD Ryzen 7 5700X, 16 logical processors, Electron's Node v24.21.0, WebTorrent 3.0.21. The harness checked an isolated 512 MiB fixture with shared file boundaries and a short final piece, plus a 512 MiB subset of already downloaded data. Each mode ran three times in alternating order with 4 MiB pieces. Every checked piece matched its expected SHA-1.

The existing-data adapter uses only `fs.open(..., 'r')`, never a write-capable torrent store. The torrent was paused during measurement. Saved state bytes, source file sizes and modification times matched before and after. Reports omit torrent names, paths, identifiers and expected hashes. These runs do not verify all 151 GB or reproduce every interaction of the installed window.

Without the budget, the final synchronous verifier and buffer reuse were compared with the unmodified 1.0.3 verifier:

| Metric, mean of three runs | 1.0.3 | 1.1.0 without budget |
| --- | ---: | ---: |
| Existing-data CPU time | 0.724 s | 0.479 s |
| Existing-data elapsed time | 347 ms | 245 ms |
| Existing-data event-loop p99 | 5.44 ms | 4.40 ms |
| Fixture CPU time | 0.562 s | 0.438 s |
| Fixture elapsed time | 366 ms | 255 ms |

The existing-data pass used **33.8% less total CPU time** and completed **29.6% sooner**. Maximum event-loop delays did not improve consistently: 13.12 to 15.25 ms for existing data, and 15.66 to 15.68 ms for the fixture. No maximum-delay improvement is claimed. Fewer copies and garbage collections also did not consistently lower sampled RSS; the allocator can retain more memory between less frequent collections.

Total CPU time and the percentage shown in Task Manager are different. An unlimited scan can use similar CPU each second while finishing earlier. The default budget addresses sustained load; the measurements below must be interpreted separately from this unlimited comparison.

With the default budget, a separate set of three alternating runs measured the same 512 MiB existing-data subset:

| Metric, mean of three runs | 1.0.3 | 1.1.0 at 256 MiB/s |
| --- | ---: | ---: |
| Engine CPU, normalized to 16 logical processors | 12.63% | 1.99% |
| Elapsed time | 344 ms | 1960 ms |
| Effective throughput | 1489 MiB/s | 261 MiB/s |

The engine's average CPU load fell while the scan took longer. This is a warm-cache subset, not a full 151 GB pass or a measurement of all Tern processes. The short run can exceed 256 MiB/s slightly because of initial scheduling credit. Total CPU work was noisy (0.697 versus 0.625 seconds), and event-loop delay did not improve: p99 increased from 5.86 to 20.40 ms. These results do not establish a UI latency improvement on the installed app.

A separate 32 MiB fixture with 16 KiB pieces checked all 2048 pieces in 102 ms with the budget, compared with 70 ms upstream. It guards against timer overhead dominating small pieces; its short elapsed time is not a sustained-throughput estimate.

WebCrypto SHA-1 was evaluated and rejected as the default. With the same yielded scheduler and direct read buffers it used 0.911 CPU seconds and 597 ms on the existing-data subset, compared with 0.485 CPU seconds and 246 ms for native synchronous SHA-1. Its extra input copy did not provide a useful delay improvement in this test.

## Reproduce

```console
node scripts/bench/verify-profile.cjs --electron --size-mib 512 --repeat 3
node scripts/bench/verify-profile.cjs --electron --size-mib 512 --repeat 3 --modes upstream,fast-store
node scripts/bench/verify-profile.cjs --electron --size-mib 512 --repeat 3 --modes upstream,balanced
node scripts/bench/verify-profile.cjs --electron --size-mib 32 --piece-kib 16 --repeat 1 --modes upstream,balanced
```

An optional `--live-subset` uses a paused saved torrent and a bounded subset opened read-only. The harness rejects unsafe paths and changed source metadata, runs owned children below normal priority with a 45-second budget, and removes only its own contained temporary fixture. Numeric results are recorded in [verification-1.1.0.json](benchmarks/verification-1.1.0.json).

Regression coverage includes valid/corrupt/missing pieces, shared file boundaries, a short final piece, exact startup probe selection, corruption fallback, close/cancellation with late callbacks, shared pacing and a real WebTorrent metadata-before-verification hook. The Electron utility-process smoke verifies changing progress over IPC, pause/restart/shutdown, the final bitfield, unchanged file bytes and no peers. The renderer smoke checks that the changing percentage is labelled as checking, then returns to download progress afterward.
