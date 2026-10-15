using MemorySpy.Collector.Protocol;

namespace MemorySpy.Collector.Core;

/// <summary>
/// Everything a probe is allowed to touch: the emitter, its own id, the session options
/// and a small scratch bag for state that needs to survive between events.
/// </summary>
public sealed class ProbeContext
{
    public ProbeContext(string probeId, Emitter emitter, CollectorOptions options)
    {
        ProbeId = probeId;
        Emitter = emitter;
        Options = options;
    }

    public string ProbeId { get; }
    public Emitter Emitter { get; }
    public CollectorOptions Options { get; }

    /// <summary>Session start time, used to report relative timestamps.</summary>
    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;

    public void Emit(string type, object? data) => Emitter.Emit(type, ProbeId, data);

    public void Log(string message, string level = "info") => Emitter.Log(level, message, ProbeId);

    public void Error(string message, Exception? ex = null) => Emitter.Error(message, ProbeId, ex);

    /// <summary>Per-probe scratch storage, keyed by the probe itself.</summary>
    public T GetOrAdd<T>(Func<T> factory) where T : class
    {
        lock (_scratch)
        {
            if (_scratch.TryGetValue(ProbeId, out var existing) && existing is T typed)
                return typed;
            var created = factory();
            _scratch[ProbeId] = created;
            return created;
        }
    }

    private readonly Dictionary<string, object> _scratch = new();
}
