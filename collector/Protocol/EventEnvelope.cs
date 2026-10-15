using System.Text.Json;

namespace MemorySpy.Collector.Protocol;

/// <summary>
/// The wire format spoken by the collector on stdout (NDJSON) and stdin (commands).
///
/// Design rule: every message is a single line of JSON with the same envelope, so the
/// host can parse the stream with a trivial line reader and never needs to know about
/// individual probe payloads. New probes only add new <see cref="MessageType"/> values.
/// </summary>
public sealed record EventEnvelope
{
    /// <summary>Protocol version. Bump only on breaking envelope changes.</summary>
    public int V { get; init; } = 1;

    /// <summary>Monotonic sequence number per collector process.</summary>
    public long Seq { get; init; }

    /// <summary>Unix epoch milliseconds on the collector clock.</summary>
    public long Ts { get; init; }

    /// <summary>Message type, e.g. "counter.sample" or "heap.stats".</summary>
    public required string Type { get; init; }

    /// <summary>Id of the probe that produced this message (null for control messages).</summary>
    public string? Probe { get; init; }

    /// <summary>Probe-specific payload.</summary>
    public object? Data { get; init; }
}

/// <summary>
/// Canonical message type names. Probes may emit custom types; these are the ones the
/// host understands out of the box.
/// </summary>
public static class MessageType
{
    public const string Hello = "hello";
    public const string SessionStarted = "session.started";
    public const string SessionStopped = "session.stopped";
    public const string TargetExited = "target.exited";
    public const string CounterSample = "counter.sample";
    public const string AllocationSample = "allocation.sample";

    /// <summary>
    /// Sampled allocations folded by call site, resolved from a finished raw capture. Unlike
    /// the other message types this one arrives after the stream has ended, because call
    /// stacks can only be named from a complete file.
    /// </summary>
    public const string AllocationSite = "allocation.site";
    /// <summary>
    /// A live object graph taken on demand: objects and bytes per type, plus the reference chain
    /// from a GC root to the largest instances. Unlike the other probes this one runs its own
    /// short EventPipe session, because the heap-walk keyword it needs must never be merged into
    /// the shared session.
    /// </summary>
    public const string HeapSnapshot = "heap.snapshot";
    public const string HeapStats = "heap.stats";
    public const string GcEvent = "gc.event";
    public const string GcSummary = "gc.summary";
    public const string Error = "error";
    public const string Log = "log";
    public const string CommandResult = "command.result";
    public const string ProcessList = "process.list";
    public const string ProcessDetail = "process.detail";
}

/// <summary>A single counter reading within a <see cref="MessageType.CounterSample"/> batch.</summary>
public sealed record CounterReading
{
    public required string Name { get; init; }
    public required string DisplayName { get; init; }
    public required string Category { get; init; }

    /// <summary>Value converted to the canonical unit declared by <see cref="Unit"/>.</summary>
    public required double Value { get; init; }

    /// <summary>Canonical unit: bytes, bytes-per-second, percent, count, ms, ratio.</summary>
    public required string Unit { get; init; }

    /// <summary>Unit exactly as the runtime reported it (MB, B, %, ""), for auditing.</summary>
    public string? RawUnit { get; init; }

    /// <summary>Mean | Sum | Rate — how to interpret the value across an interval.</summary>
    public string? CounterType { get; init; }

    /// <summary>True when the counter reports a size that belongs in a memory chart.</summary>
    public bool IsMemory { get; init; }

    /// <summary>What the counter means and why it matters, surfaced as a UI tooltip.</summary>
    public string? Description { get; init; }

    /// <summary>Optional threshold hints so the UI can colour the value.</summary>
    public double? WarnAbove { get; init; }
    public double? CriticalAbove { get; init; }
}

public static class CollectorJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };
}
