using System.Diagnostics.Tracing;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;
using MemorySpy.Collector.Core;
using MemorySpy.Collector.Protocol;

namespace MemorySpy.Collector.Probes;

/// <summary>
/// Turns raw CLR GC events into two things the UI can act on:
///
/// 1. <c>heap.stats</c> — the per-generation heap breakdown the runtime publishes at the
///    end of every collection (Gen 0/1/2, LOH, POH, promoted bytes, pinned objects and
///    GC handle count). Compared against the generation counters, this is what tells you
///    *where* memory is accumulating.
/// 2. <c>gc.event</c> — an individual collection with its generation, reason, whether it
///    was a background collection, and the real pause duration measured from the trace
///    timestamps.
///
/// Pause timing comes from <see cref="TraceEvent.TimeStamp"/> rather than the wall clock
/// so it reflects when the runtime actually paused, not when the collector read the event.
/// </summary>
public sealed class GcStatsProbe : ICollectorProbe
{
    private const long KeywordGc = 0x1;
    private const long KeywordType = 0x00080000;
    private const long KeywordGcHeapAndTypeNames = 0x01000000;

    private ProbeContext _context = null!;
    private readonly object _gate = new();
    private readonly Dictionary<int, PendingGc> _pending = new();
    private long _finalizedObjects;
    private long _gen0, _gen1, _gen2;
    private long _lastFlushTicks = Environment.TickCount64;

    public string Id => "gc-stats";
    public string DisplayName => "GC & Heap";
    public string Description => "Per-generation heap composition, collection events and pause durations.";
    public string Icon => "activity";
    public ProbeChannel Channel => ProbeChannel.Clr;

    public IReadOnlyList<string> EventTypes { get; } = new[] { MessageType.HeapStats, MessageType.GcEvent, MessageType.GcSummary };

    public IReadOnlyList<EventPipeProvider> CreateProviders() => new[]
    {
        new EventPipeProvider(
            "Microsoft-Windows-DotNETRuntime",
            EventLevel.Verbose,
            keywords: KeywordGc | KeywordType | KeywordGcHeapAndTypeNames),
    };

    public void Initialize(ProbeContext context) => _context = context;

    public void OnEvent(TraceEvent ev)
    {
        switch (ev.EventName)
        {
            case "GC/Start":
                OnGcStart(ev);
                break;
            case "GC/Stop":
                OnGcStop(ev);
                break;
            case "GC/GlobalHeapHistory":
                OnGlobalHeapHistory(ev);
                break;
            case "GC/HeapStats":
                OnHeapStats(ev);
                break;
            case "GC/FinalizeObject":
                Interlocked.Increment(ref _finalizedObjects);
                break;
        }
    }

    private void OnGcStart(TraceEvent ev)
    {
        var count = (int)ReadLong(ev, "Count");
        var pending = new PendingGc
        {
            // Relative trace time is the right clock for durations; the wall clock is only
            // decoration for the UI timeline and may drift slightly from the trace clock.
            StartedAtRelativeMSec = ev.TimeStampRelativeMSec,
            StartedAtWallMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Reason = (int)ReadLong(ev, "Reason"),
            IsBackground = ReadLong(ev, "Type") == 1,
        };

        lock (_gate)
            _pending[count] = pending;
    }

    private void OnGcStop(TraceEvent ev)
    {
        var count = (int)ReadLong(ev, "Count");

        PendingGc? pending;
        lock (_gate)
        {
            if (!_pending.Remove(count, out pending))
                pending = null;
        }

        var pauseMs = pending is null ? (double?)null : Math.Max(0, ev.TimeStampRelativeMSec - pending.StartedAtRelativeMSec);

        var generation = ResolveGeneration(pending);
        switch (generation)
        {
            case 0: Interlocked.Increment(ref _gen0); break;
            case 1: Interlocked.Increment(ref _gen1); break;
            default: Interlocked.Increment(ref _gen2); break;
        }

        _context.Emit(MessageType.GcEvent, new
        {
            kind = "collection",
            gcCount = count,
            generation,
            generationName = GenerationName(generation),
            reason = pending?.Reason ?? -1,
            reasonName = ReasonName(pending?.Reason ?? -1),
            isBackground = pending?.IsBackground ?? false,
            pauseMs,
            startedAt = pending?.StartedAtWallMs,
        });
    }

    /// <summary>
    /// Arrives between GC/Start and GC/Stop and carries the condemned generation, which is
    /// the only reliable way to tell a gen 0 collection from a full blocking one.
    /// </summary>
    private void OnGlobalHeapHistory(TraceEvent ev)
    {
        var count = (int)ReadLong(ev, "Count");
        var condemned = (int)ReadLong(ev, "CondemnedGeneration");

        lock (_gate)
        {
            if (_pending.TryGetValue(count, out var pending))
                pending.CondemnedGeneration = condemned;
        }
    }

    private void OnHeapStats(TraceEvent ev)
    {
        var gen0 = ReadLong(ev, "GenerationSize0");
        var gen1 = ReadLong(ev, "GenerationSize1");
        var gen2 = ReadLong(ev, "GenerationSize2");
        var loh = ReadLong(ev, "GenerationSize3");
        var poh = ReadLong(ev, "GenerationSize4");

        _context.Emit(MessageType.HeapStats, new
        {
            totalHeapBytes = ReadLong(ev, "TotalHeapSize") is var total && total > 0 ? total : gen0 + gen1 + gen2 + loh + poh,
            totalPromotedBytes = ReadLong(ev, "TotalPromoted"),
            gen0Bytes = gen0,
            gen1Bytes = gen1,
            gen2Bytes = gen2,
            lohBytes = loh,
            pohBytes = poh,
            promotedGen0Bytes = ReadLong(ev, "TotalPromotedSize0"),
            promotedGen1Bytes = ReadLong(ev, "TotalPromotedSize1"),
            promotedGen2Bytes = ReadLong(ev, "TotalPromotedSize2"),
            promotedLohBytes = ReadLong(ev, "TotalPromotedSize3"),
            promotedPohBytes = ReadLong(ev, "TotalPromotedSize4"),
            finalizationPromotedBytes = ReadLong(ev, "FinalizationPromotedSize"),
            finalizationPromotedCount = ReadLong(ev, "FinalizationPromotedCount"),
            pinnedObjectCount = ReadLong(ev, "PinnedObjectCount"),
            gcHandleCount = ReadLong(ev, "GCHandleCount"),
            sinkBlockCount = ReadLong(ev, "SinkBlockCount"),
            gen0Collections = Interlocked.Read(ref _gen0),
            gen1Collections = Interlocked.Read(ref _gen1),
            gen2Collections = Interlocked.Read(ref _gen2),
        });
    }

    /// <summary>
    /// Publishes the collections seen so far along with finalizer activity. The counters
    /// are cumulative and never reset, so the UI can compute per-interval rates by diffing
    /// consecutive samples without losing history when a flush is skipped.
    /// </summary>
    public void Flush()
    {
        var now = Environment.TickCount64;
        var elapsedMs = Math.Max(1, now - _lastFlushTicks);
        _lastFlushTicks = now;

        var finalized = Interlocked.Exchange(ref _finalizedObjects, 0);

        _context.Emit(MessageType.GcSummary, new
        {
            intervalMs = elapsedMs,
            gen0Collections = Interlocked.Read(ref _gen0),
            gen1Collections = Interlocked.Read(ref _gen1),
            gen2Collections = Interlocked.Read(ref _gen2),
            finalizedObjects = finalized,
        });
    }

    public IReadOnlyDictionary<string, object?> Describe() => new Dictionary<string, object?>
    {
        ["provider"] = "Microsoft-Windows-DotNETRuntime",
        ["events"] = new[] { "GC/Start", "GC/GlobalHeapHistory", "GC/Stop", "GC/HeapStats", "GC/FinalizeObject" },
        ["generations"] = new[] { "Gen 0", "Gen 1", "Gen 2", "LOH", "POH" },
        ["note"] = "Pause durations are measured from trace timestamps, so they reflect real runtime pauses.",
    };

    public void Reset()
    {
        lock (_gate)
            _pending.Clear();
        Interlocked.Exchange(ref _gen0, 0);
        Interlocked.Exchange(ref _gen1, 0);
        Interlocked.Exchange(ref _gen2, 0);
        Interlocked.Exchange(ref _finalizedObjects, 0);
        _lastFlushTicks = Environment.TickCount64;
    }

    private static int ResolveGeneration(PendingGc? pending)
    {
        if (pending is null)
            return 0;
        if (pending.CondemnedGeneration >= 0)
            return pending.CondemnedGeneration;

        // Fall back to the collection type when GlobalHeapHistory did not arrive.
        return pending.IsBackground ? 2 : 0;
    }

    private static long ReadLong(TraceEvent ev, string name)
    {
        try
        {
            var value = ev.PayloadByName(name);
            return value is null ? 0 : Convert.ToInt64(value);
        }
        catch
        {
            return 0;
        }
    }

    private static string GenerationName(int generation) => generation switch
    {
        0 => "Gen 0",
        1 => "Gen 1",
        _ => "Gen 2",
    };

    /// <summary>Mirrors the runtime's <c>gc_reason</c> enum so the UI never has to guess.</summary>
    private static string ReasonName(int reason) => reason switch
    {
        0 => "Small allocation",
        1 => "Induced",
        2 => "Low memory",
        3 => "Empty",
        4 => "Large allocation",
        5 => "Out of space (SOH)",
        6 => "Out of space (LOH)",
        7 => "Induced (not forced)",
        8 => "Internal",
        9 => "Induced low memory",
        10 => "Induced compacting",
        11 => "Low memory host",
        12 => "PM full GC",
        13 => "Low memory host (blocking)",
        _ => "Unknown",
    };

    private sealed class PendingGc
    {
        /// <summary>Trace-relative start time in milliseconds, used for accurate durations.</summary>
        public double StartedAtRelativeMSec { get; init; }

        /// <summary>Wall clock start time, for ordering events in the UI timeline.</summary>
        public long StartedAtWallMs { get; init; }
        public int Reason { get; init; }
        public bool IsBackground { get; init; }

        /// <summary>Set from GC/GlobalHeapHistory, which arrives between Start and Stop.</summary>
        public int CondemnedGeneration { get; set; } = -1;
    }
}
