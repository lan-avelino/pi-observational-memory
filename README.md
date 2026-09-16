# observational-memory

Tiered, subprocess-backed memory for pi.

Parallel **observers** distill raw conversation chunks into atomic observations committed to the master's branch-local **ledger** (so memory stays correct under `/tree`); a deterministic, model-free **compaction** renders that buffer verbatim into the compaction block. A **consolidator** promotes the oldest observations into durable `.memory/<sessionId>/` topic files, bounding the buffer and giving each session its own durable, `grep`-able long-term memory (a fork seeds its memory from its parent).

## On/off gate (default OFF)

The extension ships in the global extensions folder during development, so it is **gated off
per session** and is completely invisible until you turn it on.

- `/om` — toggle for this session
- `/om on` / `/om off` — set explicitly

State persists per session in the ledger (`om.enabled`) and survives resume. When off, every
trigger, hook, widget, and subprocess returns immediately.

## How it works

```mermaid
flowchart LR
    A["raw chunks<br/><i>token-bounded, fixed slices</i>"]
    B["parallel observers<br/><i>subprocess pi, headless</i>"]
    C["observations<br/><i>{timestamp, content}</i>"]
    D["master ledger<br/><i>branch-local, /tree-correct</i>"]
    E["compaction block<br/><i>deterministic, model-free</i>"]
    F["consolidator<br/><i>subprocess pi, one at a time</i>"]
    G[".memory/&lt;session&gt;/&lt;topic&gt;.md + INDEX.md<br/><i>durable, per-session, grep-able;<br/>tombstones drain buffer</i>"]

    A --> B --> C --> D --> E
    D -- "oldest overflow<br/>(pool > consolidateAtPoolTokens)" --> F --> G
```

Pipeline: raw chunks → observers → observations → ledger → compaction block, with a
consolidator draining the oldest observations into durable per-session memory files.

- **Observer clock** (`turn_end` / `agent_start`): every `chunkTokens` of new raw history,
  cut a fixed-token slice and fire an observer subprocess. Observers are embarrassingly
  parallel pure mappers (capped by `observerConcurrency`); each commits its own
  `coversUpToId` watermark, so out-of-order completion is fine.
- **Observation** = `{ timestamp, content, tokenCount }`. The precise event-`timestamp`
  doubles as the id; the orchestrator re-derives a unique, second-resolution id at commit
  (the observer only emits minute resolution).
- **Compaction** (`turn_end` over the effective threshold = `min(compactAtContextTokens,
  compactAtWindowFraction × contextWindow)`): waits for in-flight
  observers, then renders the active buffer plus a **memory map** (rendered live from
  `.memory/<session>/` topic front-matter) and a **journey** section (`.memory/<session>/JOURNEY.md`, read
  verbatim). The cutoff snaps to an observation chunk boundary so the verbatim tail is never
  double-represented.
- **Consolidator clock** (`turn_end` / `agent_start`): when the active observation pool
  exceeds `consolidateAtPoolTokens`, a single background consolidator subprocess folds the
  **oldest** observations (above `poolTargetTokens`) into durable `.memory/<session>/<topic>.md`
  files, then the orchestrator tombstones exactly the observations it reports — draining the
  buffer back toward target. Topic files are **scoped per session** (`.memory/<sessionId>/`,
  keyed by the immutable session-header id, so two sessions in the same project never share
  output) and track the session, not the branch: they are **not** rolled back by `/tree`. On a
  fork/clone the new session's memory is **seeded once** from the parent (matching the ledger,
  which already travels with the fork). The orchestrator owns `INDEX.md` and re-renders it from
  topic front-matter after each run; the consolidator touches `<topic>.md` files plus
  `JOURNEY.md`, via its own `read`/`write`/`edit`/`ls`/`grep` tools scoped to the session dir.
- **Journey** (`.memory/<session>/JOURNEY.md`): a single, whole-project, purely **descriptive** prose
  history of how the work got to its current state, maintained by the consolidator and pushed
  into every compaction block for **orientation** (not recall, not instructions). It is
  append-mostly: each consolidation adds a short dated segment and compresses the oldest
  segments only once the file exceeds `journeyTargetTokens`, so recent history stays detailed
  and the section stays bounded. Like the topic files it does **not** roll back under `/tree`.

Each worker is an **ordinary recorded pi session** in the global store
(`~/.pi/agent/sessions`, under the project path) — open it in the session browser to see the
exact input chunk, tool calls, and output. Transient handoff files live in
`<project>/.memory/<sessionId>/.runs/`.

### Cost tracking

Every worker is a `pi` subprocess, so its spend is captured from pi's **built-in**
`usage.cost.total` (reliable, already computed). The worker extension — *not* the model —
accumulates that figure and hands it back via the run's cost file
(`.memory/<session>/.runs/<runId>.cost.json`), alongside the existing observation IPC. The orchestrator
folds each run into an `om.cost` ledger entry.

- **Ephemeral-safe:** cost rides the result-file IPC, never a saved session log, so it works
  even if a worker session is not persisted.
- **Never rolls back:** the running total sums *all* `om.cost` entries across the whole
  session (every branch), so real money spent does not decrease under `/tree` — the same
  tier rule as the `.memory/` files.
- **Surfaced** in the footer (`$0.000`, right of the gauges) and in `/om:status`
  (`session cost: $X (N runs)`). Survives resume.

## Commands

| Command | Effect |
|---|---|
| `/om`, `/om on`, `/om off` | The per-session on/off gate |
| `/om:status` | Workers in flight, active observation count, next-observer progress, pool/consolidator state, topic-file count, journey size, context usage, **session cost**, last error |
| `/om:compact` | Force a compaction now (ignores the threshold) |
| `/om:consolidate` | Force a consolidation now (ignores the pool threshold) |

## Configuration

Namespace `observational-memory` in `~/.pi/agent/settings.json` (global) or
`.pi/settings.json` (project; overrides global):

```jsonc
{
  "observational-memory": {
    "chunkTokens": 15000,
    "chunkOverlapTokens": 0,
    "poolTargetTokens": 30000,           // buffer drains back toward this after consolidation
    "consolidateAtPoolTokens": 50000,    // pool size that triggers a consolidation (≈1.7× target)
    "compactAtContextTokens": 320000,    // ~62% of a 512k window; tune per model
    "compactAtWindowFraction": 0.7,      // hard cap: min(above, 0.7 × model context window)
    "tailTokens": 40000,                 // verbatim tail; snaps to a chunk boundary
    "journeyTargetTokens": 4000,         // pushed JOURNEY.md size; compress oldest segments past this
    "observerConcurrency": 6,
    "models": {
      "observer":     { "provider": "openrouter", "id": "z-ai/glm-5.3", "thinking": "low" },
      "consolidator": { "provider": "openrouter", "id": "z-ai/glm-5.3", "thinking": "medium" }
    },
    "passive": false,
    "debugLog": false
  }
}
```

### Window sizing

The defaults above are tuned for a **512k** context window. The knobs that must move with the
window are `compactAtContextTokens` (the trigger), `tailTokens` (the verbatim tail kept after the
cutoff), `poolTargetTokens` / `consolidateAtPoolTokens` (how much distilled memory rides in
context), and `chunkTokens` (which is also the snap resolution for the tail). Rough guide:

| window | `compactAtContextTokens` | `tailTokens` | `poolTargetTokens` | `consolidateAtPoolTokens` |
|---|---|---|---|---|
| 200k | 140,000 | 20,000 | 15,000 | 25,000 |
| 512k | 320,000 | 40,000 | 30,000 | 50,000 |
| 1M | 700,000 | 80,000 | 60,000 | 100,000 |

Leave `chunkTokens` at 10–15k: it sets the tail snap precision (±`chunkTokens/2`), so inflating it
to save observer spawns makes the cutoff coarser. Raise `observerConcurrency` instead. Keep
`compactAtContextTokens` below the provider's usable window minus the max output — 1M is often a
beta tier with tighter effective limits.

### Interaction with pi's own compaction

Pi auto-compacts at `contextWindow - reserveTokens` (`reserveTokens` default 16,384), and **that
same path is the only context-overflow recovery net**. So:

- **Leave `compaction.enabled` at its default (`true`).** Disabling it sets `_checkCompaction()`
  to return early for *all* three cases — threshold, overflow-with-retry, and overflow-without-retry
  — so you lose compact-and-retry on a provider overflow. OM does not need it disabled.
- **`compactAtWindowFraction` is what keeps OM first.** The effective threshold is
  `min(compactAtContextTokens, floor(fraction × contextWindow))`, resolved from the live
  `ContextUsage.contextWindow` on every check. At the default `0.7` that is always below pi's
  `window - 16,384`, for any window above ~55k tokens. The footer gauge and `/om:status` show the
  effective value and where it came from (`configured absolute binds` vs `70% cap`).
- **A pi-first compaction is benign.** OM's `session_before_compact` handler supplies the summary
  block either way, and `snapCutoff()` re-picks the verbatim cutoff from the observation chunk
  boundaries rather than trusting pi's proposal. A collision costs timing, not correctness.

`PI_OM_PASSIVE=1` forces `passive` (disables all triggers) for clean `/tree` testing.
`passive` is a power-user setting distinct from the on/off gate.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Layout: `src/` is the master-side orchestrator (entry `src/index.ts`); `agent/` is the shared
worker extension loaded into subprocesses via `-e` (`OM_WORKER=observer|consolidator`).
Long-term memory lives under `<project>/.memory/<sessionId>/` (`INDEX.md` + `<topic>.md` +
`JOURNEY.md`), keyed by the immutable session-header id so sessions in the same project stay
isolated; a fork seeds its dir from the parent's on first touch. Transient worker IPC lives
under `<project>/.memory/<sessionId>/.runs/`.