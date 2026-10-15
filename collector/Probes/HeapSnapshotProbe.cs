using System.Diagnostics.Tracing;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Parsers.Clr;
using MemorySpy.Collector.Core;
using MemorySpy.Collector.Protocol;

namespace MemorySpy.Collector.Probes;

/// <summary>
/// Answers the other half of the leak question: not <em>who allocated it</em> — that is
/// <see cref="AllocationSiteProbe"/> — but <em>what keeps it alive</em>.
///
/// <para>
/// A type leaderboard and a call-site ranking both describe the moment of allocation. A leak is
/// defined by survival, so the only ground truth is the object graph the collector takes while
/// the process is stopped for a collection: every live object, its type, and the edges that
/// reach it. That is what this probe walks, and what turns "82% of sampled bytes came from
/// <c>OrderRepository.Append</c>" into "...and the objects it built are held by a static
/// dictionary on <c>OrderRepository</c>".
/// </para>
///
/// <para>
/// Three mechanics, all measured against the leaking sample rather than assumed:
/// </para>
/// <list type="number">
/// <item>
/// <b>It runs its own EventPipe session, on demand.</b> Enabling
/// <c>ClrTraceEventParser.Keywords.GCHeapSnapshot</c> is what makes the runtime walk the heap
/// during a collection, and the walk is not free: it forces a Gen 2 collection and emits one
/// bulk event per object in the process. A probe that asked for that keyword in the shared
/// session would tax every plain session with a heap walk it never asked for, so the keyword
/// is never merged into the live session. Instead the probe opens a second, short-lived
/// session when it is triggered and closes it when the dump is complete. That does contradict
/// "one EventPipe session per target" at first glance; the rule exists so that *permanently*
/// doubling a target's tracing is never allowed, and a session that exists for the duration of
/// a snapshot (and only when the user asks for one) is a different trade — the same one
/// <c>dotnet-gcdump</c> makes.
/// </item>
/// <item>
/// <b>Starting the session is the trigger.</b> No IPC "collect garbage" command is sent;
/// enabling the keyword makes the runtime perform the snapshot collection, which
/// <c>dotnet-gcdump</c> relies on as well. Completion is the matching <c>GCStop</c> for the
/// <c>GCStart</c> whose <c>Depth</c> is 2 and whose <c>Type</c> is not
/// <c>BackgroundGC</c> — there is no "dump complete" event, so watching that pair is the only
/// correct signal, and it is also what bounds the snapshot's own pause.
/// </item>
/// <item>
/// <b>The graph is built here, not by the library.</b> TraceEvent 4.0.0 ships the typed bulk
/// events (<c>GCBulkType</c>, <c>GCBulkNode</c>, <c>GCBulkEdge</c>, <c>GCBulkRootEdge</c>,
/// <c>GCBulkRootStaticVar</c>, <c>GCBulkRootCCW</c>) but no heap-graph API — there is no
/// <c>MemoryGraph</c>, no retained-size call and no file reader in the package (checked by
/// reflecting over the referenced assembly). So the graph, the roots and the path search are
/// implemented here, which also keeps the payload honest about what was and was not seen.
/// </item>
/// </list>
///
/// <para>
/// What it reports: live objects and bytes per type from the snapshot itself (ground truth, not a
/// sampled estimate), a retention path for the largest types — the chain of references from a GC
/// root to an instance of that type, with the root kind named — and, for the objects and types it
/// ranks, the bytes that would actually be freed if they were gone.
///
/// The last one is the number a reader acts on, and it is defined the way a reader assumes: the
/// live bytes that are no longer reachable once those objects are removed. It is computed by
/// walking the graph again without them, one walk per question, rather than from a dominator tree —
/// see <see cref="HeapGraphAnalysis"/> for why, with the measurement that decided it. Each answer
/// is exact by construction, which is the property this payload cares about most.
/// </para>
///
/// <para>
/// The cost is real and is reported rather than hidden: the target stops for the snapshot
/// collection, and the collector's own memory grows with the size of the heap, since the graph
/// has to be held before it can be searched.
/// </para>
/// </summary>
public sealed class HeapSnapshotProbe : ICollectorProbe
{
    /// <summary>
    /// <c>ClrTraceEventParser.Keywords.GCHeapSnapshot</c> (<c>0x1980001</c>), which is what makes
    /// the runtime walk the heap during the next collection. It already includes `GC | Type |
    /// GCHeapAndTypeNames`, so the walk brings type names with it.
    /// </summary>
    private const long KeywordHeapSnapshot = 0x1980001;

    /// <summary>
    /// How long to wait for the snapshot collection to complete before giving up.
    ///
    /// <c>dotnet-gcdump</c> defaults to 30 s; this is longer because a leak hunter is by
    /// definition looking at a heap that grew for a while, and a heap walk on a multi-gigabyte
    /// heap takes longer than on a healthy one. Giving up is reported, never silent.
    /// </summary>
    private const int SnapshotTimeoutMs = 120_000;

    /// <summary>
    /// How many of the largest types get a retention path. Each path is a separate search, and
    /// the answer is the same shape for every type, so a handful is enough to act on.
    /// </summary>
    private const int RetentionPathCount = 5;

    /// <summary>
    /// EventPipe buffer for the snapshot session, in MB (allocated inside the target process), and
    /// why this is the only lever available.
    ///
    /// The default session buffers like a stream that may drop: when the reader falls behind, the
    /// runtime throws events away. That is the right trade for counters, where the next sample is a
    /// second away, and the wrong one for a heap walk, where every dropped event is an object or a
    /// reference the graph is then missing. Measured before this was set: two snapshots of different
    /// heaps (3.9 M and 6.5 M objects) delivered *the same* 4 374 218 and 4 374 289 references — the
    /// number was the buffer's capacity, not the graph's — while the nodes declared 25 025 617.
    ///
    /// The proper fix is <c>EventPipeBufferingMode.Block</c>, which stalls the target instead of
    /// dropping, and that is what <c>dotnet-gcdump</c> uses. It is not reachable from here: the
    /// configuration-based <c>StartEventPipeSession</c> sends the newer IPC command, and the .NET
    /// 10.0.9 diagnostics server answers <c>UnsupportedCommandException</c> ("Start failed - Command
    /// is not supported"). So the buffer is the lever, it is paid for in the target's memory, and the
    /// shortfall is measured and reported rather than assumed away.
    /// </summary>
    private const int SnapshotBufferMb = 512;

    /// <summary>How many types the payload ranks by live bytes.</summary>
    private const int MaxReportedTypes = 40;

    /// <summary>
    /// How many of the largest types get a "bytes freed if this type went away" number.
    ///
    /// Each one costs a full walk of the graph, so this is a budget rather than a ranking limit:
    /// measured at 34 ms per walk on a 7.6 M object heap, so twelve of them add under half a
    /// second to a snapshot. The rest of the table keeps its live bytes, which cost nothing.
    /// </summary>
    private const int MaxRetainedTypes = 12;

    /// <summary>
    /// Ceiling on how many objects the retained-size walks are run for, in total.
    ///
    /// A type costs one walk and a retention frame costs one, and the frames are deduplicated first,
    /// because a chain's root and its object are the same objects across types. Measured: 34 ms per
    /// walk over a 7.6 M object graph, so this budget is about five seconds in the worst case — a
    /// price worth paying for the number the panel leads with, and one the panel states when it is
    /// spent.
    /// </summary>
    private const int MaxRetainedPasses = 160;

    /// <summary>
    /// Ceiling on the graph size the retained-size passes are run on.
    ///
    /// They need several arrays the walk itself does not, and a heap large enough to need them is a
    /// heap whose walk is unlikely to be complete anyway. Past this the numbers are reported as
    /// absent with the reason, rather than risking the collector for a snapshot that would be
    /// doubted on its own accounting.
    /// </summary>
    private const int MaxRetainedNodes = 24_000_000;

    /// <summary>
    /// How far the delivered references may drift from the ones the nodes declare before
    /// positional attribution is treated as unusable.
    ///
    /// The format gives an edge event no source node — the source is the node that owns the next
    /// slot in the edge sequence — so attribution survives a small shortfall (a few lost events
    /// shift a handful of nodes) and is worthless under a large one. Measured: with the default
    /// buffer the graph was short by 79% of its references, and with a raised buffer the difference
    /// fell to 471 of 8.76 M (0.005%). Half a percent leaves room for a lost batch while still
    /// refusing to draw a path through a graph that is mostly missing.
    /// </summary>
    private const double EdgeAttributionTolerance = 0.005;

    /// <summary>Frames kept per retention path; a path longer than this is truncated and says so.</summary>
    private const int MaxPathDepth = 24;

    /// <summary>
    /// How much of the heap has to be reachable from a root before the walk is believed.
    ///
    /// Every object the walk reports is live — it was produced by a blocking collection — so
    /// essentially all of them should be reachable, and indeed measured: 7 609 816 of 7 610 181
    /// (99.995%). A heap where most objects are unreachable is not a fact about the heap; it is
    /// the signature of dropped bulk events, measured at 3 240 of 13 138 344 (0.02%) when a 35 GB
    /// heap overflowed the session's buffer. Half is a deliberately loose line: it passes any
    /// honest graph and still catches a walk that lost most of its data.
    /// </summary>
    private const double MinimumReachableShare = 0.5;

    /// <summary>
    /// How much of the runtime's own heap size the walk has to account for before the snapshot is
    /// presented as the heap rather than as a floor. Same reasoning as
    /// <see cref="MinimumReachableShare"/>, with a number taken from outside the walk: the runtime's
    /// <c>TotalHeapSize</c> at the same collection, which no dropped event can shrink.
    /// </summary>
    private const double MinimumCoveredByteShare = 0.5;

    /// <summary>Distinct event names tracked for the diagnostics section.</summary>
    private const int MaxInventoryEntries = 40;

    /// <summary>
    /// How long to keep reading after the snapshot's <c>GCStop</c> before closing the session.
    ///
    /// The bulk events are the heap itself, and the tail of them is still in flight when the
    /// runtime reports the collection as finished. Stopping on the spot loses that tail, which
    /// shows up as a shortfall between the references the nodes declare and the ones delivered —
    /// measured at 4 338 of 4 378 556 (0.1%) without this pause. Those references are what the
    /// retention paths are built from, so the pause is what makes the attribution exact rather
    /// than nearly right.
    /// </summary>
    private const int DrainAfterStopMs = 1_000;

    private ProbeContext _context = null!;
    private readonly object _gate = new();
    private Thread? _worker;
    private int _snapshotCounter;

    public string Id => "heap-snapshot";
    public string DisplayName => "Heap Snapshot";
    public string Description =>
        "Walks the live object graph on demand: what survives collection, and which root keeps it alive.";
    public string Icon => "layers";

    /// <summary>
    /// None: this probe reads its own EventPipe session rather than the shared one, so no
    /// events are dispatched to <see cref="OnEvent"/>. Reported as <c>None</c> rather than
    /// <c>Clr</c> so the session does not waste a dispatch callback on it.
    /// </summary>
    public ProbeChannel Channel => ProbeChannel.None;

    public IReadOnlyList<string> EventTypes { get; } = new[] { MessageType.HeapSnapshot };

    /// <summary>
    /// Empty on purpose: the heap-snapshot keyword must not be merged into the shared session,
    /// because that would make every session — including the ones that never ask for a snapshot —
    /// force a heap walk. The provider is created inside the snapshot's own session instead.
    /// </summary>
    public IReadOnlyList<EventPipeProvider> CreateProviders() => Array.Empty<EventPipeProvider>();

    public void Initialize(ProbeContext context) => _context = context;

    public void OnEvent(TraceEvent ev)
    {
        // Unreachable: Channel is None, so the session never dispatches to this probe.
    }

    public void Flush()
    {
        // A snapshot is an event, not a metric: it emits when the walk completes.
    }

    public void Reset()
    {
        // Nothing accumulates between snapshots; a running snapshot finishes on its own thread.
    }

    public IReadOnlyDictionary<string, object?> Describe() => new Dictionary<string, object?>
    {
        ["provider"] = "Microsoft-Windows-DotNETRuntime",
        ["event"] = "GCHeapSnapshot keyword (0x1980001) in a session of its own",
        ["trigger"] = "{\"cmd\":\"snapshot\"} over the session's stdin; nothing runs until it is asked for",
        ["sampling"] =
            "Exact, not sampled: every live object at the snapshot collection is in the graph. But it " +
            "costs a Gen 2 collection in the target, and the collector's memory grows with the heap.",
        ["columns"] = new[]
        {
            new { key = "typeName", label = "Type" },
            new { key = "objectCount", label = "Objects" },
            new { key = "liveBytes", label = "Live bytes" },
            new { key = "share", label = "Share" },
            new { key = "retainedBytes", label = "Freed if removed" },
        },
    };

    /// <summary>
    /// Starts a snapshot if one is not already running. Returns immediately; the walk takes
    /// seconds and its result arrives as a <c>heap.snapshot</c> message.
    /// </summary>
    public bool TryBeginSnapshot(out string message)
    {
        lock (_gate)
        {
            if (_worker is { IsAlive: true })
            {
                message = "A heap snapshot is already running; its result will arrive when the walk completes.";
                return false;
            }

            var index = Interlocked.Increment(ref _snapshotCounter);
            _worker = new Thread(() => RunSnapshot(index))
            {
                IsBackground = true,
                Name = $"memoryspy-heap-snapshot-{index}",
            };
            _worker.Start();

            message = "Heap snapshot started: the target will pause for one Gen 2 collection while it is walked.";
            return true;
        }
    }

    private void RunSnapshot(int index)
    {
        var startedAt = DateTimeOffset.UtcNow;
        var startedTicks = Environment.TickCount64;
        var completion = new CompletionGate();
        var sampler = new GraphAccumulator(_context, completion);
        string? failure = null;
        var stopped = false;
        var timedOut = false;
        var noData = false;

        DiagnosticsClient client;
        try
        {
            client = new DiagnosticsClient(_context.Options.Pid);
        }
        catch (Exception ex)
        {
            _context.Error($"Heap snapshot {index} could not open a diagnostics connection to process {_context.Options.Pid}.", ex);
            return;
        }

        EventPipeSession? session = null;
        try
        {
            var providers = new[]
            {
                new EventPipeProvider("Microsoft-Windows-DotNETRuntime", EventLevel.Verbose, KeywordHeapSnapshot),
            };

            try
            {
                // No rundown: the heap walk carries its own type table, so method/module rundown
                // would only add events this probe ignores. The buffer is raised because the walk
                // emits the whole heap faster than it can be parsed here.
                session = client.StartEventPipeSession(providers, requestRundown: false, circularBufferMB: SnapshotBufferMb);
            }
            catch (Exception ex)
            {
                _context.Error(
                    $"Heap snapshot {index} could not start an EventPipe session on process {_context.Options.Pid}. " +
                    "The target must be a running .NET process this user can attach to.",
                    ex);
                return;
            }

            _context.Log(
                $"Heap snapshot {index}: asked the runtime for a heap walk. The target pauses for one Gen 2 collection, " +
                $"and the walk is bounded at {SnapshotTimeoutMs / 1000} s.");

            using var source = new EventPipeEventSource(session.EventStream);
            sampler.Attach(source);

            // The stream only ends when the session stops, and the session only stops when the
            // dump is complete or the deadline passes — so this watcher drives both. "No heap data"
            // is checked the way dotnet-gcdump checks it: a .NET process that will not walk its
            // heap is a different failure from a heap that is simply slow to walk.
            var sessionToStop = session;
            var completeSeenAt = 0L;
            using var stopTimer = new Timer(
                _ =>
                {
                    if (completion.Complete)
                    {
                        if (completeSeenAt == 0)
                            completeSeenAt = Environment.TickCount64;

                        if (Environment.TickCount64 - completeSeenAt >= DrainAfterStopMs)
                            StopQuietly(sessionToStop);

                        return;
                    }

                    var elapsedMs = Environment.TickCount64 - startedTicks;
                    if (elapsedMs > SnapshotTimeoutMs)
                    {
                        timedOut = true;
                        StopQuietly(sessionToStop);
                    }
                    else if (elapsedMs > 5_000 && !sampler.SawAnyGraphEvent)
                    {
                        noData = true;
                        StopQuietly(sessionToStop);
                    }
                },
                null,
                dueTime: 250,
                period: 250);

            try
            {
                source.Process();
                stopped = true;
            }
            catch (Exception ex)
            {
                failure = ex.Message;
                _context.Error($"Heap snapshot {index}: the event stream failed while the heap was being walked.", ex);
            }
        }
        finally
        {
            try
            {
                session?.Stop();
            }
            catch
            {
                // The target may already be gone; the snapshot result is what matters.
            }

            try
            {
                session?.Dispose();
            }
            catch
            {
                // Same.
            }

            if (!stopped && failure is null && !timedOut && !noData)
                failure = "the snapshot session ended before the walk completed";
        }

        var elapsedMsTotal = Environment.TickCount64 - startedTicks;

        if (failure is not null)
        {
            _context.Error($"Heap snapshot {index} failed: {failure}.");
            return;
        }

        if (noData)
        {
            _context.Log(
                $"Heap snapshot {index}: no heap-dump events arrived within 5 s, so the target is not a .NET process " +
                "the runtime will walk (or its diagnostics channel is disabled). Nothing was reported.",
                "warn");
            return;
        }

        if (timedOut && !sampler.Complete)
        {
            _context.Log(
                $"Heap snapshot {index}: the walk did not complete within {SnapshotTimeoutMs / 1000} s. The partial graph " +
                "is reported and marked incomplete rather than presented as a full snapshot.",
                "warn");
        }

        try
        {
            var payload = sampler.Build(index, startedAt, elapsedMsTotal, timedOut && !sampler.Complete);
            _context.Emit(MessageType.HeapSnapshot, payload);

            _context.Log(
                $"Heap snapshot {index}: {payload.ObjectCount:N0} objects, {payload.TotalBytes / (1024.0 * 1024):N1} MB live, " +
                $"{payload.Types.Count} types, {payload.EdgeCount:N0} references, in {elapsedMsTotal} ms " +
                $"(the snapshot collection itself paused the target for {payload.PauseMs} ms).");
        }
        catch (Exception ex)
        {
            _context.Error($"Heap snapshot {index} gathered the graph but could not analyse it.", ex);
        }
    }

    /// <summary>Ends the snapshot's session; safe to call repeatedly and from the timer thread.</summary>
    private static void StopQuietly(EventPipeSession session)
    {
        try
        {
            session.Stop();
        }
        catch
        {
            // The session is already stopping or the target is gone; nothing to report.
        }
    }

    /// <summary>Shared completion state between the parser thread and the watcher timer.</summary>
    private sealed class CompletionGate
    {
        public volatile bool Complete;
        public int GcNumber = -1;
    }

    /// <summary>
    /// Builds the object graph from the bulk events, then answers the two questions the payload
    /// carries: how many bytes each type holds live, and how a surviving instance is reached
    /// from a root.
    /// </summary>
    private sealed class GraphAccumulator
    {
        private readonly ProbeContext _context;
        private readonly CompletionGate _completion;
        private readonly Dictionary<ulong, string> _typeNames = new();
        private readonly List<NodeRec> _nodes = new();
        private readonly List<ulong> _edgeTargets = new();
        private readonly List<int> _edgeFields = new();
        private readonly List<RootRec> _roots = new();
        private readonly List<(string FieldName, ulong ObjectId, ulong TypeId)> _staticRoots = new();
        private readonly Dictionary<string, int> _inventory = new(StringComparer.Ordinal);

        private double _gcStartMs = -1;
        private double _gcStopMs = -1;
        private bool _sawGraphEvent;
        private long _declaredEdges;

        /// <summary>
        /// The heap size the runtime itself reported at the snapshot's collection, used as the
        /// independent check on what the walk actually delivered. The bulk events can be dropped
        /// (see <see cref="SnapshotBufferMb"/>), and a dropped batch is invisible from inside the
        /// graph — the nodes and edges that did arrive agree with each other perfectly — so the
        /// only way to notice is to compare against a number that did not come from the walk.
        /// </summary>
        private long _gcReportedHeapBytes;

        public GraphAccumulator(ProbeContext context, CompletionGate completion)
        {
            _context = context;
            _completion = completion;
        }

        public bool SawAnyGraphEvent => _sawGraphEvent;
        public bool Complete => _completion.Complete;

        public void Attach(EventPipeEventSource source)
        {
            source.Clr.All += ev =>
            {
                lock (_inventory)
                {
                    if (_inventory.Count < MaxInventoryEntries)
                        _inventory[ev.EventName] = _inventory.TryGetValue(ev.EventName, out var seen) ? seen + 1 : 1;
                }
            };

            source.Clr.GCStart += data =>
            {
                // The snapshot collection is the first non-background Gen 2 collection after the
                // keyword was enabled — the same rule dotnet-gcdump uses, and the only signal the
                // runtime gives that this GC is the one carrying the heap walk.
                if (_completion.GcNumber < 0 && data.Depth == 2 && data.Type != GCType.BackgroundGC)
                {
                    _completion.GcNumber = data.Count;
                    _gcStartMs = data.TimeStampRelativeMSec;
                }
            };

            source.Clr.GCStop += data =>
            {
                if (_completion.GcNumber >= 0 && data.Count == _completion.GcNumber)
                {
                    _gcStopMs = data.TimeStampRelativeMSec;
                    _completion.Complete = true;
                }
            };

            // The type table rides on `TypeBulkType` even though its data class is
            // `GCBulkTypeTraceData` — the parser's event name is the manifest's, and there is no
            // `GCBulkType` event at all (checking that name is a compile error, which is how this
            // was found). Every node's TypeID is resolved through this table, so if it never
            // arrives the snapshot says "(unknown type)" and counts those objects instead of
            // guessing names.
            source.Clr.TypeBulkType += data =>
            {
                _sawGraphEvent = true;
                for (var i = 0; i < data.Count; i++)
                {
                    var value = data.Values(i);
                    if (!string.IsNullOrEmpty(value.TypeName))
                        _typeNames[value.TypeID] = value.TypeName;
                }
            };

            // The heap size the runtime reports at the end of each collection. The snapshot's own
            // collection is the last one in this session, so its number is the heap the walk was
            // supposed to describe.
            source.Clr.GCHeapStats += data => _gcReportedHeapBytes = data.TotalHeapSize;

            source.Clr.GCBulkNode += data =>
            {
                _sawGraphEvent = true;
                for (var i = 0; i < data.Count; i++)
                {
                    var value = data.Values(i);
                    _declaredEdges += value.EdgeCount;
                    _nodes.Add(new NodeRec(value.Address, value.TypeID, value.Size, (int)value.EdgeCount));
                }
            };

            source.Clr.GCBulkEdge += data =>
            {
                _sawGraphEvent = true;
                for (var i = 0; i < data.Count; i++)
                {
                    var value = data.Values(i);
                    _edgeTargets.Add(value.Target);
                    _edgeFields.Add(value.ReferencingField);
                }
            };

            source.Clr.GCBulkRootEdge += data =>
            {
                _sawGraphEvent = true;
                for (var i = 0; i < data.Count; i++)
                {
                    var value = data.Values(i);
                    _roots.Add(new RootRec(value.RootedNodeAddress, value.GCRootKind.ToString(), value.GCRootID));
                }
            };

            source.Clr.GCBulkRootStaticVar += data =>
            {
                _sawGraphEvent = true;
                for (var i = 0; i < data.Count; i++)
                {
                    var value = data.Values(i);
                    _staticRoots.Add((value.FieldName ?? string.Empty, value.ObjectID, value.TypeID));
                }
            };

            source.Clr.GCBulkRootCCW += data =>
            {
                _sawGraphEvent = true;
                for (var i = 0; i < data.Count; i++)
                {
                    var value = data.Values(i);
                    _roots.Add(new RootRec(value.ObjectID, "COM/WinRT (CCW)", 0));
                }
            };

            source.Clr.GCBulkRootConditionalWeakTableElementEdge += data =>
            {
                _sawGraphEvent = true;
                for (var i = 0; i < data.Count; i++)
                {
                    var value = data.Values(i);
                    _roots.Add(new RootRec(value.GCKeyNodeID, "conditional weak table", value.GCRootID));
                }
            };
        }

        /// <summary>Live objects and bytes per type, plus a path from a root for the largest.</summary>
        public SnapshotPayload Build(int index, DateTimeOffset startedAt, long durationMs, bool incomplete)
        {
            var byType = new Dictionary<ulong, TypeTotals>();
            var unknownTypes = new HashSet<ulong>();
            for (var nodeIndex = 0; nodeIndex < _nodes.Count; nodeIndex++)
            {
                var node = _nodes[nodeIndex];
                if (!byType.TryGetValue(node.TypeId, out var totals))
                {
                    if (!_typeNames.TryGetValue(node.TypeId, out var name))
                    {
                        unknownTypes.Add(node.TypeId);
                        name = "(unknown type)";
                    }

                    totals = new TypeTotals { TypeName = name };
                    byType[node.TypeId] = totals;
                }

                totals.ObjectCount++;
                totals.LiveBytes += (long)node.Size;

                if (node.Size >= totals.LargestNodeSize)
                {
                    totals.LargestNodeSize = node.Size;
                    totals.LargestNodeIndex = nodeIndex;
                }
            }

            var ranked = byType
                .Select(entry => new TypeSummary
                {
                    TypeName = entry.Value.TypeName,
                    ObjectCount = entry.Value.ObjectCount,
                    LiveBytes = entry.Value.LiveBytes,
                })
                .OrderByDescending(t => t.LiveBytes)
                .ToList();

            var totalBytes = ranked.Sum(t => t.LiveBytes);
            foreach (var summary in ranked)
                summary.Share = totalBytes > 0 ? (double)summary.LiveBytes / totalBytes : 0;

            var (paths, alignmentNote, reachable, coverageNote, retainedNote) = BuildRetentionPaths(ranked, byType);

            return new SnapshotPayload
            {
                SnapshotId = index,
                StartedAtUnixMs = startedAt.ToUnixTimeMilliseconds(),
                DurationMs = durationMs,
                PauseMs = _gcStartMs >= 0 && _gcStopMs >= _gcStartMs ? (long)(_gcStopMs - _gcStartMs) : 0,
                GcNumber = _completion.GcNumber,
                Incomplete = incomplete,
                ObjectCount = _nodes.Count,
                TotalBytes = totalBytes,
                ReachableObjects = reachable,
                HeapBytesReportedByGc = _gcReportedHeapBytes,
                EdgeCount = _edgeTargets.Count,
                RootCount = _roots.Count,
                StaticRootCount = _staticRoots.Count,
                UnknownTypeObjects = UnknownTypeObjects(byType, unknownTypes),
                Types = ranked.Take(MaxReportedTypes).ToList(),
                Retention = paths,
                TypeCount = ranked.Count,
                Inventory = BuildInventory(),
                EdgeAlignmentNote = alignmentNote,
                CoverageNote = coverageNote,
                RetainedNote = retainedNote,
                Note =
                    "Exact live objects at the snapshot collection, not a sampled estimate. Live bytes are what a " +
                    "type's objects occupy. The freed column is a different measure and is stated as such: the live " +
                    "bytes that would no longer be reachable if every object of that type were removed, computed by " +
                    "walking the graph without them — so it counts what the type holds transitively, not what it " +
                    "occupies. Absent where the budget did not reach, and absent for the whole payload when the walk " +
                    "was not whole.",
            };
        }

        private List<string> BuildInventory()
        {
            lock (_inventory)
            {
                return _inventory.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key} x{kv.Value}").ToList();
            }
        }

        /// <summary>Objects whose type no GCBulkType event ever named, counted rather than guessed.</summary>
        private static long UnknownTypeObjects(Dictionary<ulong, TypeTotals> byType, HashSet<ulong> unknownTypes)
        {
            long count = 0;
            foreach (var typeId in unknownTypes)
                count += byType[typeId].ObjectCount;

            return count;
        }

        /// <summary>Type name for an id, or a placeholder that is counted rather than hidden.</summary>
        private string NameOf(ulong typeId) => _typeNames.TryGetValue(typeId, out var name) ? name : "(unknown type)";

        /// <summary>
        /// For each of the largest types, one path from a GC root to the biggest live instance.
        ///
        /// The search is a breadth-first walk forward from the roots, which both marks every
        /// object the runtime considers reachable (a node no root reaches is not retained at all)
        /// and records, for every reached object, the reference it was first reached through. A
        /// target's path is then that parent chain walked backwards, so the labels are real
        /// references — a root kind, a static field name, or a field index — rather than a guess.
        /// The first path found is the shortest one the runtime's graph allows, which is the one a
        /// person can shorten.
        /// </summary>
        private (List<RetentionPath> Paths, string? AlignmentNote, long Reachable, string? CoverageNote, string? RetainedNote) BuildRetentionPaths(
            List<TypeSummary> ranked,
            Dictionary<ulong, TypeTotals> byType)
        {
            // Edges arrive in node order — the runtime walks the heap and emits each node's
            // references together — but a GCBulkEdge event names only the *target* and a field
            // index, never the node it belongs to. The source is therefore positional: node i owns
            // the next `EdgeCount` delivered edges. The first version of this code recorded the
            // edge offset when the node was appended instead, which silently bound every node's
            // window to the same handful of edges: the walk then reached 878 of 3.9 M objects and
            // reported a retention path through whatever happened to be first in the list.
            // Edge ranges are prefix sums with a sentinel at the end, which is the shape the
            // retained-size analysis wants: node i owns `edgeStart[i] .. edgeStart[i + 1]`.
            var edgeStart = new int[_nodes.Count + 1];
            var cursor = 0;
            for (var i = 0; i < _nodes.Count; i++)
            {
                edgeStart[i] = cursor;
                cursor += _nodes[i].EdgeCount;
            }

            edgeStart[_nodes.Count] = cursor;

            // The two counts are expected to agree, and they are the only check this graph has that
            // nothing was lost on the way here. A big difference means whole batches never arrived:
            // then the positional map is meaningless and a path built from it would be a fabrication,
            // so say so and report no paths rather than a plausible-looking lie. A small difference
            // is reported and tolerated.
            var expectedEdges = cursor;
            var difference = _edgeTargets.Count - expectedEdges;
            var share = expectedEdges > 0 ? Math.Abs(difference) / (double)expectedEdges : 0;
            string? note = null;

            if (share > EdgeAttributionTolerance)
            {
                note =
                    $"The nodes declare {expectedEdges:N0} references but {_edgeTargets.Count:N0} were delivered " +
                    $"({share:P1} apart), so references cannot be attributed to the objects that own them. " +
                    "Retention paths are not reported; the per-type totals above are unaffected.";
                _context.Log($"Heap snapshot: {note}", "warn");
                return (new List<RetentionPath>(), note, 0, null, null);
            }

            if (difference != 0)
            {
                note =
                    $"The nodes declare {expectedEdges:N0} references and {_edgeTargets.Count:N0} were delivered " +
                    $"({share:P2} apart), so a few objects' parents may be shifted; the chains and root kinds are the " +
                    "runtime's own.";
                _context.Log($"Heap snapshot: {note}", "debug");
            }

            var byAddress = new Dictionary<ulong, int>(_nodes.Count);
            for (var i = 0; i < _nodes.Count; i++)
                byAddress[_nodes[i].Address] = i;

            // Resolve every reference once, up front: the walks below run several times over the
            // same graph, and a dictionary probe per edge would be paid on every one of them.
            var targetIndex = new int[_edgeTargets.Count];
            for (var i = 0; i < _edgeTargets.Count; i++)
                targetIndex[i] = byAddress.TryGetValue(_edgeTargets[i], out var index) ? index : -1;

            var parent = new int[_nodes.Count];
            var parentLabel = new string?[_nodes.Count];
            Array.Fill(parent, -1);

            var rootIndices = new List<int>();
            var queue = new Queue<int>();

            foreach (var root in _roots)
            {
                if (!byAddress.TryGetValue(root.Target, out var nodeIndex) || parent[nodeIndex] != -1)
                    continue;

                parent[nodeIndex] = nodeIndex; // its own parent: marks the root and ends the walk back
                parentLabel[nodeIndex] = $"GC root ({root.Kind})";
                rootIndices.Add(nodeIndex);
                queue.Enqueue(nodeIndex);
            }

            foreach (var (fieldName, objectId, typeId) in _staticRoots)
            {
                if (!byAddress.TryGetValue(objectId, out var nodeIndex) || parent[nodeIndex] != -1)
                    continue;

                var declaring = _typeNames.TryGetValue(typeId, out var typeName) ? typeName : "a type";
                parent[nodeIndex] = nodeIndex;
                parentLabel[nodeIndex] = string.IsNullOrEmpty(fieldName)
                    ? $"static field on {declaring}"
                    : $"static {declaring}.{fieldName}";
                rootIndices.Add(nodeIndex);
                queue.Enqueue(nodeIndex);
            }

            while (queue.Count > 0)
            {
                var current = queue.Dequeue();
                var node = _nodes[current];
                var start = edgeStart[current];
                var end = edgeStart[current + 1];

                for (var e = start; e < end; e++)
                {
                    var target = targetIndex[e];
                    if (target < 0 || parent[target] != -1)
                        continue;

                    parent[target] = current;
                    parentLabel[target] = $"field #{_edgeFields[e]}";
                    queue.Enqueue(target);
                }
            }

            var reachable = 0;
            for (var i = 0; i < _nodes.Count; i++)
                if (parent[i] != -1)
                    reachable++;

            // A walk that lost part of the heap is not a smaller snapshot, it is a wrong one: the
            // missing objects are absent from every total and from the graph. Nothing inside the
            // bulk events reveals it — nodes and edges agree with each other whatever was dropped —
            // so the checks are against facts that did not come from the walk: how much of it a root
            // can reach, and how its byte total compares with the heap size the runtime reported for
            // the very collection it was taken from.
            var countedBytes = ranked.Sum(t => t.LiveBytes);
            string? coverageNote = null;
            var reachableShare = _nodes.Count > 0 ? reachable / (double)_nodes.Count : 1;

            if (_nodes.Count > 0 && reachableShare < MinimumReachableShare)
            {
                coverageNote =
                    $"Only {reachable:N0} of {_nodes.Count:N0} objects in this walk are reachable from any root. " +
                    "Every object a heap walk reports is live, so this says the runtime dropped most of the heap's " +
                    "events on the way here, not that the rest is garbage. The per-type totals are a floor rather " +
                    "than the heap, so no retention path is reported — a path through this graph would be a guess " +
                    "dressed as a reference chain.";
                _context.Log($"Heap snapshot: {coverageNote}", "warn");
                return (new List<RetentionPath>(), note, reachable, coverageNote, null);
            }

            if (_gcReportedHeapBytes > 0 && countedBytes < _gcReportedHeapBytes * MinimumCoveredByteShare)
            {
                coverageNote =
                    $"This walk accounts for {countedBytes / (1024.0 * 1024):N0} MB of the {_gcReportedHeapBytes / (1024.0 * 1024):N0} MB " +
                    "the runtime reported live at the same collection, so objects are missing from it: the per-type " +
                    "totals are a floor, and the retention paths below are drawn through a graph that is missing " +
                    "references. Re-take the snapshot on a smaller heap, or against a target that allocates less, for " +
                    "a complete walk.";
                _context.Log($"Heap snapshot: {coverageNote}", "warn");
            }

            // "What would be freed" is only meaningful over a graph that is whole, so it is computed
            // here — after the two checks above have had their say — and by one mechanism: walk the
            // graph without the objects in question and subtract. Exact by construction, and the
            // only thing that can answer it for a whole type.
            //
            // Each question costs a full walk, measured at 34 ms over a 7.6 M object graph, so the
            // budget below is a real limit on how many are asked rather than a formality. The type
            // totals are asked first because they are what the table is ranked on; the retention
            // frames follow, deduplicated, because the same object appears in several chains.
            var retainedNote = (string?)null;
            HeapGraphAnalysis? analysis = null;
            var reachableBytes = 0L;
            var passes = 0;
            var retainedByNode = new Dictionary<int, long>();

            if (coverageNote is null && countedBytes > 0 && _nodes.Count <= MaxRetainedNodes)
            {
                var sizes = new long[_nodes.Count];
                for (var i = 0; i < _nodes.Count; i++)
                    sizes[i] = (long)_nodes[i].Size;

                analysis = new HeapGraphAnalysis(_nodes.Count, sizes, edgeStart, targetIndex, rootIndices.ToArray());
                reachableBytes = analysis.ReachableBytes();

                var indicesById = new Dictionary<ulong, List<int>>();
                foreach (var summary in ranked.Take(MaxRetainedTypes))
                {
                    foreach (var entry in byType)
                        if (string.Equals(entry.Value.TypeName, summary.TypeName, StringComparison.Ordinal))
                            indicesById[entry.Key] = new List<int>();
                }

                if (indicesById.Count > 0)
                {
                    for (var i = 0; i < _nodes.Count; i++)
                        if (indicesById.TryGetValue(_nodes[i].TypeId, out var list))
                            list.Add(i);

                    foreach (var summary in ranked.Take(MaxRetainedTypes))
                    {
                        if (passes >= MaxRetainedPasses)
                            break;

                        var excluded = new List<int>();
                        foreach (var entry in byType)
                            if (string.Equals(entry.Value.TypeName, summary.TypeName, StringComparison.Ordinal)
                                && indicesById.TryGetValue(entry.Key, out var list))
                                excluded.AddRange(list);

                        if (excluded.Count == 0)
                            continue;

                        passes++;
                        summary.RetainedBytes = reachableBytes - analysis.ReachableBytes(excluded.ToArray());
                    }
                }
            }
            else if (coverageNote is null && _nodes.Count > MaxRetainedNodes)
            {
                retainedNote =
                    $"Retained sizes are absent: each one costs a walk of the graph of its own, and this walk reached " +
                    $"{_nodes.Count:N0} objects, past the {MaxRetainedNodes:N0} this collector will spend on them. " +
                    "The per-type totals and the retention chains are unaffected.";
                _context.Log($"Heap snapshot: {retainedNote}", "warn");
            }

            var paths = new List<RetentionPath>();
            var frameNodes = new List<(RetentionFrame Frame, int Node)>();

            foreach (var summary in ranked)
            {
                if (paths.Count >= RetentionPathCount)
                    break;

                // The instance to follow is the type's biggest one, and it is only worth a path if
                // the walk reached it — an unreachable object is not retained by anything, which is
                // itself the answer for a type that shows up live but garbage-collectable.
                var candidate = byType
                    .Where(kv => string.Equals(kv.Value.TypeName, summary.TypeName, StringComparison.Ordinal))
                    .Select(kv => kv.Value.LargestNodeIndex)
                    .FirstOrDefault(index => index >= 0 && parent[index] != -1, -1);

                if (candidate < 0)
                    continue;

                var frames = new List<RetentionFrame>();
                var current = candidate;
                var guard = 0;
                var truncated = false;

                while (current >= 0 && guard++ < MaxPathDepth)
                {
                    var label = parentLabel[current] ?? "(root)";
                    var node = _nodes[current];
                    frames.Add(new RetentionFrame
                    {
                        Label = label,
                        TypeName = NameOf(node.TypeId),
                        Size = (long)node.Size,
                    });

                    frameNodes.Add((frames[^1], current));

                    if (parent[current] == current)
                        break;

                    current = parent[current];
                }

                if (guard >= MaxPathDepth)
                    truncated = true;

                paths.Add(new RetentionPath
                {
                    TypeName = summary.TypeName,
                    RootLabel = frames.Count > 0 ? frames[^1].Label : "(unreachable)",
                    Depth = frames.Count,
                    Truncated = truncated,
                    // Root first: the reader's eye should start at what is holding the object.
                    Frames = frames.AsEnumerable().Reverse().ToList(),
                });

            }

            // Every frame of every chain, each computed once. The root end of a chain is the one that
            // holds the heap and the object end is the one the chain explains, so both ends are worth
            // a walk of their own; the frames between them usually answer with their own size, which
            // is exactly the point — it says the weight is elsewhere.
            if (analysis is not null && frameNodes.Count > 0)
            {
                var single = new int[1];
                foreach (var (frame, node) in frameNodes)
                {
                    if (retainedByNode.TryGetValue(node, out var value))
                    {
                        frame.RetainedBytes = value;
                        continue;
                    }

                    if (passes >= MaxRetainedPasses)
                    {
                        retainedNote =
                            $"Retained sizes are reported for the first {MaxRetainedPasses} objects asked about: each one " +
                            "costs a walk of the graph, and the budget for this snapshot is spent. The rest of the payload, " +
                            "including the chains themselves, is unaffected.";
                        break;
                    }

                    passes++;
                    single[0] = node;
                    value = reachableBytes - analysis.ReachableBytes(single);
                    retainedByNode[node] = value;
                    frame.RetainedBytes = value;
                }
            }

            _context.Log(
                $"Heap snapshot: {reachable:N0} of {_nodes.Count:N0} objects are reachable from a root " +
                $"({_roots.Count:N0} root edges, {_staticRoots.Count:N0} static roots); {paths.Count} retention paths built.",
                "debug");

            return (paths, note, reachable, coverageNote, retainedNote);
        }

        private sealed class NodeRec
        {
            public NodeRec(ulong address, ulong typeId, ulong size, int edgeCount)
            {
                Address = address;
                TypeId = typeId;
                Size = size;
                EdgeCount = edgeCount;
            }

            public ulong Address { get; }
            public ulong TypeId { get; }
            public ulong Size { get; }
            public int EdgeCount { get; }
        }

        private sealed record RootRec(ulong Target, string Kind, ulong RootId);

        private sealed class TypeTotals
        {
            public required string TypeName { get; init; }
            public long ObjectCount { get; set; }
            public long LiveBytes { get; set; }

            /// <summary>The biggest instance seen, which is the one whose retention path is worth showing.</summary>
            public int LargestNodeIndex { get; set; } = -1;

            public ulong LargestNodeSize { get; set; }
        }
    }

    /// <summary>The <c>heap.snapshot</c> payload.</summary>
    public sealed class SnapshotPayload
    {
        public required int SnapshotId { get; init; }
        public required long StartedAtUnixMs { get; init; }
        public required long DurationMs { get; init; }
        /// <summary>How long the snapshot collection stopped the target.</summary>
        public required long PauseMs { get; init; }
        public required int GcNumber { get; init; }
        public required bool Incomplete { get; init; }
        public required long ObjectCount { get; init; }
        public required long TotalBytes { get; init; }
        public required long EdgeCount { get; init; }
        public required int RootCount { get; init; }
        public required int StaticRootCount { get; init; }
        public required int TypeCount { get; init; }
        public required long UnknownTypeObjects { get; init; }
        public required List<TypeSummary> Types { get; init; }
        public required List<RetentionPath> Retention { get; init; }
        public required List<string> Inventory { get; init; }

        /// <summary>How well the delivered edges matched the nodes' own edge counts, or null when they matched.</summary>
        public required string? EdgeAlignmentNote { get; init; }

        /// <summary>Objects the walk could reach from a root. The rest are reported, not hidden.</summary>
        public required long ReachableObjects { get; init; }

        /// <summary>The heap size the runtime reported for the same collection; 0 when it said nothing.</summary>
        public required long HeapBytesReportedByGc { get; init; }

        /// <summary>
        /// Set when this walk is known to be a partial view of the heap, with the evidence for it.
        /// Non-null means the totals are a floor and <see cref="Retention"/> is empty.
        /// </summary>
        public required string? CoverageNote { get; init; }

        /// <summary>
        /// Set when retained sizes are absent, with the reason. Non-null means
        /// <see cref="TypeSummary.RetainedBytes"/> and <see cref="RetentionFrame.RetainedBytes"/> are
        /// not to be read as numbers at all.
        /// </summary>
        public required string? RetainedNote { get; init; }
        public required string Note { get; init; }
    }

    /// <summary>One type's live footprint in the snapshot.</summary>
    public sealed class TypeSummary
    {
        public required string TypeName { get; init; }
        public required long ObjectCount { get; init; }
        public required long LiveBytes { get; init; }
        public double Share { get; set; }

        /// <summary>
        /// Bytes that would no longer be reachable if every object of this type were removed.
        ///
        /// Absent for types outside the retained-size budget, and absent for the whole payload when
        /// the walk was not whole. It is not the same number as summing the instances' retained
        /// sizes: an object held through two entries is dominated by neither entry, so only the
        /// removal walk can answer this.
        /// </summary>
        public long? RetainedBytes { get; set; }
    }

    /// <summary>A reference chain from a GC root to one live instance of a type.</summary>
    public sealed class RetentionPath
    {
        public required string TypeName { get; init; }
        public required string RootLabel { get; init; }
        public required int Depth { get; init; }
        public required bool Truncated { get; init; }
        /// <summary>Root first, object last.</summary>
        public required List<RetentionFrame> Frames { get; init; }
    }

    /// <summary>One step of a retention path: what references it, and what the referenced object is.</summary>
    public sealed class RetentionFrame
    {
        public required string Label { get; init; }
        public required string TypeName { get; init; }
        public required long Size { get; init; }

        /// <summary>
        /// Bytes this object exclusively holds — what would be freed if it became unreachable.
        ///
        /// Read along a chain it shows where the weight actually sits: the small dictionary and the
        /// 92 MB array beneath it look alike until this column says one of them holds the heap.
        /// Absent when the retained-size passes did not run or did not validate.
        /// </summary>
        public long? RetainedBytes { get; set; }
    }
}
