# Optimization pass — measured results

Baseline = pristine `HEAD` (commit `1c36704`) exported to `/tmp/de-lead-base`.
After = current working tree. Same benchmark harness, same fixed-seed fixtures,
median of rounds. Machine was shared by several agents, so **ratios** are the
signal, not absolute milliseconds.

Every claim below was re-measured; behaviour contracts are guarded by the full
suite (`node --test test/` = **641 pass / 0 fail**) and `scripts/verify-wiring.mjs`
(**25 checks pass**).

## Confirmed wins

| # | Change | Location | Metric | Before | After | Gain |
|---|---|---|---|---|---|---|
| 1 | Provider resolution: single `new URL()` per resolve + `(baseUrl,style)`-keyed pure memo + hoisted regexes + `Set` membership | `lib/providers.js` | `resolveProvider()` | 1.76–2.12 µs | **182–200 ns** | **~10×** |
| 2 | Tokenizer: allocation-free CJK counting (SIMD prefilter + 64 KB BMP lookup table, 4-way unrolled) | `lib/tokenizer.js` | `tokenProfile()` 512 KB CJK | 5.28 ms, 1.1 MB alloc | **0.63 ms, 52 B** | **8.4×, alloc −99.99%** |
| 3 | Tokenizer: same, pure-ASCII path (prefilter short-circuits) | `lib/tokenizer.js` | `tokenProfile()` 512 KB ASCII | 26 ns | **28 ns** | parity (no regression) |
| 4 | `threshold()`: cache the sorted window, invalidate on `observe()` | `lib/tolerance.js` | per-decision `threshold()` | 11.76 µs | **0.065 µs** | **~180×** |
| 5 | Credential read: memoize file text keyed on `(path, mtimeMs, size)`; parse refs once, not per candidate name | `lib/index.js` | `resolveKeyFor()` (per decision) | 18.69 µs | **6.01 µs** | **3.1×** |
| 6 | `aggregate()`: normalize each record once (was twice), reuse pre-built `provider\0model` key, hoist sort whitelist | `lib/stats.js` | `aggregate()` 20 k records | 10.53 ms | **7.39–7.84 ms** | **−26…−30%**, alloc −33% |
| 7 | `readForSession()`: substring pre-filter before `JSON.parse` | `lib/decision-store.js` | per-line parse on session reads | every line parsed | only candidate lines | ~97% fewer parses |
| 8 | Telemetry append: skip redundant `mkdir` syscall, with forget-and-retry on failure | `lib/index.js` | `recordTelemetry()` | 37.4 µs | **26.4 µs** | −29% |
| 9 | UI render: `h()` identity fast path when `lang === "zh"` (no `Object.keys`, no props copy, no `children.map`) | `lib/client.js` | config/decisions/stats render | 0.020–0.022 ms | **0.014–0.016 ms** | **1.3–1.5×** |
| 10 | Module import cost | `lib/index.js` | `import()` | 13.4 ms | **9.7 ms** | −28% |

## Bug found and fixed while verifying

`validateBaseUrl()` returned the **cached object itself**, so any caller that
mutated the result (`ok`, `value`, `error`) poisoned every later validation of
the same URL. No current caller does this, but it is an exported API — the memo
now returns a shallow copy. Repro and fix verified: mutating one result no
longer affects the next.

## Equivalence evidence (not just "tests pass")

- **Tokenizer**: exhaustive — all 65 536 BMP code units, all range-boundary
  pairs, 5 000 random strings including surrogate pairs/emoji. Old vs new counts
  identical; bench semantic fingerprint byte-identical.
- **Tolerance**: 180 000 comparisons of cached vs recomputed quantiles across
  random `observe` sequences, plus direct `bucket.push()` bypassing `observe()`
  — 0 mismatches.
- **stats.aggregate**: full JSON semantic fingerprint (totals, byProvider,
  byPoint, outcomes, savings, rows, first row) byte-identical before/after.
- **Credential memo**: proven to still pick up external edits — edit, delete,
  recreate, and newly-added-key cases all return correct fresh values (no
  stale reads, no cached negatives).
- **Client `h()` fast path**: deep node-tree comparison of the whole rendered
  tree (1 272 nodes per view) for config/decisions/stats in **zh**, plus the
  **en** path — identical, comparing functions by source text (fresh closures
  are expected and are not a behavioural difference).
- **decision-store pre-filter**: 17 session ids (incl. quotes, backslashes,
  control chars, CJK, emoji) × 407 lines — filtered result byte-identical to
  full parse.
- **providers memo aliasing**: candidates arrays are per-call copies; caller
  mutation (sort/push/clear) cannot pollute later results; cache stays bounded
  across 500 distinct URLs.

## Deliberately NOT changed

- `graph`-level re-resolution semantics ("config edits apply without restart")
  — preserved everywhere; memos are keyed on the actual inputs.
- `engine.ask()` per-call overhead: measured **1.7 µs** against a network call
  of tens of ms. Not worth the risk of reshaping the telemetry/detail branches.
- `jsonClone` in `decision-store` (`JSON.parse(JSON.stringify(...))`): the
  undefined/Date/function normalisation is load-bearing for redaction.
- StatsStore `read()` mtime-keyed parse cache: rejected — a same-size
  same-mtime rewrite would serve stale numbers, and "identical numbers" must be
  provable, not probable.
- Batched telemetry write queue: deferred. Tests pin telemetry file contents
  immediately after a decision, and a batching queue's crash-loss window is a
  product decision rather than a mechanical optimisation.
- Data-driven provider presets: rejected — key order and the Chinese
  label/error strings would become iteration-order dependent, with zero runtime
  benefit.
- Structural extraction of `apply()`'s 1 811-line body: deferred. The handlers
  close over 10+ locals; threading them would be a large, risky diff for no
  measured hot-path win.
