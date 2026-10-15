using System.Diagnostics.Tracing;
using System.Globalization;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;
using MemorySpy.Collector.Core;
using MemorySpy.Collector.Protocol;

namespace MemorySpy.Collector.Probes;

/// <summary>
/// Streams the <c>System.Runtime</c> EventCounters — the same set that
/// <c>dotnet-counters monitor</c> prints, including working set, GC heap size, generation
/// sizes, LOH size, allocation rate and thread pool state.
///
/// The runtime emits one self-describing <c>EventCounters</c> event per counter per
/// interval. Values live in <c>Mean</c> (gauge) or <c>Increment</c> (Sum) depending on the
/// counter type, and the unit is carried in <c>DisplayUnits</c>. Both quirks are resolved
/// here so downstream code sees a single consistent shape.
/// </summary>
public sealed class RuntimeCountersProbe : ICollectorProbe
{
    private ProbeContext _context = null!;
    private readonly object _gate = new();
    private readonly Dictionary<string, CounterReading> _latest = new(StringComparer.OrdinalIgnoreCase);
    private long _intervalMs;
    private long _sampleCount;

    public string Id => "runtime-counters";
    public string DisplayName => "Runtime Counters";
    public string Description => "Live .NET runtime counters: memory, GC, thread pool, JIT and CPU.";
    public string Icon => "gauge";
    public ProbeChannel Channel => ProbeChannel.Dynamic;

    public IReadOnlyList<string> EventTypes { get; } = new[] { MessageType.CounterSample };

    public IReadOnlyList<EventPipeProvider> CreateProviders() => new[]
    {
        new EventPipeProvider(
            "System.Runtime",
            EventLevel.Informational,
            keywords: unchecked((long)0xFFFFFFFFFFFFFFFF),
            arguments: new Dictionary<string, string>
            {
                // The runtime reads this argument to decide how often counters are published.
                ["EventCounterIntervalSec"] = _intervalSeconds,
            }),
    };

    public void Initialize(ProbeContext context)
    {
        _context = context;
        var seconds = Math.Max(1, context.Options.IntervalMs) / 1000.0;
        _intervalSeconds = seconds.ToString("0.###", CultureInfo.InvariantCulture);
    }

    private string _intervalSeconds = "1";

    public void OnEvent(TraceEvent ev)
    {
        if (!string.Equals(ev.EventName, "EventCounters", StringComparison.Ordinal))
            return;

        if (ev.PayloadValue(0) is not IDictionary<string, object> outer)
            return;

        if (!outer.TryGetValue("Payload", out var inner) || inner is not IDictionary<string, object> fields)
            return;

        var name = GetString(fields, "Name");
        if (string.IsNullOrEmpty(name))
            return;

        var counterType = GetString(fields, "CounterType");
        var rawUnit = GetString(fields, "DisplayUnits");

        // Sum counters report the delta in this interval; everything else is a gauge in Mean.
        var rawValue = string.Equals(counterType, "Sum", StringComparison.OrdinalIgnoreCase)
            ? GetDouble(fields, "Increment") ?? GetDouble(fields, "Mean")
            : GetDouble(fields, "Mean") ?? GetDouble(fields, "Increment");

        if (rawValue is null)
            return; // The counter had nothing to report this interval (e.g. no GC yet).

        if (double.TryParse(GetString(fields, "IntervalSec"), NumberStyles.Float, CultureInfo.InvariantCulture, out var intervalSec) && intervalSec > 0)
            Interlocked.Exchange(ref _intervalMs, (long)(intervalSec * 1000));

        var definition = CounterCatalog.Resolve(name, GetString(fields, "DisplayName"), rawUnit);
        var intervalForRate = Interlocked.Read(ref _intervalMs);
        if (intervalForRate <= 0)
            intervalForRate = _context.Options.IntervalMs;

        var reading = new CounterReading
        {
            Name = name,
            DisplayName = definition.DisplayName,
            Category = definition.Category,
            Value = CounterCatalog.Normalize(rawValue.Value, rawUnit, definition, intervalForRate),
            Unit = definition.Unit,
            RawUnit = string.IsNullOrWhiteSpace(rawUnit) ? null : rawUnit,
            CounterType = counterType,
            IsMemory = definition.IsMemory,
            Description = definition.Description,
            WarnAbove = definition.WarnAbove,
            CriticalAbove = definition.CriticalAbove,
        };

        lock (_gate)
        {
            _latest[name] = reading;
        }
    }

    public void Flush()
    {
        List<CounterReading> batch;
        long intervalMs;

        lock (_gate)
        {
            if (_latest.Count == 0)
                return;
            batch = _latest.Values.OrderBy(r => r.Category).ThenBy(r => r.DisplayName, StringComparer.OrdinalIgnoreCase).ToList();
            intervalMs = Interlocked.Read(ref _intervalMs);
        }

        _sampleCount++;
        _context.Emit(MessageType.CounterSample, new
        {
            intervalMs = intervalMs > 0 ? intervalMs : _context.Options.IntervalMs,
            sampleIndex = _sampleCount,
            counters = batch,
        });
    }

    public IReadOnlyDictionary<string, object?> Describe() => new Dictionary<string, object?>
    {
        ["provider"] = "System.Runtime",
        ["knownCounters"] = CounterCatalog.All.Values.Select(d => new
        {
            d.Name,
            d.DisplayName,
            d.Category,
            d.Unit,
            d.IsMemory,
            d.Description,
            d.WarnAbove,
            d.CriticalAbove,
        }).ToList(),
        ["normalisation"] = new[]
        {
            "Sizes are converted to bytes using the unit the runtime declares, so charts never mix MB and bytes.",
            "cpu-usage is scaled by the processor count: 100% means one core fully busy, matching top and ps.",
            "alloc-rate is converted to bytes per second, so the value does not change with the sampling interval.",
            "gen-N-size, loh-size and poh-size are the sizes the runtime recorded after the last collection; "
                + "gc-heap-size is the live total, so the two can differ slightly.",
        },
    };

    public void Reset()
    {
        lock (_gate)
            _latest.Clear();
    }

    private static string? GetString(IDictionary<string, object> fields, string key)
        => fields.TryGetValue(key, out var v) ? v?.ToString() : null;

    private static double? GetDouble(IDictionary<string, object> fields, string key)
    {
        if (!fields.TryGetValue(key, out var v) || v is null)
            return null;

        return v switch
        {
            double d => d,
            float f => f,
            long l => l,
            int i => i,
            _ => double.TryParse(v.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : null,
        };
    }
}
