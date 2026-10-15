# Architecture

MemorySpy is three cooperating processes. Each boundary exists for a reason, and each was
chosen after testing the alternative.

```
┌──────────────┐  Tauri events   ┌────────────┐   NDJSON / stdin   ┌────────────────────┐  EventPipe   ┌────────────┐
│ React UI     │ ◄─────────────  │ Rust host  │ ◄───────────────── │ MemorySpy.Collector │ ◄──────────► │ .NET target │
│ charts,      │ ──────────────► │ process    │ ─────────────────► │ (.NET sidecar)      │              │ process     │
│ diagnosis    │   commands      │ supervision│   commands         │                     │              │             │
└──────────────┘                 └────────────┘                    └────────────────────┘              └────────────┘
```

## Why a separate .NET sidecar

The .NET diagnostics stack is only reachable from .NET. Producing the data requires
`Microsoft.Diagnostics.NETCore.Client` (which speaks the runtime's diagnostics IPC protocol)
and `Microsoft.Diagnostics.Tracing.TraceEvent` (which parses the EventPipe stream). Both are
large, both need a .NET runtime, and both can fail in ways that are not worth risking inside
a desktop app.

Practical reasons for the process boundary:

- **Blast radius.** A misbehaving target can produce a stream that stalls or throws while
  parsing. In a sidecar that costs one process; in the host it would freeze the window.
- **Different clock.** Attaching to a process under load is bursty. A separate process can
  be killed and restarted without touching UI state.
- **Debuggability.** The collector is a normal CLI. You can run
  `dotnet MemorySpy.Collector.dll watch --pid 1234 --verbose` and see exactly what the app
  sees, which is how every probe in this repository was developed.

The cost is a spawn per session (~200 ms) and a JSON hop. Both are irrelevant next to the
runtime's own 1 s counter interval.

## Why one EventPipe session per target

Every additional EventPipe session on a target process costs it another buffer and another
set of callbacks. A tool that attaches several probes must therefore not attach several
sessions.

So `ProviderMerger` folds every probe's provider requests into one list: keywords are OR-ed,
levels take the maximum, argument dictionaries are merged. Adding a probe is free at runtime
as long as it wants a provider some other probe already enables — for the three built-in
probes this means exactly two providers (`System.Runtime` and
`Microsoft-Windows-DotNETRuntime`).

Merging is not always neutral, though, and this is worth knowing before trusting a probe to
keep seeing what it saw alone. `allocation-sites` has to ask for `AllocationSampling`
(`0x80000000000`), because the older sampled-allocation keyword is dead on .NET 10; with that
keyword in the merged set the runtime reports allocations as per-allocation
`AllocationSampling` events (id 303) and stops raising the `GC/AllocationTick` (id 10) events
the live `allocations` probe matched on. Measured on .NET 10.0.9 against the leaking sample:
758 ticks and 0 samples without a capture, 0 ticks and 776 samples with one — so the live
per-type panel, which only knew the tick name, went empty exactly when a capture was armed.
The probe now reads both kinds and reports `samplingBasis`, which is the general lesson: a
probe that keys off an event *name* is coupled to the session's keyword set, not just to its
own.

## The protocol

Newline-delimited JSON on the collector's stdout; commands as NDJSON on its stdin. Every
message shares one envelope so the host can forward messages without understanding them:

```json
{"v":1,"seq":42,"ts":1792057022106,"type":"counter.sample","probe":"runtime-counters","data":{…}}
```

Message types emitted today:

| Type | Probe | Payload |
| --- | --- | --- |
| `hello` | – | capabilities: probe list, event types, normalisation rules, target metadata |
| `session.started` / `session.stopped` | – | pid, enabled probes, merged providers |
| `counter.sample` | runtime-counters | batched counter readings, normalised |
| `allocation.sample` | allocations | per-type allocation totals and rates for the interval, plus `samplingBasis` — which event kind produced them, since a capture-armed session gets per-allocation samples instead of 100 KB ticks |
| `heap.stats` | gc-stats | per-generation heap breakdown after a collection |
| `gc.event` | gc-stats | one collection: generation, reason, background flag, real pause ms |
| `gc.summary` | gc-stats | cumulative collection counts and finalizer activity |
| `allocation.site` | allocation-sites | sampled allocations folded by call site (file:line from the module's PDB, or the method when no PDB was readable) and by type, resolved from a finished raw capture |
| `process.list` / `process.detail` | – | attachable .NET processes |
| `error` / `log` | any | diagnostics |

The envelope is versioned (`v`). Adding a message type or a field is not a breaking change;
changing the meaning of an existing field is.

Because the protocol is self-describing, the host is protocol-agnostic: `collector.rs`
knows about `type` strings only to increment counters and to recognise `target.exited`. The
UI renders panels from the `hello` handshake (`src/panels/registry.tsx`).

## Recording and replay

A recording is the collector's event stream written to disk, wrapped in a four-kind NDJSON
envelope:

```json
{"kind":"header","formatVersion":1,"recordedAtUnixMs":…,"target":{…},"options":{…}}
{"kind":"message","envelope":{ … the collector's own envelope, untouched … }}
{"kind":"log","level":"debug","message":"…","ts":…}
{"kind":"footer","endedAtUnixMs":…,"endReason":"detached","messages":412,…}
```

Three decisions shape it.

**Recording is host-side only.** The collector knows nothing about files. Every envelope
travels through exactly one place — the session's stdout pump — and that is where
`RecordingWriter` appends it, *before* dispatch, so a recording never depends on which
message types this build of the host happens to understand. A new probe is therefore
recorded for free. The writer buffers and flushes on a 250 ms timer: the cost of a message
is one buffered write, and a crash costs at most the last quarter second.

**Replay reuses the live path.** A player parses the file and pushes the recorded envelopes
through the same `EventSink` a live session uses — not a parallel renderer. There is no
second code path to keep in sync, which is what makes an offline reading trustworthy: the
panels, charts and diagnosis rules cannot behave differently on recorded data, because they
are the same code. The player gets its own channel (`memoryspy://playback`) for transport
state, because a replay is not a live session and the shell has to label it as such.

**The timeline comes from the recording.** The frontend plots `message.ts`, never
`Date.now()`. Otherwise the headline growth rate would be a function of playback speed: at
32× a two hour leak would report a rate 32 times too high, and the one number the tool
exists to produce would be wrong. For the same reason a seek does not jump: it re-opens the
file and forwards everything up to the target as fast as the buffer allows, so the
accumulated state really is the state at that position. Each restart bumps a `generation`
counter, and the UI clears its buffers when it sees that change instead of splicing two
timelines into one chart.

Some smaller consequences worth knowing:

- **Pacing is deadline-based** (`Pacing`), not a sleep per gap, so a speed change, a pause or
  a seek take effect immediately rather than after the current wait finishes. While paused
  the thread blocks on the command channel, so a paused replay is silent by construction.
- **Gaps longer than 20 s are compressed to 20 s** (divided by speed). A service that idled
  for ten minutes should not make a replay look hung.
- **`--check` reports `recordingsDir`.** "Where did my recording go?" is the first question
  after an incident, and the answer has to be reachable from a terminal.
- **Deletion is confined** to the recordings folder, enforced by resolving real paths
  (`recording::resolve_inside`) rather than comparing strings, and refused while the file is
  being read by a replay or written by a session.

### Reading a file you did not write

The reader is deliberately tolerant, because a recording is often the only artifact that
survived a crash on someone else's machine:

- a missing header is fine — the timeline falls back to the first event,
- an unwrapped envelope (a plain dump from another tool) is accepted as a message,
- a truncated or corrupt final line is counted as skipped, not fatal,
- an *incomplete* recording (no footer) is reported as such in the UI instead of being
  silently trusted.

The reader also records a **histogram of message types**. That is what decides which views a
recording can fill when it is replayed on a machine that has never seen the target process:
with no live `capabilities` to consult, the evidence is the handshake, and the panels' own
`consumes` declarations are matched against it. A recording that lost its GC provider
halfway through still shows its counters rather than hiding every view behind one gap.

## Raw capture and allocation call sites

The `Call Sites` view answers the question a type name cannot: *which code allocates this?*
A type leaderboard only identifies a culprit when the type is yours. The leaks that matter
most in practice are framework types — `byte[]`, `string`, a dictionary's internals — and for
those there is no `new byte[]` to search for. Only a call stack helps, and getting one took
four findings that are worth writing down because three of them contradict the obvious path:

1. **The classic allocation-sampling mechanism is gone.** Under `GCAllObjectAllocation`
   (`0x2200000`) — the keyword PerfView-era tooling uses — a .NET 10 process emits *nothing*
   for a ten second capture. Not a payload problem: the events do not exist. The modern
   `AllocationSampling` keyword (`0x80000000000`) emits hundreds of thousands of them in the
   same window, each carrying the type, the object size and a full managed call stack. The
   probe enables that keyword, and can still read the legacy event so a capture from an older
   runtime analyses.
2. **A live stack cannot be named.** `TraceEvent.CallStack()` throws on an
   `EventPipeEventSource` — *"Attempted to use TraceLog support on a non-TraceLog
   TraceEventSource"* — because an instruction pointer becomes a method name only after the
   module and method maps have been built from a complete stream. This is not a library
   limitation to work around; it is the shape of the data. The host therefore has to keep the
   raw stream.
3. **Method names need rundown.** The session requests `requestRundown: true` when a capture
   is armed, so `MethodLoad`/`ModuleLoad` events are in the file. Without them the conversion
   produces stacks with addresses and no names.
4. **The `Stack` keyword is `0x40000000`**, and it is *not* needed for allocation stacks —
   measured, not assumed. (The plausible-looking `0x4000000000` is a different flag entirely.)

So the mechanism is a *tee*, and it is the one place in the system where a probe depends on
something other than live events:

```
EventPipe ──► CaptureStream ──► TraceEvent parser ──► live probes
                   │
                   └────────► capture-<pid>-<ts>.nettrace ──► (on stop) ──► ETLX ──► allocation.site
```

Design decisions and their reasons:

- **The extension point is an interface, not a flag.** `IRawCaptureConsumer` declares
  `CaptureExtension` and `AnalyzeCapture(path, context)`. `CollectorSession` tees the stream
  when any enabled probe implements it *and* a capture path was given, and calls
  `AnalyzeCapture` once the stream has ended (in the `finally`, before the session is
  reported as over, so the analysis arrives before the stop event). A probe that needs the
  raw stream stays a normal probe: resolvable by id, described in the handshake, selectable
  from the CLI, recorded and replayable like anything else.
- **Opt-in, because the sampler is expensive.** `AllocationSampling` emits tens of thousands
  of events per second. Its provider is enrolled only when a capture was requested, so a
  probe list that happens to include `allocation-sites` costs nothing on a plain session. An
  `ICollectorProbe` that asked for that keyword unconditionally would tax every user of the
  tool.
- **The capture is kept, the ETLX is not.** The `.nettrace` is the artifact `dotnet-trace`
  and PerfView can reopen, so it stays next to the recordings and is named in the handshake.
  The ETLX is several times larger and exists only to give the analysis its method maps, so
  it is deleted before the result is announced — by the time a caller can see the analysis,
  the disk holds only the capture.
- **Writes are capped, and truncation is reported.** An unattended session must not be able
  to fill a disk, so `CaptureStream` stops at 256 MB by default. Reaching the cap is not
  silent: the session logs it and the analysis says the capture is truncated rather than
  presenting the prefix as complete.
- **A failing analysis cannot fail the session.** It runs inside the session's error budget —
  reported, suppressed after three attempts, never fatal — because the live data was already
  delivered by then.

**From method names to a line of code.** A name still is not a place: `PayloadWriter.Serialize`
may allocate in half a dozen statements. The runtime's stack carries an IL offset, and the only
thing that turns an IL offset into a file and line is the module's PDB — read *again*, after the
method map has already been built, because `TraceCodeAddress` deliberately stores no line
information. Three findings shape the implementation, and the first one is the kind of thing
that fails silently rather than loudly:

1. **`SecurityCheck` decides whether this works at all.** `SymbolReader` refuses a PDB found by
   probing next to the binary unless a callback approves it, and it approves nothing by default.
   Without the callback every lookup returns null: the analysis still names methods, so nothing
   looks broken — it simply never reports a line. Measured here: **0 of 50** sampled addresses
   resolved, versus **6 of 50** once the callback was supplied (the six that belong to the
   profiled assembly's own module; the rest are runtime frames with no PDB on the machine).
2. **The approval is narrow, not blanket.** A PDB is accepted only when it sits in a directory of
   an assembly the profiled process actually loaded — the same trust boundary as the binary being
   profiled — and a PDB is never allowed to run a source-server command, since a PDB can embed
   one and this analysis has no reason to execute anything. Source itself is never fetched: the
   probe reads `BuildTimeFilePath`, the path recorded at build time, rather than asking the
   symbol layer for the file's contents.
3. **The line becomes part of the site's identity.** Two allocations in one method are two rows
   (`Program.cs:86` and `Program.cs:89` in the sample), which is the difference between "this
   method allocates" and "this statement allocates". Without a PDB the line is unknown, so sites
   merge by method exactly as before — which is why `sitesWithSource`/`sitesWithoutSource` and
   the list of modules whose PDBs were missing are part of the payload rather than something the
   UI has to guess.

The lookup is cheap because it is cached twice: per code address, and per module in the negative
— a module with no PDB beside it and no configured symbol path is written off before the first
probe, so the runtime's own frames cost nothing. Measured on the sample: **5 ms** of PDB reading
for a ten second capture in which the whole analysis (conversion included) took under 150 ms.

**And it is bounded, but only where bounding is possible.** `_NT_SYMBOL_PATH` is the standard way
to point at a symbol server, so honouring it means this phase can touch the network, and a server
that does not answer must not turn a finished capture into an analysis that never returns. Two
measurements shaped the guard, and the second one contradicts the first guess:

- **The budget is a floor, not a promise.** The phase stops consulting the server once 5 000 ms
  of lookup time have been spent, and it says so in `symbolStopReason` and in the log. Against a
  black-holed `_NT_SYMBOL_PATH` the whole run took **62 s** anyway: a single `GetSourceLine` call
  that goes out to a dead address is not interruptible from here, so the check that ends the phase
  runs only after that call returns. What the budget removes is not that one stall but every
  attempt after it: before the budget existed, the same scenario was still running when the
  harness gave up at 152 s, and the capture's call sites were lost with it.
- **Local PDBs are exempt from the budget, and that exemption is the important half.** In the run
  above the profiled assembly's own PDB sat next to its DLL: resolving it costs microseconds and
  needs no server. Without the exemption the stalled request consumed the budget *for everything*,
  and the answer came back as 0 of 5 sites with a line — the user's own code, thrown away to bound
  a lookup that was never about it. With it: every site that belongs to the profiled assembly
  keeps its line (`Program.cs:86`, `Program.cs:89`; 2 of the 7–9 sites a run produces, where the
  rest are runtime frames), those frames fall back to a method name, and the payload and UI name
  the reason instead of implying a missing PDB.

**Why the ranking is honest.** The runtime *samples* allocations, so volumes are sampled
bytes, not accounting. Sampling is proportional to allocated bytes, which makes the **share**
between call sites unbiased and the absolute totals not. The message reports both, together
with the caveat, and the UI shows the share on every row.

**Picking the frame that a human can act on.** The innermost frame is the allocation point,
which for a `string` is `System.String.Ctor` — true and useless. The probe therefore walks
outwards past frames in the runtime's own namespaces (`System.`, `Microsoft.`, `Internal.`,
`Interop.`, `Windows.`) and reports the first frame that belongs to someone else, keeping the
frames below it as the chain that shows how that method was reached. When every frame is
runtime code the site is marked `userCode: false` and the UI labels it `runtime`, because
"the runtime allocated 288 bytes here" is a different statement from "your code did".

## Heap snapshot: asking the runtime who holds the objects

The `Heap Snapshot` view answers what no counter can: *what survives collection, and which
reference is keeping it alive?* It does that by asking the runtime to walk its own object graph,
which makes it the only probe that is a discrete event rather than a periodic sample — and the
only one that deliberately does **not** join the shared EventPipe session.

```
{"cmd":"snapshot"} ──► HeapSnapshotProbe.TryBeginSnapshot
                              │
                              └─► its own EventPipe session, keyword GCHeapSnapshot (0x1980001)
                                        │
   Microsoft-Windows-DotNETRuntime ─────┴─► TypeBulkType (names) ─┐
                                              GCBulkNode (objects) ─┼─► graph built in-process
                                              GCBulkEdge (refs)    ─┤   ├─ live bytes per type
                                              GCBulkRootEdge/…   ──┘   └─ BFS from the roots
                                        │
   GCStart(Depth=2) / GCStop ───────────┴─► "the walk is done" ──► drain ──► heap.snapshot
```

Design decisions and their reasons:

- **Its own session, not the shared one.** Adding the heap-snapshot keyword to the shared
  session would make every session — including one that never asks for a snapshot — force a
  heap walk on its next collection. The probe therefore declares `Channel = None` and no
  providers, and opens a session of its own when it is asked. The consequence for the session
  layer: a probe selection that contributes no providers is no longer an error, because a
  provider-free session is still how the command channel and the target's lifetime are observed.
  The runtime provider is enrolled at `Critical` level so the session exists and emits nothing.
- **Starting is the trigger.** Enabling the keyword is what makes the runtime walk the heap at
  its next collection; no IPC command is sent. Completion has no event of its own — it is the
  `GCStop` matching the `GCStart` with `Depth == 2` and a non-background type — and a short drain
  after it is what keeps the tail of the bulk events from being cut off (measured: 4 338 of
  4 378 556 references, 0.1%, without it).
- **The graph is built here because the library does not build it.** TraceEvent 4.0.0 ships the
  typed bulk events and no graph: no `MemoryGraph`, no retained-size call, no `.gcdump` reader
  (established by reflecting over the referenced assembly, not from release notes). Nodes, edges,
  roots, the breadth-first search and the retained-size analysis live in the probe, which also
  means the payload can be honest about what it saw: an `inventory` of the event kinds that
  arrived, and the counts of anything it could not name (`unknownTypeObjects`).
- **"What would be freed" is asked of the graph, not derived from it.** A dominator tree would
  answer it for every object in a couple of passes, and that was the first implementation. It was
  replaced because this graph defeats the iterative dominance algorithm: the ancestor walks it
  needs are long enough that a 6–7 M object heap hit the pass's safety budget — 80 s of CPU with
  nothing to show for it. Walking the graph again with the objects removed gives the same number
  for the objects the payload actually reports, is exact by construction rather than exact if the
  algorithm is right, and costs **34 ms per walk** over 7.6 M objects. That is the trade: about
  forty extra walks in a snapshot (≈1.5 s) for a number nobody has to doubt. `HeapGraphAnalysis`
  holds the mechanism, and a budget bounds how many questions are asked.
- **A partial walk is reported as partial, not as a small heap.** The bulk events are dropped by
  the runtime when the reader falls behind, and `EventPipeBufferingMode.Block` — what
  `dotnet-gcdump` uses — is unreachable here because it needs a newer IPC command that the
  diagnostics server rejects. So the buffer is raised and the result is checked against two facts
  that did **not** come from the walk: how many objects a root can reach, and the runtime's own
  `TotalHeapSize` for the same collection. When either says the walk is short, the payload carries
  a `coverageNote`, the type totals become a stated floor, and retention paths are withheld
  entirely — see `docs/EXTENDING.md` for the measured 35 GB case that made this necessary.
- **Two numbers that are easy to confuse are both reported and distinguished.** Live bytes is what
  a type's objects occupy; the "freed if removed" figure is what stops being reachable when those
  objects go away, which is usually larger because a small type can hold a large one. On the
  sample, `SessionRecord` occupies 119.5 MB and accounts for **825.6 MB**, and the 92.6 MB entry
  array accounts for 918.2 MB — a self-consistent pair, since removing the records frees the
  records, their payload arrays and their name strings, and removing the array frees all of that
  plus the array itself. The payload carries a `note` spelling out the difference, and a
  `retainedNote` whenever the budget did not reach every type.
- **The answer has a shape the UI reproduces.** Every retention path is root-first, because the
  top of the chain is the reference that has to be cut, and each frame keeps the runtime's own
  label (a root kind, a static field name, `field #n`) rather than a formatted guess.

The deliverable is verified end to end against the leaking sample: the contract test enables only
this probe, takes a snapshot, and asserts the chain from a root to `SessionRecord` — through the
`Dictionary` and its `Entry[]` array — which is the same answer the panel shows a user.

## Threading model

Collector:

- **one parser thread** — `EventPipeEventSource.Process()` blocks; every probe callback runs
  on it. Probes must be fast and must not block, so they only accumulate.
- **one timer thread** — flushes every `--interval` ms. This is why probes guard their state
  with a lock: `OnEvent` and `Flush` genuinely run concurrently. A flush that overruns is
  counted and skipped rather than queued, so a slow flush cannot build a backlog.
- Probes are individually sandboxed: an exception is reported, and after three occurrences
  that probe goes quiet instead of flooding the stream.

Host:

- **one reader thread per session** reads stdout into a channel, and a second thread drains
  that channel into batches, appending each message to the recording while it does. The
  split exists for the *quiet* session: a blocking read can only check its flush deadline
  after a line arrives, so a session whose first messages are its only messages — a probe set
  whose sole member reports at the end, such as a deep capture — would hold them
  indefinitely. With a channel, a batch that has waited 80 ms is flushed whether or not
  anything else ever arrives. This was found by the call-site test timing out, which is the
  argument for testing a protocol on the sparsest stream it can produce rather than the
  busiest.
- **one stderr thread** forwards collector diagnostics to the log panel (and into the
  recording, since it is often the only clue about why a recording is sparse).
- **one playback thread per replay** paces the file and forwards it in batches, staying
  responsive to pause/seek/speed commands through a channel at every wait point.

Batching is not cosmetic. A heavily collecting runtime emits hundreds of GC and allocation
events per second, and one IPC round trip per event would saturate the webview while adding
nothing the UI can render (it repaints at most once per frame). Messages are flushed every
64 messages or 80 ms.

## Data normalisation

The runtime reports units inconsistently, and the counter table in `collector/Core/CounterCatalog.cs`
exists to fix that once rather than in every chart:

- sizes arrive in MB for `gc-heap-size`/`working-set` but in bytes for `gen-N-size`/`loh-size`
- some counters omit `DisplayUnits` entirely
- `cpu-usage` advertises `%` but reports a share of *total* machine CPU
- `alloc-rate` is a per-interval amount, so its value would change with the sampling interval

Rules applied, in order: the runtime's own unit, then a catalog multiplier, then division by
the interval for rate counters. Everything downstream sees bytes, percentages, counts, or
milliseconds.

Two of these were established by measurement, not assumption, and the measurements are worth
keeping in mind when touching the catalog:

- **cpu-usage.** A single-threaded busy loop on an 18-core machine reports `~5.56`, i.e.
  exactly 100/18. The value is therefore a share of total machine CPU; it is multiplied by
  `Environment.ProcessorCount` so 100% means "one core fully busy" and matches `top`/`ps`.
  Verified: 100.3% vs `ps -o %cpu` 100.0%.
- **Working set vs GC heap.** A managed heap can legitimately be much larger than the
  resident set: committed pages are faulted in lazily and the OS may compress or swap them.
  Observed on a leaking process: 17 GB reported heap with a 4.2 GB resident set. Nothing
  should assert a hierarchy between the two.

## Analysis

`src/lib/analysis.ts` holds the diagnosis rules. Two properties matter:

1. **A rate, not a total.** Totals are ambiguous — 2 GB is fine for one service and alarming
   for another — whereas "412 MB/min, steady over three minutes" is unambiguous. Rate
   estimates come from a least-squares fit whose r² is also reported: a high slope with a poor
   fit is usually a sawtooth (allocate, collect, allocate), which is normal operation, and the
   UI says so instead of raising an alarm.
2. **Evidence with every claim.** Each finding carries the numbers that produced it and the
   counter it came from. An analysis tool that can only assert "there is a leak" trains people
   to ignore it.

## Packaging the sidecar

The collector ships as a bundled app resource. Two details are worth knowing before editing
`bundle.resources` in `tauri.conf.json`:

- The glob form (`["resources/collector/*"]`) **preserves the glob's directory prefix**, so
  files land at `Contents/Resources/resources/collector/…` — one `resources` level deeper than
  the locator looks. The map form used instead, `{ "resources/collector": "collector" }`,
  states the destination explicitly and lands them at `Contents/Resources/collector/…`.
- The destination must stay in sync with `locate_collector()` in `src-tauri/src/collector.rs`,
  which checks `{resource_dir}/collector/MemorySpy.Collector.dll`. A mismatch is silent: the
  app starts fine and only reports "collector not found" at runtime.

Both are checked by building the bundle and running the packaged self-check
(`MemorySpy.app/Contents/MacOS/memoryspy --check`), which prints the resolved path and the
`source` it was resolved by. Running it from an unrelated working directory is what makes the
check meaningful: it removes the development-relative fallback paths from the search.

## Verification

Three layers, in increasing order of what they actually prove:

1. `npx tsc --noEmit` and `npm run build` — the frontend compiles and bundles.
2. `cargo test` in `src-tauri` — the supervisor's own logic and the discovery path.
3. `src-tauri/tests/collector_contract.rs` — the risky part. It spawns the leaking sample,
   attaches a real session through the same code path the app uses, and asserts on the
   batches that come back: normalised units, `SessionRecord` present in the per-type
   allocation data, GC data present, terminal status on shutdown, and useful errors for a
   missing process and an unknown probe id.

   It also drives the deep-capture chain end to end against that real process: the handshake
   reports where the capture is going, the capture file is on disk afterwards, the
   intermediate ETLX is not, no frame failed to resolve, a site in the sample's own code is
   reported *with a runtime frame below it* (so the chain is a real stack rather than a
   guess), and a `System.*` type is attributed to that site. That last assertion is the one
   that fails for every type without this feature.

Layer 3 is the one that would have caught (and did catch) the class of bug that matters here:
wrong units, wrong scaling, silent empty payloads.

It had one blind spot, and a real defect lived in it for exactly that reason: the per-type
allocation assertions run in a session *without* a capture, while the call-site assertions run
in one *with* a capture, so nothing ever checked both probes in the same session. Arming the
capture changes the runtime's turn of event (`GC/AllocationTick` gives way to
`AllocationSampling`), and the live probe — which matched on the tick's name — delivered an
empty payload in that configuration while the capture file next to it held thousands of
samples. The deep-capture test now asserts on the live allocation samples of the *capturing*
session as well, which is the assertion that would have failed.

The UI has a dev-only mock backend (`src/lib/mock.ts`, enabled with `?mock=1`) that emits the
same envelopes from a simulated leaking service. It exists so the interface can be built and
reviewed without a .NET process, and it validates the real protocol rather than a convenient
fiction. It is unreachable in production builds.
