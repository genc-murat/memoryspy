using System.Diagnostics.Tracing;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;
using MemorySpy.Collector.Core;
using MemorySpy.Collector.Protocol;

namespace MemorySpy.Collector.Probes;

/// <summary>
/// Answers the question "which class is growing?".
///
/// The runtime samples allocations and reports them with the allocated type's name
/// (available because the <c>GCHeapAndTypeNames</c> keyword is enabled). Aggregating those
/// samples per type over an interval gives an allocation-rate leaderboard, which is the
/// fastest way to spot the object that keeps piling up.
///
/// <para>
/// Two event kinds carry that sample, and which one arrives is decided by the session's
/// keywords, not by this probe (see <see cref="BasisTick"/> and
/// <see cref="BasisAllocationSampling"/>): with <c>GC | GCHeapAndTypeNames</c> alone the
/// runtime raises a tick roughly every 100 KB, while a session that also enables
/// <c>AllocationSampling</c> — which the call-site probe must, because the older
/// sampled-allocation mechanism emits nothing on .NET 10 — raises per-allocation samples and
/// no ticks at all. Matching only the tick name therefore blanked this panel for exactly the
/// session the user had armed to find a leaking line: measured on .NET 10.0.9, 758 ticks
/// (7 intervals of samples) without a capture and 776 <c>AllocationSampling</c> events with
/// one, of which this probe accepted none. Both kinds are read now, and the basis that was
/// actually used travels with the numbers.
/// </para>
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

    /// <summary>
    /// Basis reported when the runtime sent <c>GC/AllocationTick</c> (id 10): one event per
    /// ~100 KB of allocation, so the volume attributed to a type is a scaled estimate.
    /// </summary>
    public const string BasisTick = "tick";

    /// <summary>
    /// Basis reported when the runtime sent <c>AllocationSampling</c> (id 303): one event per
    /// sampled allocation, carrying that object's own size. Shares between types are unbiased,
    /// but the volumes are on a much smaller scale than the tick basis — measured against the
    /// leaking sample, 17.9 MB/s on the tick basis against 0.04 MB/s on this one — so the two
    /// are never presented as if they were the same number.
    /// </summary>
    public const string BasisAllocationSampling = "allocationSampling";

    private ProbeContext _context = null!;
    private readonly object _gate = new();
    private readonly Dictionary<string, TypeAccumulator> _types = new(StringComparer.Ordinal);
    private long _intervalBytes;
    private long _intervalTicks;
    private long _totalBytes;
    private long _totalTicks;
    private long _lastFlushTicks = Environment.TickCount64;

    /// <summary>Which event kind is feeding the numbers right now, or null before the first.</summary>
    private string? _basis;

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
        // Both names, because the runtime picks the event kind from the session's keywords:
        // a capture-armed session gets AllocationSampling and no ticks at all.
        var isSample = ev.EventName.Contains("AllocationSampling", StringComparison.Ordinal);
        var isTick = !isSample && ev.EventName.EndsWith("AllocationTick", StringComparison.Ordinal);
        if (!isSample && !isTick)
            return;

        var typeName = ev.PayloadByName("TypeName")?.ToString();
        if (string.IsNullOrWhiteSpace(typeName))
            return;

        var objectSize = ReadLong(ev, "ObjectSize");

        long bytes;
        if (isSample)
        {
            // A per-allocation sample reports the allocated object's own size, which is both the
            // volume and the object size; there is no tick to scale it from.
            bytes = objectSize > 0 ? objectSize : ReadLong(ev, "AllocationAmount64");
        }
        else
        {
            bytes = ReadLong(ev, "AllocationAmount64");
            if (bytes <= 0)
                bytes = ReadLong(ev, "AllocationAmount");
        }

        lock (_gate)
        {
            _basis = isSample ? BasisAllocationSampling : BasisTick;

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

    /// <summary>
    /// Reads a numeric payload field, tolerating the payload revisions that carry different
    /// width fields. A missing or unparsable field reads as 0 rather than throwing.
    /// </summary>
    private static long ReadLong(TraceEvent ev, string field)
    {
        try
        {
            return Convert.ToInt64(ev.PayloadByName(field) ?? 0L);
        }
        catch
        {
            return 0;
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
            // Which event kind produced these numbers, so the UI can label them for what they
            // are: a capture-armed session reports per-allocation samples, not 100 KB ticks.
            samplingBasis = _basis,
            // How much allocation one tick stands for. Only meaningful on the tick basis; on the
            // sample basis each event carries its object's size instead, so this is reported as 0.
            tickApproximateBytes = _basis == BasisAllocationSampling ? 0 : TickApproximateBytes,
            typeCount = _types.Count,
            types = ranked,
        });
    }

    /// <summary>How much allocation one <c>GC/AllocationTick</c> stands for.</summary>
    private const int TickApproximateBytes = 100 * 1024;

    public IReadOnlyDictionary<string, object?> Describe() => new Dictionary<string, object?>
    {
        ["provider"] = "Microsoft-Windows-DotNETRuntime",
        ["event"] = "GC/AllocationTick (id 10) or AllocationSampling (id 303)",
        ["keywords"] = "GC | GCHeapAndTypeNames (+ AllocationSampling when a deep capture is armed)",
        ["sampling"] =
            "The runtime samples allocations rather than logging every one, so values are estimates: " +
            "with the plain keyword set it raises one AllocationTick per ~100 KB allocated, and in a " +
            "session that has a deep capture armed it raises per-allocation AllocationSampling events " +
            "carrying the object's own size instead. Which one is in force is reported per interval as " +
            "samplingBasis; shares between types are unbiased on either basis, absolute volumes are not " +
            "comparable across the two.",
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
            _basis = null;
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
