using System.Diagnostics.Tracing;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;
using MemorySpy.Collector.Core;
using MemorySpy.Collector.Protocol;

namespace MemorySpy.Collector.Probes;

/// <summary>
/// Answers the question "which class is growing?".
///
/// The runtime samples allocations roughly every 100 KB and raises
/// <c>GC/AllocationTick</c> with the allocated type's name
/// (available because the <c>GCHeapAndTypeNames</c> keyword is enabled). Aggregating
/// those ticks per type over an interval gives an allocation-rate leaderboard, which is
/// the fastest way to spot the object that keeps piling up.
///
/// Note the deliberate distinction between <em>allocated</em> and <em>retained</em>:
/// allocation volume tells you what is being created, while growth of the heap tells you
/// what survives collection. The UI pairs this probe with the timestamped memory counters
/// so a type whose allocation rate rises together with Gen 2 can be picked out as the
/// likely leak.
/// </summary>
public sealed class AllocationProbe : ICollectorProbe
{
    private const long KeywordGc = 0x1;
    private const long KeywordGcHeapAndTypeNames = 0x01000000;

    private ProbeContext _context = null!;
    private readonly object _gate = new();
    private readonly Dictionary<string, TypeAccumulator> _types = new(StringComparer.Ordinal);
    private long _intervalBytes;
    private long _intervalTicks;
    private long _totalBytes;
    private long _totalTicks;
    private long _lastFlushTicks = Environment.TickCount64;

    public string Id => "allocations";
    public string DisplayName => "Allocations by Type";
    public string Description => "Sampled allocations per type, ranked by growth — finds the object that keeps growing.";
    public string Icon => "layers";
    public ProbeChannel Channel => ProbeChannel.Clr;

    public IReadOnlyList<string> EventTypes { get; } = new[] { MessageType.AllocationSample };

    public IReadOnlyList<EventPipeProvider> CreateProviders() => new[]
    {
        new EventPipeProvider(
            "Microsoft-Windows-DotNETRuntime",
            EventLevel.Verbose,
            keywords: KeywordGc | KeywordGcHeapAndTypeNames),
    };

    public void Initialize(ProbeContext context) => _context = context;

    public void OnEvent(TraceEvent ev)
    {
        if (!ev.EventName.EndsWith("AllocationTick", StringComparison.Ordinal))
            return;

        var typeName = ev.PayloadByName("TypeName")?.ToString();
        if (string.IsNullOrWhiteSpace(typeName))
            return;

        long bytes = 0;
        try
        {
            bytes = Convert.ToInt64(ev.PayloadByName("AllocationAmount64") ?? ev.PayloadByName("AllocationAmount") ?? 0L);
        }
        catch
        {
            // Older payload revisions may not carry the 64-bit field; fall back to the tick size.
        }

        var objectSize = 0L;
        try
        {
            objectSize = Convert.ToInt64(ev.PayloadByName("ObjectSize") ?? 0L);
        }
        catch
        {
            // Ignore — ObjectSize is informational only.
        }

        lock (_gate)
        {
            if (!_types.TryGetValue(typeName, out var acc))
            {
                acc = new TypeAccumulator(typeName, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                _types[typeName] = acc;
            }

            acc.Add(bytes, objectSize);
            _intervalBytes += bytes;
            _intervalTicks++;
            _totalBytes += bytes;
            _totalTicks++;
        }
    }

    public void Flush()
    {
        List<TypeSnapshot> types;
        long intervalBytes, intervalTicks, totalBytes, totalTicks, elapsedMs;

        lock (_gate)
        {
            if (_types.Count == 0)
                return;

            var now = Environment.TickCount64;
            elapsedMs = Math.Max(1, now - _lastFlushTicks);
            _lastFlushTicks = now;

            intervalBytes = _intervalBytes;
            intervalTicks = _intervalTicks;
            totalBytes = _totalBytes;
            totalTicks = _totalTicks;
            _intervalBytes = 0;
            _intervalTicks = 0;

            types = _types.Values.Select(a => a.Snapshot(elapsedMs)).ToList();
        }

        var ranked = types
            .OrderByDescending(t => t.IntervalBytes)
            .ThenByDescending(t => t.TotalBytes)
            .Take(_context.Options.MaxAllocationTypes)
            .ToList();

        _context.Emit(MessageType.AllocationSample, new
        {
            intervalMs = elapsedMs,
            totalIntervalBytes = intervalBytes,
            totalIntervalTicks = intervalTicks,
            totalBytes,
            totalTicks,
            // The runtime samples roughly one event per 100 KB of allocation; exposed so the
            // UI can label the numbers as estimates rather than exact accounting.
            tickApproximateBytes = 100 * 1024,
            typeCount = _types.Count,
            types = ranked,
        });
    }

    public IReadOnlyDictionary<string, object?> Describe() => new Dictionary<string, object?>
    {
        ["provider"] = "Microsoft-Windows-DotNETRuntime",
        ["event"] = "GC/AllocationTick",
        ["keywords"] = "GC | GCHeapAndTypeNames",
        ["sampling"] = "The runtime samples roughly every 100 KB of allocation; values are scaled estimates, not exact accounting.",
        ["columns"] = new[]
        {
            new { key = "typeName", label = "Type" },
            new { key = "intervalBytes", label = "Allocated (interval)" },
            new { key = "intervalBytesPerSecond", label = "Alloc rate" },
            new { key = "totalBytes", label = "Allocated (total)" },
            new { key = "averageObjectBytes", label = "Avg object" },
            new { key = "tickCount", label = "Samples" },
        },
    };

    public void Reset()
    {
        lock (_gate)
        {
            _types.Clear();
            _intervalBytes = _intervalTicks = 0;
            _totalBytes = _totalTicks = 0;
            _lastFlushTicks = Environment.TickCount64;
        }
    }

    private sealed class TypeAccumulator
    {
        private readonly string _typeName;
        private readonly long _firstSeenUnixMs;
        private long _intervalBytes;
        private long _totalBytes;
        private long _tickCount;
        private long _sizedSampleCount;
        private long _sizedSampleBytes;
        private long _largestObjectSize;
        private long _lastSeenUnixMs;

        public TypeAccumulator(string typeName, long firstSeenUnixMs)
        {
            _typeName = typeName;
            _firstSeenUnixMs = firstSeenUnixMs;
        }

        public void Add(long bytes, long objectSize)
        {
            _intervalBytes += bytes;
            _totalBytes += bytes;
            _tickCount++;
            _lastSeenUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            if (objectSize > 0)
            {
                _sizedSampleCount++;
                _sizedSampleBytes += objectSize;
                if (objectSize > _largestObjectSize)
                    _largestObjectSize = objectSize;
            }
        }

        public TypeSnapshot Snapshot(long elapsedMs)
        {
            var snapshot = new TypeSnapshot
            {
                TypeName = _typeName,
                IntervalBytes = _intervalBytes,
                IntervalBytesPerSecond = elapsedMs > 0 ? _intervalBytes * 1000.0 / elapsedMs : 0,
                TotalBytes = _totalBytes,
                TickCount = _tickCount,
                SizedSampleCount = _sizedSampleCount,
                // Only ticks that actually carried an object size are averaged; otherwise a
                // single 44 MB array tick would be averaged against thousands of tiny ones
                // and the number would be meaningless.
                AverageObjectBytes = _sizedSampleCount > 0 ? (double)_sizedSampleBytes / _sizedSampleCount : 0,
                LargestObjectBytes = _largestObjectSize,
                FirstSeenUnixMs = _firstSeenUnixMs,
                LastSeenUnixMs = _lastSeenUnixMs,
            };
            _intervalBytes = 0;
            return snapshot;
        }
    }

    public sealed record TypeSnapshot
    {
        public required string TypeName { get; init; }
        public required long IntervalBytes { get; init; }
        public required double IntervalBytesPerSecond { get; init; }
        public required long TotalBytes { get; init; }
        public required long TickCount { get; init; }
        public required long SizedSampleCount { get; init; }
        public required double AverageObjectBytes { get; init; }
        public required long LargestObjectBytes { get; init; }
        public required long FirstSeenUnixMs { get; init; }
        public required long LastSeenUnixMs { get; init; }
    }
}
