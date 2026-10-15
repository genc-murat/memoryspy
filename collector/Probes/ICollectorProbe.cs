using System.Diagnostics.Tracing;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;
using MemorySpy.Collector.Core;

namespace MemorySpy.Collector.Probes;

/// <summary>
/// Which TraceEvent dispatch channel a probe subscribes to.
///
/// TraceEvent delivers every event twice: once through the strongly typed parser for a
/// known provider (<c>source.Clr.All</c>, which resolves real event names and payload
/// names) and once through <c>source.Dynamic.All</c> (which only resolves self-describing
/// EventSource providers and reports everything else as <c>EventID(n)</c>).
///
/// Probes must pick the channel where their payload resolves properly.
/// </summary>
[Flags]
public enum ProbeChannel
{
    None = 0,

    /// <summary>Self-describing EventSource providers, e.g. EventCounters from System.Runtime.</summary>
    Dynamic = 1,

    /// <summary>Providers with a manifest / built-in parser, e.g. Microsoft-Windows-DotNETRuntime.</summary>
    Clr = 2,

    Both = Dynamic | Clr,
}

/// <summary>
/// THE extension point of MemorySpy.
///
/// A probe is a self-contained metric source: it declares which EventPipe providers it
/// needs, receives the events it asked for, aggregates them, and flushes periodic
/// batches to the host. Adding a new diagnostic capability means adding one class here
/// plus (optionally) a panel on the UI side — nothing in the session, protocol, host or
/// app shell needs to change.
/// </summary>
public interface ICollectorProbe
{
    /// <summary>Stable identifier used on the command line and in the UI panel registry.</summary>
    string Id { get; }

    /// <summary>Human readable name shown in the UI.</summary>
    string DisplayName { get; }

    /// <summary>One-line explanation of what the probe measures.</summary>
    string Description { get; }

    /// <summary>Icon hint for the UI (see frontend panel registry for the allowed set).</summary>
    string Icon { get; }

    /// <summary>Channel(s) this probe wants to receive events from.</summary>
    ProbeChannel Channel { get; }

    /// <summary>Message types this probe can emit, so the host can route them.</summary>
    IReadOnlyList<string> EventTypes { get; }

    /// <summary>EventPipe providers (with keywords/level/config) this probe needs.</summary>
    IReadOnlyList<EventPipeProvider> CreateProviders();

    /// <summary>Called once before the session starts.</summary>
    void Initialize(ProbeContext context);

    /// <summary>
    /// Called for every event on <see cref="Channel"/>. Must be fast and must not block:
    /// it runs on the single TraceEvent parsing thread, so a slow probe throttles all
    /// other probes.
    /// </summary>
    void OnEvent(TraceEvent ev);

    /// <summary>Called on the interval timer; emit buffered aggregates here.</summary>
    void Flush();

    /// <summary>
    /// Machine readable description of the probe: its event types, the counters it
    /// produces, its settings. The host forwards this to the UI during handshake so panels
    /// can be generated instead of hard coded.
    /// </summary>
    IReadOnlyDictionary<string, object?> Describe();

    /// <summary>Reset all accumulated state, e.g. after the target restarts.</summary>
    void Reset();
}

/// <summary>
/// An optional capability for probes whose answer cannot be computed live.
///
/// TraceEvent refuses to resolve call stacks on a live <c>EventPipeEventSource</c>
/// ("Attempted to use TraceLog support on a non-TraceLog TraceEventSource"), because
/// turning an instruction pointer into a method name needs the fully built method and
/// module maps. Those only exist after the raw stream has been converted to ETLX, which
/// requires the stream to be complete — in other words, on a file.
///
/// A probe that implements this interface therefore asks the session for two things:
/// <list type="item">
/// <item>while the session runs, the raw EventPipe stream is copied to disk verbatim;</item>
/// <item>once the stream has ended, <see cref="AnalyzeCapture"/> is called on that file.</item>
/// </list>
///
/// Both are opt-in through a capture path, so a session that does not want call sites
/// never pays for the extra I/O or the runtime rundown that method name resolution needs.
/// </summary>
public interface IRawCaptureConsumer
{
    /// <summary>File extension the capture should use, e.g. <c>nettrace</c>.</summary>
    string CaptureExtension { get; }

    /// <summary>
    /// Called once, after the stream has ended and the capture file is complete and closed.
    /// Runs on the session thread, may take seconds on a large capture, and must emit its own
    /// results through <paramref name="context" />. Exceptions are caught and reported by the
    /// session, so a failed analysis can never take the session down with it.
    /// </summary>
    void AnalyzeCapture(string capturePath, ProbeContext context);
}
