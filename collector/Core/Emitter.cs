using System.Text;
using System.Text.Json;
using MemorySpy.Collector.Protocol;

namespace MemorySpy.Collector.Core;

/// <summary>
/// Serialises <see cref="EventEnvelope"/> instances to stdout as newline delimited JSON.
///
/// The emitter is the only component allowed to write to stdout, so the stream stays
/// well formed even when probes run on many threads. Anything meant for humans goes to
/// stderr through <see cref="Log"/>.
/// </summary>
public sealed class Emitter
{
    private readonly object _gate = new();
    private readonly TextWriter _out;
    private readonly TextWriter _err;
    private long _seq;
    private volatile bool _rawEvents;

    public Emitter(TextWriter? stdout = null, TextWriter? stderr = null, bool includeRawEvents = false)
    {
        _out = stdout ?? Console.Out;
        _err = stderr ?? Console.Error;
        _rawEvents = includeRawEvents;
    }

    /// <summary>When true, every TraceEvent seen by a probe is also mirrored as a log line.</summary>
    public bool RawEvents
    {
        get => _rawEvents;
        set => _rawEvents = value;
    }

    public event Action<EventEnvelope>? Emitted;

    public void Emit(string type, string? probe = null, object? data = null)
    {
        var envelope = new EventEnvelope
        {
            Seq = Interlocked.Increment(ref _seq),
            Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Type = type,
            Probe = probe,
            Data = data,
        };

        var line = JsonSerializer.Serialize(envelope, CollectorJson.Options);
        lock (_gate)
        {
            _out.Write(line);
            _out.Write('\n');
            _out.Flush();
        }

        Emitted?.Invoke(envelope);
    }

    public void Error(string message, string? probe = null, Exception? ex = null)
        => Emit(MessageType.Error, probe, new
        {
            message,
            exception = ex?.GetType().FullName,
            detail = ex?.Message,
            stack = ex?.StackTrace,
        });

    public void Log(string level, string message, string? probe = null)
        => Emit(MessageType.Log, probe, new { level, message });

    public void Debug(string message, string? probe = null)
    {
        var line = new StringBuilder("[memoryspy] ").Append(message).ToString();
        lock (_gate)
        {
            _err.Write(line);
            _err.Write('\n');
            _err.Flush();
        }
    }
}
