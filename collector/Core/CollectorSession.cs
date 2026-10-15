using System.Diagnostics.Tracing;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;
using MemorySpy.Collector.Probes;
using MemorySpy.Collector.Protocol;

namespace MemorySpy.Collector.Core;

/// <summary>
/// Owns the single EventPipe session for a target process and pumps events into every
/// enabled probe.
///
/// Threading contract: <see cref="EventPipeEventSource.Process"/> blocks one dedicated
/// thread and every probe callback runs on it, so probes aggregate and a separate timer
/// thread flushes. Probes are never called concurrently for the same event, but
/// <see cref="ICollectorProbe.Flush"/> does run on the timer thread — that is exactly why
/// probes guard their state with a lock instead of assuming single-threaded access.
/// </summary>
public sealed class CollectorSession : IDisposable
{
    private readonly int _pid;
    private readonly CollectorOptions _options;
    private readonly Emitter _emitter;
    private readonly IReadOnlyList<ICollectorProbe> _probes;
    private readonly ICollectorProbe[] _dynamicProbes;
    private readonly ICollectorProbe[] _clrProbes;
    private readonly Dictionary<string, int> _probeErrors = new(StringComparer.Ordinal);
    private readonly ManualResetEventSlim _streamEnded = new(false);

    private EventPipeSession? _session;
    private Timer? _flushTimer;
    private long _flushOverruns;

    /// <summary>One context per probe, kept so a post-session analysis can emit on the same channel.</summary>
    private readonly Dictionary<string, ProbeContext> _probeContexts = new(StringComparer.Ordinal);

    /// <summary>The stream copier, present only while a deep capture is running.</summary>
    private CaptureStream? _capture;

    public CollectorSession(int pid, CollectorOptions options, Emitter emitter, IReadOnlyList<ICollectorProbe> probes)
    {
        _pid = pid;
        _options = options;
        _emitter = emitter;
        _probes = probes;
        _dynamicProbes = probes.Where(p => p.Channel.HasFlag(ProbeChannel.Dynamic)).ToArray();
        _clrProbes = probes.Where(p => p.Channel.HasFlag(ProbeChannel.Clr)).ToArray();
    }

    /// <summary>Total events dispatched, exposed for the session summary.</summary>
    public long EventsProcessed { get; private set; }

    /// <summary>
    /// Starts the session and blocks until the target exits or the stream ends.
    /// Returns the exit code the CLI should use.
    /// </summary>
    public int Run()
    {
        var context = new ProbeContext("session", _emitter, _options);

        foreach (var probe in _probes)
        {
            var probeContext = new ProbeContext(probe.Id, _emitter, _options);
            _probeContexts[probe.Id] = probeContext;
            probe.Initialize(probeContext);
        }

        var captureConsumers = _probes.OfType<IRawCaptureConsumer>().ToList();
        var capturePath = _options.CapturePath;
        var captureEnabled = captureConsumers.Count > 0 && !string.IsNullOrWhiteSpace(capturePath);

        // The allocation sampler that a capture consumer depends on emits tens of thousands of
        // events per second and is pure overhead unless there is somewhere to write them, so
        // its provider is only enrolled when a capture was actually requested.
        var providerProbes = captureEnabled
            ? _probes
            : _probes.Where(p => p is not IRawCaptureConsumer).ToList();

        var providers = ProviderMerger.Merge(providerProbes.SelectMany(p => p.CreateProviders()));

        if (providers.Count == 0)
        {
            // A selection can legitimately want nothing from this session: the heap-snapshot probe
            // opens a session of its own when it is asked for a walk, so `--probes heap-snapshot`
            // enables no provider here and is still a working session. It is only a dead end when a
            // probe that does want events from this session got none — which for the allocation-sites
            // probe means the capture it reads had nowhere to be written.
            if (captureConsumers.Count > 0 && !captureEnabled)
            {
                _emitter.Error("No EventPipe providers would be enabled by this selection. " +
                               "The allocation-sites probe needs --capture <path> to do anything.");
                return 1;
            }

            // Keep a session open anyway: it is what reports the target exiting and what carries the
            // command channel, and a snapshot is triggered over that channel. The runtime provider at
            // Critical level enables no keyword, so it costs a session and no events.
            providers = ProviderMerger.Merge(new[]
            {
                new EventPipeProvider("Microsoft-Windows-DotNETRuntime", EventLevel.Critical, keywords: 0),
            });
        }

        _emitter.Emit(MessageType.SessionStarted, null, new
        {
            pid = _pid,
            intervalMs = _options.IntervalMs,
            probes = _probes.Select(p => new { p.Id, p.DisplayName, eventTypes = p.EventTypes }).ToList(),
            deepCapture = captureEnabled
                ? new { path = capturePath, maxBytes = _options.CaptureMaxBytes }
                : null,
            providers = providers.Select(p => new
            {
                p.Name,
                level = p.EventLevel.ToString(),
                keywords = $"0x{p.Keywords:X}",
                arguments = p.Arguments,
            }).ToList(),
        });

        DiagnosticsClient client;
        try
        {
            client = new DiagnosticsClient(_pid);
        }
        catch (Exception ex)
        {
            _emitter.Error($"Could not open a diagnostics connection to process {_pid}.", null, ex);
            return 2;
        }

        try
        {
            // Method rundown is what lets the capture's call stacks be named later, so it is
            // requested only when a capture consumer is active: it is extra startup work and
            // extra events that a plain live session has no use for.
            _session = client.StartEventPipeSession(providers, requestRundown: captureEnabled);
        }
        catch (Exception ex)
        {
            _emitter.Error(
                $"Failed to start an EventPipe session on process {_pid}. " +
                "The target must be a .NET process that is still running, and the current user must be able to attach to it.",
                null,
                ex);
            return 3;
        }

        Stream eventStream = _session.EventStream;
        if (captureEnabled && capturePath is not null)
        {
            _capture = new CaptureStream(eventStream, capturePath, _options.CaptureMaxBytes);
            eventStream = _capture;
            _emitter.Log(
                "info",
                $"Deep capture enabled: copying the raw event stream to {capturePath}. " +
                "Allocation call sites are resolved from that file when the session stops.");

            // The size cap cannot simply cut the file: a nettrace whose tail is missing is not
            // a smaller trace, it is no trace at all — TraceEvent refuses it wholesale and the
            // user loses every call site to the last byte. So reaching the cap ends collection
            // instead: the session stops itself, the runtime flushes what it holds and writes
            // its stream epilogue, and the file stays a readable trace that covers the prefix.
            _capture.CapReached += () =>
            {
                _emitter.Log(
                    "warn",
                    $"The capture hit its {_options.CaptureMaxBytes / (1024 * 1024)} MB size limit. " +
                    "Collection is ending so the trace file stays readable; it covers everything " +
                    "up to the limit. Raise --capture-max-mb for longer captures.");
                // We are on the parser thread, inside a read of the very stream Stop() waits
                // on — stopping from here would deadlock, so hop to the pool.
                ThreadPool.QueueUserWorkItem(_ => RequestStop());
            };
        }

        using var source = new EventPipeEventSource(eventStream);
        source.Dynamic.All += OnDynamicEvent;
        source.Clr.All += OnClrEvent;

        _flushTimer = new Timer(_ => FlushProbes(), null, _options.IntervalMs, _options.IntervalMs);

        var exitCode = 0;
        try
        {
            // Blocks on this thread until the target process exits or the session stops.
            source.Process();
        }
        catch (Exception ex)
        {
            if (!_streamEnded.IsSet)
            {
                _emitter.Error("The event stream ended unexpectedly.", null, ex);
                exitCode = 4;
            }
        }
        finally
        {
            _flushTimer?.Dispose();
            _flushTimer = null;

            try
            {
                _session.Stop();
            }
            catch
            {
                // The target is already gone; nothing to stop.
            }

            FlushProbes();

            _emitter.Emit(MessageType.TargetExited, null, new
            {
                pid = _pid,
                eventsProcessed = EventsProcessed,
                flushOverruns = Interlocked.Read(ref _flushOverruns),
                probes = _probes.Select(p => new { p.Id, p.DisplayName }).ToList(),
                capture = _capture is null
                    ? null
                    : new { path = _capture.Path, bytes = _capture.Written, truncated = _capture.Truncated },
            });

            // Ordered deliberately: the capture is only complete once the runtime has written
            // its final sequence point, which happens when the session stops. So the file is
            // closed and analysed here — after the stream ended, before the session is
            // reported as over — and its messages reach the UI before the stop event.
            RunCaptureAnalysis(_capture);

            _emitter.Emit(MessageType.SessionStopped, null, new { pid = _pid, exitCode });
        }

        _emitter.Debug(context.ProbeId + $" session finished after {EventsProcessed} events");
        return exitCode;
    }

    /// <summary>Signals the parsing thread to unwind once the stream ends.</summary>
    public void RequestStop()
    {
        if (_capture is not null)
        {
            // The stop of a deep capture has quiet phases the host deliberately waits through —
            // draining the rundown the runtime still owes the session, closing the file,
            // converting it — and a minute of silence after "Stop" reads as a hang unless it is
            // said out loud. This is also the message that tells the user the analysis they are
            // waiting for has not been forgotten, merely scheduled for after the stream ends.
            _emitter.Log(
                "info",
                "Stop requested: draining the event stream and closing the capture. " +
                "Allocation call sites are resolved from the finished file, which for a large " +
                "capture takes tens of seconds — the session is working, not stuck.");
        }

        try
        {
            _streamEnded.Set();
            _session?.Stop();
        }
        catch
        {
            // Ignore: we are already shutting down.
        }
    }

    private void OnDynamicEvent(TraceEvent ev)
    {
        EventsProcessed++;
        Dispatch(_dynamicProbes, ev);
    }

    private void OnClrEvent(TraceEvent ev)
    {
        Dispatch(_clrProbes, ev);
    }

    private void Dispatch(ICollectorProbe[] targets, TraceEvent ev)
    {
        if (_emitter.RawEvents)
            _emitter.Debug($"{ev.ProviderName}::{ev.EventName} id={ev.ID}");

        for (var i = 0; i < targets.Length; i++)
        {
            try
            {
                targets[i].OnEvent(ev);
            }
            catch (Exception ex)
            {
                ReportProbeFailure(targets[i], "OnEvent", ex);
            }
        }
    }

    /// <summary>
    /// Closes the finished capture and lets each consumer analyse it.
    ///
    /// A failing analysis is reported and swallowed: it must never be able to take down a
    /// session that has already collected everything else the user asked for.
    /// </summary>
    private void RunCaptureAnalysis(CaptureStream? capture)
    {
        if (capture is null)
            return;

        capture.CloseFile();

        if (capture.WriteError is not null)
            _emitter.Log("warn", $"The capture at {capture.Path} stopped early: {capture.WriteError}");
        if (capture.Truncated)
            _emitter.Log(
                "warn",
                $"The capture at {capture.Path} hit its size limit, so it is truncated: results cover " +
                "only the part that was written.");

        _emitter.Log("info", $"Capture complete: {capture.Written} bytes written to {capture.Path}.");

        foreach (var probe in _probes)
        {
            if (probe is not IRawCaptureConsumer consumer)
                continue;

            var context = _probeContexts.TryGetValue(probe.Id, out var stored)
                ? stored
                : new ProbeContext(probe.Id, _emitter, _options);

            try
            {
                consumer.AnalyzeCapture(capture.Path, context);
            }
            catch (Exception ex)
            {
                ReportProbeFailure(probe, "AnalyzeCapture", ex);
            }
        }
    }

    private void FlushProbes()
    {
        if (Interlocked.CompareExchange(ref _flushGate, 1, 0) != 0)
        {
            // The previous flush is still running: note it and skip rather than queueing up
            // work that would only make the backlog worse.
            Interlocked.Increment(ref _flushOverruns);
            return;
        }

        try
        {
            foreach (var probe in _probes)
            {
                try
                {
                    probe.Flush();
                }
                catch (Exception ex)
                {
                    ReportProbeFailure(probe, "Flush", ex);
                }
            }
        }
        finally
        {
            Interlocked.Exchange(ref _flushGate, 0);
        }
    }

    private int _flushGate;

    /// <summary>
    /// A misbehaving probe must never take the whole session down or flood the stream with
    /// identical errors, so each probe gets a small error budget and then goes quiet.
    /// </summary>
    private void ReportProbeFailure(ICollectorProbe probe, string phase, Exception ex)
    {
        int count;
        lock (_probeErrors)
        {
            _probeErrors.TryGetValue(probe.Id, out count);
            count++;
            _probeErrors[probe.Id] = count;
        }

        if (count <= 3)
            _emitter.Error($"Probe '{probe.Id}' failed in {phase} ({count}/3 before suppressing).", probe.Id, ex);
        else if (count == 4)
            _emitter.Error($"Probe '{probe.Id}' keeps failing in {phase}; further errors are suppressed.", probe.Id);
    }

    public void Dispose()
    {
        _flushTimer?.Dispose();
        _session?.Dispose();
        _streamEnded.Dispose();
    }
}
