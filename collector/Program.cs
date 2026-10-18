using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MemorySpy.Collector.Core;
using MemorySpy.Collector.Probes;
using MemorySpy.Collector.Protocol;

// MemorySpy.Collector — the sidecar process that speaks to the .NET runtime.
//
// It is intentionally a separate process rather than a library linked into the Tauri host:
// the diagnostic libraries (DiagnosticsClient + TraceEvent) are large, they need the .NET
// runtime, and a crash or a hang while parsing a misbehaving trace must never take the
// desktop app down with it.
//
// Everything it produces goes to stdout as newline delimited JSON using the envelope in
// Protocol/EventEnvelope.cs. Human readable diagnostics go to stderr.

Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
Console.InputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

var emitter = new Emitter();

if (args.Length == 0 || args[0] is "--help" or "-h" or "help")
{
    PrintUsage();
    return 0;
}

switch (args[0])
{
    case "version":
    {
        Console.WriteLine(CollectorIdentity());
        return 0;
    }

    case "cleanup":
    {
        if (args.Length != 2 || !args[1].StartsWith("memoryspy-collector-", StringComparison.Ordinal)
            || args[1].Any(character => !char.IsAsciiLetterOrDigit(character) && character != '-'))
        {
            emitter.Error("cleanup requires a MemorySpy collector filename prefix.");
            return 1;
        }

        CleanupCollectors(args[1]);
        return 0;
    }

    case "capabilities":
    {
        emitter.Emit(MessageType.Hello, null, BuildCapabilities());
        return 0;
    }

    case "list":
    {
        var processes = ProcessDiscovery.List(includeDetails: !args.Contains("--fast"));
        emitter.Emit(MessageType.ProcessList, null, new { processes });
        return 0;
    }

    case "describe":
    {
        if (args.Length < 2 || !int.TryParse(args[1], out var describedPid))
        {
            emitter.Error("describe requires a process id.");
            return 1;
        }

        var info = ProcessDiscovery.Describe(describedPid);
        if (info is null)
        {
            emitter.Error($"Process {describedPid} is not reachable.");
            return 1;
        }

        emitter.Emit(MessageType.ProcessDetail, null, info);
        return 0;
    }

    case "watch":
        return RunWatch(args);

    case "analyze":
        return RunAnalyze(args);

    default:
        emitter.Error($"Unknown command '{args[0]}'. Run with --help for usage.");
        return 1;
}

/// <summary>
/// Runs the call-site analysis on a capture that was produced outside a session.
///
/// This is the door for the one shape of evidence an attached session cannot produce: a
/// target on a runtime before .NET 10 only arms the allocation sampler at process start, so
/// its capture has to be taken by starting the process with EventPipe armed through the
/// environment (<c>DOTNET_EnableEventPipe</c> and friends). The file lands on disk when that
/// process exits, and this command is how it becomes the same <c>allocation.site</c> answer a
/// deep capture inside a session would have produced.
/// </summary>
int RunAnalyze(string[] argv)
{
    string? capturePath = null;
    var maxTypes = 150;

    for (var i = 1; i < argv.Length; i++)
    {
        switch (argv[i])
        {
            case "--capture":
                if (i + 1 >= argv.Length)
                {
                    emitter.Error("--capture requires a file path.");
                    return 1;
                }

                capturePath = argv[++i];
                break;

            case "--max-types":
                if (i + 1 >= argv.Length || !int.TryParse(argv[++i], out var parsed) || parsed < 1)
                {
                    emitter.Error("--max-types requires a positive integer.");
                    return 1;
                }

                maxTypes = parsed;
                break;

            default:
                emitter.Error($"Unknown option '{argv[i]}'. Run with --help for usage.");
                return 1;
        }
    }

    if (string.IsNullOrWhiteSpace(capturePath))
    {
        emitter.Error("analyze requires --capture <path to a .nettrace or .etl>.");
        return 1;
    }

    var options = new CollectorOptions { MaxAllocationTypes = maxTypes };
    var probe = new AllocationSiteProbe();
    var context = new ProbeContext(probe.Id, emitter, options);
    probe.Initialize(context);
    probe.AnalyzeCapture(capturePath, context);
    return 0;
}

int RunWatch(string[] argv)
{
    var options = new CollectorOptions();

    for (var i = 1; i < argv.Length; i++)
    {
        switch (argv[i])
        {
            case "--pid":
                if (i + 1 >= argv.Length || !int.TryParse(argv[++i], out var pid))
                {
                    emitter.Error("--pid requires a numeric process id.");
                    return 1;
                }

                options.Pid = pid;
                break;

            case "--interval":
                if (i + 1 >= argv.Length || !int.TryParse(argv[++i], out var interval) || interval < 100)
                {
                    emitter.Error("--interval requires a value of at least 100 milliseconds.");
                    return 1;
                }

                options.IntervalMs = interval;
                break;

            case "--probes":
                if (i + 1 >= argv.Length)
                {
                    emitter.Error("--probes requires a comma separated list of probe ids.");
                    return 1;
                }

                options.Probes.AddRange(argv[++i].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
                break;

            case "--max-types":
                if (i + 1 >= argv.Length || !int.TryParse(argv[++i], out var maxTypes) || maxTypes < 1)
                {
                    emitter.Error("--max-types requires a positive integer.");
                    return 1;
                }

                options.MaxAllocationTypes = maxTypes;
                break;

            case "--capture":
                if (i + 1 >= argv.Length || string.IsNullOrWhiteSpace(argv[i + 1]))
                {
                    emitter.Error("--capture requires a file path for the raw EventPipe stream.");
                    return 1;
                }

                options.CapturePath = argv[++i];
                break;

            case "--capture-max-mb":
                if (i + 1 >= argv.Length || !int.TryParse(argv[++i], out var captureMaxMb) || captureMaxMb < 1)
                {
                    emitter.Error("--capture-max-mb requires a positive integer.");
                    return 1;
                }

                options.CaptureMaxBytes = captureMaxMb * 1024L * 1024;
                break;

            case "--verbose":
                options.Verbose = true;
                emitter.RawEvents = true;
                break;

            case "--dump-raw":
                options.DumpRawEvents = true;
                break;

            default:
                emitter.Error($"Unknown option '{argv[i]}'.");
                return 1;
        }
    }

    if (options.Pid <= 0)
    {
        emitter.Error("watch requires --pid <process id>. Use 'list' to find candidates.");
        return 1;
    }

    var probes = ProbeCatalog.Resolve(options.Probes, out var unknown);
    if (unknown.Count > 0)
    {
        emitter.Error($"Unknown probe id(s): {string.Join(", ", unknown)}. Known probes: {string.Join(", ", ProbeCatalog.CreateAll().Select(p => p.Id))}.");
        return 1;
    }

    if (probes.Count == 0)
    {
        emitter.Error("No probes selected; nothing to collect.");
        return 1;
    }

    var target = ProcessDiscovery.Describe(options.Pid);
    emitter.Emit(MessageType.Hello, null, BuildCapabilities(target, options, probes));

    using var session = new CollectorSession(options.Pid, options, emitter, probes);

    // The host can steer the session over stdin without restarting it, which matters
    // because restarting means tearing down and rebuilding the EventPipe session.
    var stdinThread = new Thread(() => ListenForCommands(session, probes, emitter))
    {
        IsBackground = true,
        Name = "memoryspy-stdin",
    };
    stdinThread.Start();

    using var sigterm = RegisterSignal(PosixSignal.SIGTERM, session);
    using var sigint = RegisterSignal(PosixSignal.SIGINT, session);

    var exitCode = session.Run();
    emitter.Emit(MessageType.SessionStopped, null, new { pid = options.Pid, exitCode, final = true });
    return exitCode;
}

static string CollectorIdentity()
{
    var executable = Environment.ProcessPath
        ?? throw new InvalidOperationException("The collector executable path is unavailable.");
    using var stream = File.OpenRead(executable);
    return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
}

static void CleanupCollectors(string prefix)
{
    var current = Path.GetFullPath(Environment.ProcessPath
        ?? throw new InvalidOperationException("The collector executable path is unavailable."));
    var tempDirectory = Path.GetFullPath(Path.GetTempPath());

    foreach (var path in Directory.EnumerateFiles(tempDirectory, $"{prefix}*"))
    {
        // Remove copies older than one day, leaving time for another attach to finish copying
        // or start executing the same content-addressed binary before this process prunes it.
        if (!string.Equals(Path.GetFullPath(path), current, StringComparison.Ordinal)
            && DateTime.UtcNow - File.GetLastWriteTimeUtc(path) > TimeSpan.FromDays(1))
        {
            File.Delete(path);
        }
    }
}

static IDisposable? RegisterSignal(PosixSignal signal, CollectorSession session)
{
    try
    {
        return PosixSignalRegistration.Create(signal, ctx =>
        {
            ctx.Cancel = true;
            session.RequestStop();
        });
    }
    catch (PlatformNotSupportedException)
    {
        return null;
    }
}

static void ListenForCommands(CollectorSession session, IReadOnlyList<ICollectorProbe> probes, Emitter emitter)
{
    while (true)
    {
        var line = Console.In.ReadLine();
        if (line is null)
        {
            // stdin is not only the command channel, it is the liveness signal of the host.
            // Reaching EOF here means the host is gone — a killed `docker exec` client closes
            // the pipe, and without this the collector would keep an EventPipe session attached
            // to a target nobody is watching. Verified against a container: an exec whose stdin
            // was at EOF left the collector running until it was killed by hand.
            emitter.Log("warn", "stdin closed; the host is gone, stopping the session.");
            session.RequestStop();
            return;
        }

        line = line.Trim();
        if (line.Length == 0)
            continue;

        string? command = null;
        try
        {
            using var document = JsonDocument.Parse(line);
            if (document.RootElement.TryGetProperty("cmd", out var cmd))
                command = cmd.GetString();
        }
        catch (JsonException)
        {
            emitter.Error("Ignoring malformed command on stdin.");
            continue;
        }

        switch (command)
        {
            case "stop":
                emitter.Emit(MessageType.CommandResult, null, new { cmd = "stop", ok = true });
                session.RequestStop();
                return;

            case "ping":
                emitter.Emit(MessageType.CommandResult, null, new { cmd = "ping", ok = true, pong = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
                break;

            case "reset":
                foreach (var probe in probes)
                {
                    try
                    {
                        probe.Reset();
                    }
                    catch (Exception ex)
                    {
                        emitter.Error($"Reset failed for probe '{probe.Id}'.", probe.Id, ex);
                    }
                }

                emitter.Emit(MessageType.CommandResult, null, new { cmd = "reset", ok = true });
                break;

            case "capabilities":
                emitter.Emit(MessageType.Hello, null, BuildCapabilities());
                break;

            case "snapshot":
            {
                // The heap snapshot is not a per-interval metric — it stops the target for a walk —
                // so it is triggered explicitly and answers with one heap.snapshot message.
                var heapProbe = probes.OfType<HeapSnapshotProbe>().FirstOrDefault();
                if (heapProbe is null)
                {
                    emitter.Emit(MessageType.CommandResult, null, new
                    {
                        cmd = "snapshot",
                        ok = false,
                        error = "The heap-snapshot probe is not enabled in this session; add it with --probes.",
                    });
                    break;
                }

                var started = heapProbe.TryBeginSnapshot(out var detail);
                emitter.Emit(MessageType.CommandResult, null, new { cmd = "snapshot", ok = started, detail });
                break;
            }

            default:
                emitter.Emit(MessageType.CommandResult, null, new { cmd = command, ok = false, error = "unknown command" });
                break;
        }
    }
}

static object BuildCapabilities(
    DotnetProcessInfo? target = null,
    CollectorOptions? options = null,
    IReadOnlyList<ICollectorProbe>? selected = null)
{
    var all = ProbeCatalog.DescribeAll();
    return new
    {
        protocolVersion = 1,
        tool = "MemorySpy.Collector",
        runtime = RuntimeInformation.FrameworkDescription,
        os = RuntimeInformation.OSDescription,
        architecture = RuntimeInformation.ProcessArchitecture.ToString(),
        supports = new[]
        {
            "runtime-counters",
            "per-type-allocation",
            "gc-events",
            "heap-stats",
            "live-reconfigure",
            "multi-probe-single-session",

            // Capabilities that need --capture: the raw stream goes to disk while the session
            // runs, and call sites are resolved from the finished file.
            "raw-capture",
            "allocation-call-sites",
        },
        probes = all,
        enabledProbes = selected?.Select(p => p.Id).ToArray(),
        options = options is null ? null : new
        {
            pid = options.Pid,
            intervalMs = options.IntervalMs,
            maxAllocationTypes = options.MaxAllocationTypes,
            capturePath = options.CapturePath,
            captureMaxBytes = options.CaptureMaxBytes,
        },
        target,
    };
}

static void PrintUsage()
{
    Console.Error.WriteLine("""
        MemorySpy.Collector — stream .NET memory diagnostics as newline delimited JSON.

        Usage:
          MemorySpy.Collector capabilities
              Describe protocol version, available probes and their event types.

          MemorySpy.Collector list [--fast]
              List attachable .NET processes. --fast skips OS-level enrichment.

          MemorySpy.Collector describe <pid>
              Show detailed metadata for one process.

          MemorySpy.Collector watch --pid <pid> [options]
              Attach to a process and stream metrics until it exits or 'stop' arrives on stdin.

          MemorySpy.Collector analyze --capture <path> [--max-types <n>]
              Resolve allocation call sites from a capture file produced outside a session —
              the .nettrace a pre-.NET 10 target writes when it is started with EventPipe
              armed (flushed when the process exits). The config that answers:
              DOTNET_EventPipeConfig=Microsoft-Windows-DotNETRuntime:0x3200001:5
              (sampled allocations + stacks + the GC events; see ARCHITECTURE.md for the
              startup-arming recipe and its one gap — the type leaderboard, which startup
              captures cannot fill because the runtime writes no BulkType events for them).

        Watch options:
          --probes <a,b,c>     Probes to enable (default: all). See 'capabilities'.
          --interval <ms>      Flush interval, minimum 100 (default: 1000).
          --max-types <n>      How many allocating types to report per interval (default: 150).
          --capture <path>     Copy the raw EventPipe stream to <path> (.nettrace) and run the
                               post-session analyses that need it. Turns on allocation call
                               sites: it costs extra I/O and a runtime rundown, and the answer
                               arrives when the session stops, not while it runs.
          --capture-max-mb <n> Size limit for the capture, in MB (default: 256).
          --verbose            Mirror every raw trace event to stderr.
          --dump-raw           Include unresolved raw events for probe development.

        Stdin commands (one JSON object per line):
          {"cmd":"stop"}   {"cmd":"ping"}   {"cmd":"reset"}   {"cmd":"capabilities"}
          {"cmd":"snapshot"}
              Walks the live object graph of the target and reports what survives collection and
              which GC root holds it. Requires the heap-snapshot probe; the target pauses for one
              Gen 2 collection and the walk can take seconds on a large heap.

        Probes:
        """);

    foreach (var probe in ProbeCatalog.CreateAll())
        Console.Error.WriteLine($"  {probe.Id,-20} {probe.DisplayName,-22} {probe.Description}");
}
