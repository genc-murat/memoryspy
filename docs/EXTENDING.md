# Extending MemorySpy

Everything in this project is arranged so that a new diagnostic capability is a *local*
change. This document is the map of where things go.

## Adding a probe

A probe is a self-contained metric source. Adding one requires a single new class plus one
registration.

### 1. Write the probe

Create `collector/Probes/YourProbe.cs`:

```csharp
public sealed class ThreadPoolProbe : ICollectorProbe
{
    private ProbeContext _context = null!;

    public string Id => "threadpool";                       // CLI id and UI panel key
    public string DisplayName => "Thread Pool";
    public string Description => "Queue depth, thread injection and blocking.";
    public string Icon => "activity";
    public ProbeChannel Channel => ProbeChannel.Clr;         // Dynamic | Clr | Both
    public IReadOnlyList<string> EventTypes { get; } = new[] { "threadpool.sample" };

    public IReadOnlyList<EventPipeProvider> CreateProviders() => new[]
    {
        new EventPipeProvider("Microsoft-Windows-DotNETRuntime", EventLevel.Verbose, 0x00010000), // Threading
    };

    public void Initialize(ProbeContext context) => _context = context;

    public void OnEvent(TraceEvent ev) { /* accumulate; keep it fast and lock your state */ }

    public void Flush() => _context.Emit("threadpool.sample", new { /* payload */ });

    public IReadOnlyDictionary<string, object?> Describe() => new Dictionary<string, object?>
    {
        ["provider"] = "Microsoft-Windows-DotNETRuntime",
        ["note"] = "Whatever the UI should know to render this.",
    };

    public void Reset() { /* clear accumulated state */ }
}
```

### 2. Register it

Add a factory to `ProbeCatalog.Factories` in `collector/Probes/ProbeCatalog.cs`.

That is the whole change on the collector side. The CLI, the merged EventPipe session, the
capability handshake and the host pick it up automatically.

### 3. Choose the right channel

This is the one subtle part. TraceEvent delivers every event twice:

- `source.Clr.All` — the strongly typed parser for providers with a manifest. Resolves real
  event names and payload names, e.g. `GC/AllocationTick` with a `TypeName` field.
- `source.Dynamic.All` — self-describing EventSource providers only. A manifest provider
  shows up here as `EventID(10)` with no payload names, which is useless for aggregation.

`EventCounters` arrive on `Dynamic`; everything from `Microsoft-Windows-DotNETRuntime`
arrives on `Clr`. If a probe receives events but cannot read any fields, it is on the wrong
channel — that symptom is exactly what `--dump-raw` is for.

### 4. Find the right keywords and level

Not obvious from the docs, and worth saving someone an afternoon:

- A provider can be enabled with the right keywords and still emit nothing, because the
  **level** is too low. `GC/AllocationTick` on `Microsoft-Windows-DotNETRuntime` does not
  appear at `EventLevel.Informational`; it requires `Verbose`. When a probe sees zero events,
  raise the level before you go hunting for keywords.
- Type names in `AllocationTick` need the `GCHeapAndTypeNames` keyword (`0x01000000`) and come
  from the `TypeName` payload field.
- The runtime reports a collection's generation in `GC/GlobalHeapHistory`
  (`CondemnedGeneration`), which arrives *between* `GC/Start` and `GC/Stop` — not in `GC/Start`.
- `GC/Start` and `GC/Stop` are correlated by their `Count` field, and `TraceEvent.TimeStampRelativeMSec`
  is the correct clock for durations (wall clock timestamps are only for ordering the UI).
- **A keyword can be right and dead.** `GCAllObjectAllocation` (`0x2200000`) — the classic
  sampled-allocation flag — produces nothing at all on .NET 10; the modern
  `AllocationSampling` (`0x80000000000`) produces hundreds of thousands of events in the same
  window, with call stacks attached and no `Stack` keyword needed. Before concluding that a
  payload field is missing, count the events: a dead keyword looks exactly like a payload bug.
- **Your session's keywords are not yours alone**, because `ProviderMerger` OR-s every
  selected probe's request into one session. Enabling a keyword can *replace* the event a
  probe was reading rather than add to it: with `AllocationSampling` in the merged set the
  runtime raises per-allocation `AllocationSampling` (id 303) events and stops raising
  `GC/AllocationTick` (id 10), so a probe matching on the tick's name goes silent while the
  stream still carries the data under another name. If a probe works alone and stops when
  another probe joins, print the merged provider list (`session.started` carries it) and the
  raw event names (`--verbose`) before touching anything else.
- **`Stack` is `0x40000000`**, not the `0x4000000000` that arithmetic suggests. The enum in
  `TraceEvent`'s own assembly is the authority; reflect over it rather than trusting a
  memory of a header file.

`docs/ARCHITECTURE.md` lists the exact incantations the three built-in probes ended up using.

### 5. Add a panel (optional)

If the probe needs its own view, register it in `src/panels/registry.tsx`:

```tsx
{
  id: 'threadpool',
  label: 'Thread Pool',
  hint: 'Queue depth and blocking.',
  requires: ['threadpool'],        // probe ids this view needs
  consumes: ['threadpool.sample'], // message types it renders
  component: ThreadPoolPanelLazy,
}
```

`requires` is enforced: if the connected collector does not offer the probe, the tab is
disabled with an explanation instead of rendering empty. That is why pointing the app at an
older collector degrades gracefully.

### What recording changes for a new probe (nothing)

A probe's messages are recorded **without any code change here**, because the recorder sits
in the host's stdout pump and appends every envelope before it is dispatched. A probe added
today is replayable tomorrow, including the fields this version of the UI does not render.

Two things to keep in mind:

- **Panel availability during a replay comes from the panel's own `consumes` list**, matched
  against the recording's histogram of message types. A replay on a machine that has never
  seen the target process has no live `capabilities` to consult, so declare `consumes`
  accurately or the view will be greyed out on a recording that could have filled it.
- **A recording is the raw evidence, not a rendering of it.** If a probe emits redundant
  data, the recording keeps it. Prefer emitting the smallest honest payload; the file will be
  mailed to someone.

If you add a new *kind* of line to the recording envelope (not a new message type — a new
`kind`), extend `RecordedEvent` and `RecordingReader::next_event`, and add a case to the
format tests in `tests/recording_replay.rs` so old files keep opening.

## Adding a probe that needs the raw stream

Some answers cannot be computed live. Allocation call stacks are the example this project
shipped: TraceEvent refuses to resolve a call stack on an `EventPipeEventSource`
(*"Attempted to use TraceLog support on a non-TraceLog TraceEventSource"*), because turning
an instruction pointer into a method name requires module and method maps that only exist
after a complete stream has been converted. If your probe needs something of that kind, it
implements `IRawCaptureConsumer` in addition to `ICollectorProbe`:

```csharp
public sealed class AllocationSiteProbe : ICollectorProbe, IRawCaptureConsumer
{
    // No live channel: everything comes from the file, after the stream ends.
    public ProbeChannel Channel => ProbeChannel.None;

    // The provider whose events the analysis will need, enrolled only when a capture runs.
    public IReadOnlyList<EventPipeProvider> CreateProviders() => new[]
    {
        new EventPipeProvider("Microsoft-Windows-DotNETRuntime", EventLevel.Verbose, 0x80000000000),
    };

    public string CaptureExtension => "nettrace";

    public void AnalyzeCapture(string capturePath, ProbeContext context)
    {
        var etlx = Path.ChangeExtension(capturePath, ".etlx");
        TraceLog.CreateFromEventPipeDataFile(capturePath, etlx, new TraceLogOptions());
        using var log = new TraceLog(etlx);
        // …walk log.Events, read PayloadByName, walk ev.CallStack()…
        context.Emit("your.message", payload);   // emitted like any other probe's message
    }
}
```

What the session does for you, and what it expects:

- **The tee.** When any enabled probe implements the interface *and* a capture path was
  supplied (`--capture`, set by the host when the user arms `Deep capture`), the raw stream is
  copied to that path as it is parsed, and the session switches to `requestRundown: true` so
  the file contains the method maps your analysis needs. Behaviour is identical if you
  implement the interface and no capture is requested: nothing is copied and
  `AnalyzeCapture` is never called. That is what keeps a probe that would cost tens of
  thousands of events per second from taxing every session that merely lists it.
- **The trigger.** `AnalyzeCapture` runs once, after the stream has ended and the file has
  been flushed and closed, and before `session.stopped` is emitted — so your messages arrive
  before the session is reported as over.
- **The budget.** It may take seconds on a large capture (roughly 0.5 s of ETLX conversion
  plus ~1.4 s of analysis per 26 MB measured on a leaking sample), so keep it off the
  flush timer's path and say what you are doing through `context.Log`. Exceptions are
  caught and reported by the session; they cannot take the session down. Symbol lookups are
  cheap by comparison — 5 ms on the sample — because they are cached, but they are the one
  part that touches the file system and, if `_NT_SYMBOL_PATH` points at a server, the
  network. `AllocationSiteProbe.SourceResolver` therefore stops adding server-dependent
  lookups once 5 000 ms of lookup time are gone, and exempts modules that have a PDB beside
  them: those answer from disk in microseconds and must never lose their line to a request
  that went out to a server. The budget cannot bound a *single* request — measured against a
  black-holed `_NT_SYMBOL_PATH`, one `GetSourceLine` call took 62 s and the phase ended only
  after it returned — so treat a symbol path as a promise that the server answers, and expect
  the analysis to report `symbolStopReason` when it gives up rather than to stay silent about
  a truncated lookup.
- **Clean up your intermediates.** Delete the ETLX before emitting your result, and leave the
  `.nettrace` alone — that is the artifact the user can reopen in PerfView or `dotnet-trace`,
  and the UI names it. `AllocationSiteProbe.DeleteEtlx` is the helper to copy.
- **Report the sampling.** If the data is sampled, say so in the payload and report shares
  next to volumes. The UI prints your caveat verbatim, and a sampled total presented as
  accounting is worse than no number at all.
- **If you want a file and line, you need a PDB — and one callback.** A code address carries
  its method and an IL offset, never a line; `TraceCodeAddress.GetSourceLine(SymbolReader)` is
  what turns the offset into a location. The trap is that `SymbolReader` refuses a PDB found by
  probing next to the binary unless you supply `SecurityCheck`, and with it unset every lookup
  returns null *while the analysis still names methods* — so nothing looks broken, it simply
  never reports a line. Measured on this codebase: 0 of 50 sampled addresses resolved without
  the callback, 6 of 50 with it. `AllocationSiteProbe.SourceResolver` approves only PDBs that
  sit beside an assembly the trace loaded, refuses source-server commands outright, and caches
  per address and per module (a module with no PDB and no symbol path is written off before the
  first probe), which is what keeps the lookup at a few milliseconds.

## Adding a counter to the catalog

Counters the catalog does not know still flow through, labelled from the runtime's own
`DisplayUnits`. Add an entry to `CounterCatalog.Definitions` when you want:

- a friendly name, category and description (shown as a tooltip),
- a canonical unit and correct scaling,
- warning/critical thresholds, which colour the card automatically.

The `DefaultRawUnit` field is the important one: it is the unit to assume when the runtime
omits `DisplayUnits`, and getting it wrong for a size counter means reporting megabytes as
bytes.

## Changing the analysis rules

`src/lib/analysis.ts`. A rule is a function from the metrics store to a `Finding`, where the
finding must include the evidence that produced it. When adding one:

- prefer a **rate over a window** to an instantaneous comparison, and report the fit quality
  (`r2`) so a noisy signal can be called noisy,
- state the mechanism, not just the symptom ("Gen 2 is accumulating while the LOH is flat
  *because* objects stay reachable"), so the reader can falsify the claim,
- return `actions`, not just a diagnosis; a finding that does not tell anyone what to do
  next is noise,
- keep thresholds as named constants or catalog metadata rather than magic numbers inline.

## The heap snapshot probe, as built

The call-site probe answers *where memory is created*. The heap-snapshot probe
(`collector/Probes/HeapSnapshotProbe.cs`) answers the other half — *what is retained, and who
holds it* — from the runtime's own object graph rather than from a correlation between
allocation volume and heap growth.

It is the one probe that breaks two of the assumptions the others share, so it is worth
reading before writing a probe that does anything similar:

- **It reads its own EventPipe session.** The walk must be opt-in (`Channel` is `None`, and
  `CreateProviders()` returns nothing), because merging the heap-snapshot keyword into the
  shared session would make *every* session walk the heap. It is triggered by
  `{"cmd":"snapshot"}` on the existing stdin command channel, and a session that enables only
  this probe is still a working session — the collector starts a provider-free session for it so
  the command channel and the target's lifetime are still observed.
- **It builds the graph itself.** See the corrections below: the library ships the events, not
  the graph.

### What the runtime actually does

Five things were wrong in the first draft of this section, and each one cost a debugging
session. They are recorded here because the documentation for this area is thin and partly
outdated:

1. **The keyword is `GCHeapSnapshot` (`0x1980001`), not `GCHeapDump` (`0x100000`).**
   `GCHeapSnapshot` already includes `GC | Type | GCHeapAndTypeNames`.
2. **Starting the session *is* the trigger.** No "collect garbage" command is sent over IPC;
   enabling the keyword makes the runtime walk the heap at its next collection. There is also no
   "dump complete" event: completion is the `GCStop` that matches the `GCStart` whose `Depth` is
   2 and whose `Type` is not `BackgroundGC`. That is what `dotnet-gcdump` waits for, and it is
   also what bounds the pause the probe reports.
3. **The type table rides on an event the parser calls `TypeBulkType`**, even though its payload
   class is `GCBulkTypeTraceData`. Referring to `GCBulkType` is a compile error — the parser
   names events by the manifest's name, and there is no `GCBulkType` event at all.
4. **TraceEvent 4.0.0 has no heap-graph API.** The typed bulk events exist
   (`GCBulkNode`, `GCBulkEdge`, `GCBulkRootEdge`, `GCBulkRootStaticVar`, `GCBulkRootCCW`, …) but
   there is no `MemoryGraph`, no retained-size call and no `.gcdump` reader — verified by
   reflecting over the referenced assembly rather than by reading release notes. So nodes, edges,
   roots and the breadth-first walk are implemented in the probe.
5. **Edge attribution is positional.** A `GCBulkEdge` event names only the target address and the
   referencing field; it never names the node it belongs to. Node *i* owns the next `EdgeCount`
   delivered edges, in delivery order. Checked against a live session: the nodes declared
   7 614 478 references and exactly 7 614 478 were delivered, and 7 609 816 of 7 610 181 objects
   were reachable from a root. Recording the edge offset when a *node* was appended instead
   silently binds every node to the same handful of edges — the first version did that and
   reached 878 objects out of 3.9 M.

### The one real limit, and how it is handled

The walk is exact — every live object at one blocking collection — but it is delivered as
ordinary EventPipe events, and a session configured the normal way **drops events when the
reader falls behind**. That is fine for counters and fatal for a graph. `dotnet-gcdump` avoids it
with `EventPipeBufferingMode.Block`; that mode is not reachable from here, because the
configuration-based `StartEventPipeSession` sends a newer IPC command that the .NET 10 diagnostics
server answers with `UnsupportedCommandException`.

So the buffer is raised (512 MB, allocated inside the target) and the shortfall is **measured and
reported instead of assumed away**. Measured: on a 35 GB heap the walk delivered 1.7 GB and only
3 240 of 13 138 344 objects were reachable — 95% of the heap's events had been dropped, and
everything that did arrive agreed with itself perfectly. Two checks catch that, both of them
against facts that did not come from the walk:

- the **reachable share** (a walk of a live heap should have essentially all of its objects
  reachable from a root; measured 99.995% on a healthy heap),
- the **byte total against the runtime's own `TotalHeapSize`** for the same collection.

When either says the walk is partial, the payload carries a `coverageNote` explaining it, the
type totals are presented as a floor, and **no retention path is reported** — a chain drawn
through a graph with references missing is a guess, which is the one thing this payload must
never be. The `inventory` field lists the event kinds the session actually saw, so a graph built
from a partial stream is visible rather than inferred.

### Payload and UI

`heap.snapshot` carries per-type object count and live bytes (exact accounting, not a sample),
per-type and per-frame retained bytes, the retention paths for the largest types, the root counts,
the walk's own cost (`pauseMs`, `durationMs`) and the honesty fields above.

The two byte measures answer different questions and the payload states both rather than picking
one: **live bytes** is what a type's objects occupy, and **retained bytes** is what would no longer
be reachable if every object of that type were removed — what the type *holds*, not what it
occupies. The second is the number a reader acts on, and it is computed by walking the graph again
without those objects (`HeapGraphAnalysis`), one walk per question: exact by construction, and the
only mechanism that can answer it for a whole type, since objects held through two different
instances are dominated by neither. Measured on the sample: `SessionRecord` occupies 119.5 MB and
accounts for 825.6 MB; the 92.6 MB entry array accounts for 918.2 MB.

A dominator tree was the first implementation and is worth knowing about: it produces the same
number for every object in one pass, but the iterative dominance algorithm does not survive this
graph — its ancestor walks are long enough that a 6–7 M object heap reached the pass's safety
budget after ~80 s of CPU with no result. Since a full removal walk measured 34 ms on the same
heap, the tree bought nothing and cost a stall. Each question is now bounded by a walk budget, and
the payload carries a `retainedNote` when that budget, or the size of the heap, stopped it short.

The panel is `src/components/HeapSnapshotPanel.tsx`, registered in `src/panels/registry.tsx`
under `heap` and fed by `store.snapshots` in `src/lib/store.ts`. A walk is a button rather than
a periodic sample, the panel states the pause it costs, and the retention chains are rendered
root-first because the top of the chain is the reference a reader has to cut.

### Verifying it

`src-tauri/tests/collector_contract.rs` drives the whole path against the sample: it starts a
session with **only** this probe enabled, sends `{"cmd":"snapshot"}`, and asserts that the walk
names `SessionRecord`, that its byte total is positive and its pause is reported, that the type and
every frame of its chain carry a retained size that is at least the object's own size and no larger
than the heap, and that removing the records frees **more** than the records themselves — which is
the assertion that would catch a retained measure accidentally wired to the live one. It also
asserts that the retention path to it ends at `SessionRecord`, passes through the `Dictionary` and
its `Entry[]` array, and starts at a root the runtime named. The same test is what keeps the
completeness accounting honest: a partial walk must withhold its paths.
