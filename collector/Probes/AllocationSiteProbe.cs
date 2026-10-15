using System.Diagnostics.Tracing;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Symbols;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Etlx;
using Microsoft.Diagnostics.Tracing.Parsers.Clr;
using MemorySpy.Collector.Core;
using MemorySpy.Collector.Protocol;

namespace MemorySpy.Collector.Probes;

/// <summary>
/// Answers the question the other probes cannot: <em>which code allocates this?</em>
///
/// <para>
/// <see cref="AllocationProbe"/> gives a type name, which is only actionable when the type is
/// yours. The leaks that matter most in practice are framework types — <c>byte[]</c>,
/// <c>string</c>, <c>object[]</c>, or a dictionary's internals — and for those a type name is
/// a dead end: there is no <c>new byte[]</c> to search for. The answer has to be a call site.
/// </para>
///
/// <para>
/// The runtime can provide one. Under the <c>AllocationSampling</c> keyword
/// (<c>0x80000000000</c>) it emits <c>AllocationSampling</c> events carrying the type, the
/// object size and a full call stack. Two things about that are worth recording, because both
/// were established by experiment rather than by reading documentation:
/// </para>
///
/// <list type="bullet">
/// <item>The older <c>GCSampledObjectAllocation</c> mechanism
/// (<c>GCAllObjectAllocation</c> = <c>0x2200000</c>, the one PerfView-era tooling uses)
/// cannot be armed by attaching: runtimes before 10 install the allocation sampler only
/// while the process is starting, so an attached session requests the keywords, the runtime
/// accepts the session, and no sample is ever taken. Measured on .NET 7.0.3 with the legacy
/// keywords requested: 4 355 allocation ticks and not one sampled allocation; a session
/// asking for <em>only</em> those keywords delivers no bytes at all, because no event is
/// ever emitted to flush the stream header. The probe still requests the keyword — it costs
/// nothing, and it is the right ask for a capture whose target was started with tracing
/// armed — but on an attached session only the modern keyword, from .NET 10, can answer.</item>
/// <item>TraceEvent cannot resolve a call stack on a live <c>EventPipeEventSource</c> — it
/// throws "Attempted to use TraceLog support on a non-TraceLog TraceEventSource" — because
/// instruction pointers can only be turned into method names once the module and method maps
/// have been built from a complete stream. Hence <see cref="IRawCaptureConsumer"/>: the
/// session copies the raw stream to a <c>.nettrace</c>, and this probe analyses that file
/// after the session ends.</item>
/// </list>
///
/// <para>
/// What comes out is a leaderboard of call sites, named by source location where possible:
/// "82% of the sampled bytes in this window were allocated at <c>PayloadWriter.cs:118</c>
/// (<c>PayloadWriter.Serialize</c>), and the dominant type there is <c>System.Byte[]</c>".
/// That is the sentence a developer can act on, and the file plus line is what makes it a
/// block of code rather than a method with several candidates.
/// </para>
///
/// <para>
/// The source location comes from the module's PDB, which is a second lookup beyond the
/// method map: a code address knows its method but not its line, so the PDB has to be read
/// again to get one (<c>TraceCodeAddress.GetSourceLine</c>). The PDBs are looked up next to
/// each assembly, and through <c>_NT_SYMBOL_PATH</c> when that variable is set — which is also
/// the only way symbols are ever fetched from a symbol server, so no network access happens
/// unless you configure one yourself. When no PDB can be found for a module, every site in it
/// falls back to the method name, and the fallback is reported rather than hidden: the payload
/// counts the sites that resolved and names the modules whose PDBs were missing.
/// </para>
///
/// <para>
/// Honesty about the numbers: the runtime <em>samples</em> allocations rather than logging
/// every one, so the totals are sampled volumes, not exact accounting. The sampling is
/// proportional to allocated bytes, so <em>shares</em> between sites are unbiased even though
/// absolute volumes are not — which is exactly why the message reports a share alongside every
/// byte count.
/// </para>
/// </summary>
public sealed class AllocationSiteProbe : ICollectorProbe, IRawCaptureConsumer
{
    /// <summary>
    /// <c>ClrTraceEventParser.Keywords.AllocationSampling</c>. Verified against TraceEvent
    /// 4.0.0's own enum rather than assumed: it is the flag that turns on sampled allocation
    /// events that carry call stacks. .NET 10 and later only — an older runtime ignores the
    /// bit and emits nothing for it.
    /// </summary>
    private const long KeywordAllocationSampling = 0x80000000000;

    /// <summary>
    /// <c>ClrTraceEventParser.Keywords.GCAllObjectAllocation</c>, likewise verified against
    /// TraceEvent 4.0.0's enum: the sampled-allocation mechanism of .NET Core 3+ before 10.
    /// Attach cannot arm it — the sampler is installed only while the process is starting
    /// (measured on 7.0.3: an attached session with this keyword requested produced ticks
    /// but no samples) — so on an attached session this bit is inert. It is requested anyway:
    /// it costs nothing, .NET 10 ignores it, and it is the correct ask for the one scenario
    /// where it can work, a target that was started with tracing already armed.
    /// </summary>
    private const long KeywordGCAllObjectAllocation = 0x2200000;

    /// <summary>Stop walking a stack after this many frames; deeper frames are noise.</summary>
    private const int MaxStackDepth = 32;

    /// <summary>How many frames to keep per site for display.</summary>
    private const int MaxFramesPerSite = 12;

    /// <summary>Ceiling on distinct call sites, so a huge capture cannot exhaust memory.</summary>
    private const int MaxSites = 2_000;

    /// <summary>Ceiling on distinct types across the whole capture.</summary>
    private const int MaxTypes = 400;

    /// <summary>Types kept as the breakdown of a single site.</summary>
    private const int MaxTypesPerSite = 6;

    /// <summary>Callees kept as the breakdown of a single type.</summary>
    private const int MaxSitesPerType = 4;

    /// <summary>
    /// How many addresses in one module may fail to resolve before the whole module is written
    /// off, so that a module which is never going to yield a line cannot cost a lookup per
    /// frame. Modules with no PDB at all are recognised without any lookup and never reach this.
    /// </summary>
    private const int MaxFailedLookupsPerModule = 16;

    /// <summary>
    /// Timeout handed to `SymbolReader` for a symbol server request.
    ///
    /// It bounds the request's own wait, not the phase: measured against a symbol path whose
    /// server never answers, a single `GetSourceLine` call blocked for 62 s, so this does not
    /// cover the connection attempt. `SymbolBudgetMs` is what actually ends the lookup, and
    /// `BudgetOverrunReason` reports the gap between the two instead of pretending they agree.
    /// </summary>
    private const int SymbolServerTimeoutSeconds = 5;

    /// <summary>
    /// Total time the analysis may spend reading PDBs before it stops asking for more.
    ///
    /// This bound is not about local files, which take milliseconds; it exists because
    /// <c>_NT_SYMBOL_PATH</c> may name a symbol server that does not answer. Waiting on one is
    /// not bounded by the per-request timeout alone, since the lookup runs per code address and
    /// the addresses queue up: measured against a black-holed server address, a run that had
    /// collected a healthy capture was still going when the harness gave up at 152 seconds, and
    /// the user lost the whole analysis — method names included — because the symbol phase never
    /// returned. With a budget the phase stops adding new lookups, what already resolved keeps
    /// its line, and the call sites are reported either way.
    ///
    /// Only server-dependent lookups are dropped, though: a module with a PDB beside it is looked
    /// up regardless of the budget (`_localPdb`). Otherwise the first stalled request would spend
    /// the budget for everything, and the profiled assembly's own line — the one line in the
    /// answer that needs no server at all — would be the first casualty. That is not hypothetical:
    /// it is what the first version of this guard did, 0 of 5 sites with a line.
    /// </summary>
    private const int SymbolBudgetMs = 5_000;

    /// <summary>Modules named in the payload when they had no PDB.</summary>
    private const int MaxReportedModulesWithoutSymbols = 8;

    /// <summary>Diagnostics kept from the symbol reader, which can otherwise be very chatty.</summary>
    private const int MaxCapturedSymbolLogLines = 40;

    /// <summary>
    /// Namespace prefixes that mean "not the developer's code". Used to pick the frame that a
    /// person can actually open: when a leak is <c>System.String</c> allocated inside the
    /// runtime's interpolated-string handler, the interesting frame is the user's loop that
    /// built the string, not <c>System.String.Ctor</c>.
    /// </summary>
    private static readonly string[] FrameworkPrefixes =
    {
        "System.", "Microsoft.", "Internal.", "Interop.", "Windows.", "MS.", "Accessibility.",
    };

    /// <summary>
    /// TraceEvent prints method signatures with C#'s keyword spelling for the argument types
    /// (<c>Run(class System.Object)</c>). Stripping those markers makes the names readable and
    /// keeps them copy-pasteable into an IDE's "find usages", which is the whole point of
    /// reporting them.
    /// </summary>
    private static readonly Regex TypeKeywordNoise = new(@"\b(class|struct|valuetype)\s+", RegexOptions.Compiled);

    private ProbeContext _context = null!;

    public string Id => "allocation-sites";

    public string DisplayName => "Allocation Call Sites";

    public string Description =>
        "Which code allocates the memory, read from a raw capture — names the file and line from the PDB, or the method when no PDB is available.";

    public string Icon => "target";

    /// <summary>
    /// No live channel: everything this probe produces comes from analysing the capture file
    /// after the stream has ended, never from <see cref="OnEvent"/>.
    /// </summary>
    public ProbeChannel Channel => ProbeChannel.None;

    public IReadOnlyList<string> EventTypes { get; } = new[] { MessageType.AllocationSite };

    /// <summary>
    /// Both sampled-allocation keywords, merged into one provider. The runtime keeps the one
    /// it knows and ignores the other, so the same request covers .NET Core 3+ through 9
    /// (legacy events) and .NET 10+ (modern events) without knowing the target's version up
    /// front — and the analysis reads whichever the capture actually holds.
    ///
    /// It is only merged into the session when the user asked for a capture (see
    /// <c>CollectorSession.Run</c>): at tens of thousands of events per second it is far too
    /// expensive to run silently for everyone.
    /// </summary>
    public IReadOnlyList<EventPipeProvider> CreateProviders() => new[]
    {
        new EventPipeProvider(
            "Microsoft-Windows-DotNETRuntime",
            EventLevel.Verbose,
            keywords: KeywordAllocationSampling | KeywordGCAllObjectAllocation),
    };

    public string CaptureExtension => "nettrace";

    public void Initialize(ProbeContext context) => _context = context;

    /// <summary>Never called: <see cref="Channel"/> is <see cref="ProbeChannel.None"/>.</summary>
    public void OnEvent(TraceEvent ev)
    {
    }

    /// <summary>Nothing accumulates during the session; see <see cref="AnalyzeCapture"/>.</summary>
    public void Flush()
    {
    }

    public void Reset()
    {
    }

    public IReadOnlyDictionary<string, object?> Describe() => new Dictionary<string, object?>
    {
        ["provider"] = "Microsoft-Windows-DotNETRuntime",
        ["event"] = "AllocationSampling (.NET 10+) / GCAllObjectAllocation (3+ to 9)",
        ["keywords"] = "AllocationSampling (0x80000000000) | GCAllObjectAllocation (0x2200000)",
        ["timing"] = "post-session",
        ["requiresCapture"] = true,
        ["notes"] = new[]
        {
            "Call stacks cannot be resolved on a live EventPipe stream, so this probe needs the raw stream written to a .nettrace and answers once the session stops.",
            "Attach-time sampling is a .NET 10 capability: the AllocationSampling keyword can be armed by attaching. The legacy keywords (before 10) only work when tracing is armed before the process starts, so on an older target an attached capture holds no samples and the analysis says so.",
            "Allocation events carry the managed call stack, resolved to method names, including frames inside the runtime — which is what makes framework types actionable.",
            "Source lines come from each module's PDB: the code address yields the method, and the PDB is read again to turn its IL offset into a file and line. PDBs are looked up next to the assemblies, and through _NT_SYMBOL_PATH when it is set (which is what enables a symbol server; nothing is downloaded otherwise).",
            "When a module's PDB cannot be found, its sites fall back to the method name and are counted in sitesWithoutSource, with the module reported in modulesWithoutSource.",
            "Numbers are sampled allocation volumes, not exact accounting. Shares between call sites are unbiased; absolute totals are not.",
        },
        ["columns"] = new[]
        {
            new { key = "site", label = "Call site" },
            new { key = "sourceFile", label = "Source file" },
            new { key = "sourceLine", label = "Line" },
            new { key = "sampledBytes", label = "Sampled bytes" },
            new { key = "share", label = "Share" },
            new { key = "samples", label = "Samples" },
            new { key = "averageObjectBytes", label = "Avg object" },
            new { key = "dominantTypeName", label = "Dominant type" },
        },
    };

    /// <summary>
    /// Converts the capture to ETLX, aggregates sampled allocations per call site, and turns
    /// each site and frame into a file and line where the module's PDB allows it.
    /// </summary>
    public void AnalyzeCapture(string capturePath, ProbeContext context)
    {
        var info = new FileInfo(capturePath);
        if (!info.Exists || info.Length == 0)
        {
            context.Error($"The deep capture at {capturePath} is empty, so call sites cannot be resolved.");
            return;
        }

        context.Log(
            $"Resolving allocation call sites from {info.Name} ({FormatBytes(info.Length)}). " +
            "Stacks cannot be resolved live, so this runs on the finished capture and can take a few seconds.");

        var etlxPath = Path.ChangeExtension(capturePath, ".etlx");
        TraceLog? log = null;
        var analysisStarted = Environment.TickCount64;

        try
        {
            var conversionStarted = Environment.TickCount64;
            var produced = TraceLog.CreateFromEventPipeDataFile(
                capturePath,
                etlxPath,
                new TraceLogOptions { ConversionLog = TextWriter.Null });
            var conversionMs = Environment.TickCount64 - conversionStarted;

            log = new TraceLog(string.IsNullOrEmpty(produced) ? etlxPath : produced);

            // The symbol reader is scoped to the analysis: it holds parsed PDBs open, and those
            // would otherwise stay mapped for the lifetime of the process.
            using var resolver = new SourceResolver(log.ModuleFiles);
            var result = Aggregate(log, context.Options.MaxAllocationTypes, resolver);
            result.ConversionMs = conversionMs;
            result.AnalysisMs = Environment.TickCount64 - analysisStarted;

            if (result.SampledEvents == 0)
                ReportZeroSamples(result, context);

            var payload = BuildPayload(result, capturePath, info.Length, resolver);

            // The intermediate is removed before the result is announced, so that by the time a
            // caller can see the analysis the disk is already back to holding only the capture.
            DeleteEtlx(log, context, ref etlxPath);

            context.Emit(MessageType.AllocationSite, payload);

            context.Log(
                $"Resolved {result.SampledEvents} sampled allocations into {result.Sites.Count} call sites " +
                $"({result.Types.Count} types) in {result.AnalysisMs} ms.");
            ReportSourceResolution(result, resolver, context);
        }
        catch (Exception ex)
        {
            context.Error(
                $"Could not resolve call sites from the capture at {capturePath}. " +
                "The file is still on disk and can be opened with PerfView or dotnet-trace.",
                ex);
        }
        finally
        {
            DeleteEtlx(log, context, ref etlxPath);
        }
    }

    /// <summary>
    /// Says out loud what an empty answer means, because "0 call sites" is otherwise
    /// indistinguishable from "the feature is broken".
    ///
    /// The evidence is in the capture itself: allocation ticks that kept firing prove the
    /// process was allocating and the session was live. On .NET 9 and older that combination
    /// has one known cause, and it has to be named precisely, because no keyword choice on
    /// our side can fix it: those runtimes install the allocation sampler only while the
    /// process is starting, so a session attached later requests the keywords, the runtime
    /// accepts the session, and the sampler is never installed. Measured on 7.0.3: 4 355
    /// ticks and not one sampled allocation in a capture whose session requested the legacy
    /// keywords — and a session requesting *only* those keywords never delivers a single
    /// byte, because no event is ever emitted to flush the header. Attach-time sampling is
    /// what the modern keyword added in .NET 10.
    /// </summary>
    private static void ReportZeroSamples(AnalysisResult result, ProbeContext context)
    {
        var ticks = $"{result.AllocationTickEvents:N0} GC/AllocationTick events";

        if (Version.TryParse(result.RuntimeVersion, out var version) && version.Major <= 9)
        {
            context.Log(
                "The capture holds no sampled allocation events, so there are no call sites to " +
                $"report — the target runs .NET {version}, where allocation sampling is installed only " +
                "while the process is starting. A session attached later asks for the keywords and the " +
                "runtime accepts it, but the sampler is never armed — the capture's " + ticks +
                " show the process was allocating. Attach-time call sites need a .NET 10+ target; " +
                "on this runtime the alternative is starting the process with tracing already armed " +
                "(the runtime's DOTNET_EnableEventPipe environment variables), and analysing the " +
                "file it writes.",
                "warn");
            return;
        }

        var runtime = result.RuntimeVersion is { } named
            ? $" The capture was written by runtime {named}."
            : string.Empty;

        context.Log(
            "The capture holds no sampled allocation events, so there are no call sites to " +
            "report — it holds " + ticks + ", so the process was allocating but the runtime " +
            "produced no samples. Both sampled-allocation keywords were requested: " +
            "AllocationSampling (.NET 10+) and the startup-time legacy keywords, so an empty " +
            "capture on this build means the runtime has sampling disabled by configuration." +
            runtime,
            "warn");
    }

    /// <summary>
    /// Says out loud how the source line lookup went, because "method name instead of a line" is
    /// the normal experience on a machine without PDBs and the user needs to know that this is
    /// what happened rather than that the feature is broken.
    /// </summary>
    private static void ReportSourceResolution(AnalysisResult result, SourceResolver resolver, ProbeContext context)
    {
        var withSource = result.Sites.Values.Count(site => site.Counted && site.Source is not null);
        var total = result.Sites.Values.Count(site => site.Counted);

        // A symbol layer that could not even be built is the one case where the whole lookup is
        // unavailable rather than merely unlucky, and it has to be said out loud: the call sites
        // are still named, they simply have no line.
        if (resolver.FailureReason is { } failure)
        {
            context.Log(
                $"Symbol lookup is unavailable ({failure}), so call sites are named by method only.",
                "warn");
            return;
        }

        if (resolver.StopReason is { } stop)
        {
            // Said out loud because it changes what the answer contains: a truncated symbol phase
            // means some sites keep a method name for a reason that is not a missing PDB.
            context.Log(
                $"Symbol lookup {stop}, so the sites after that point are named by method. Point " +
                "_NT_SYMBOL_PATH at a server that answers, or unset it to keep the lookup local.",
                "warn");
        }

        // With no sites at all, the source-line story is moot: the zero-samples warning has
        // already said everything there is to say, and a "no PDB found" line under it would
        // point the user at symbols when the actual gap is that nothing was sampled.
        if (total == 0)
            return;

        if (withSource == 0 && resolver.StopReason is null)
        {
            context.Log(
                "No source lines could be resolved: no PDB was found for the allocating modules, so call sites are " +
                "named by method. Set _NT_SYMBOL_PATH (or keep the .pdb next to the assembly) to get file and line.",
                "warn");
        }
        else
        {
            context.Log($"Source lines resolved for {withSource} of {total} call sites ({resolver.SymbolMs} ms of PDB lookup).");
        }

        if (resolver.ModulesWithoutSource.Count > 0)
        {
            var names = string.Join(", ", resolver.ModulesWithoutSource
                .Select(Path.GetFileName)
                .Where(name => !string.IsNullOrEmpty(name))
                .Distinct()
                .Take(MaxReportedModulesWithoutSymbols));

            // Not a warning when the lookup worked: the runtime's own assemblies never have a PDB
            // on a developer's machine, so calling this a warning would put a yellow line in every
            // session's diagnostics and teach the user to ignore the one that matters.
            context.Log(
                $"Modules whose allocations kept a method name only, because no PDB was found: {names}.",
                withSource == 0 ? "warn" : "info");

            if (withSource == 0 && resolver.FirstDiagnostic is { } diagnostic)
                context.Log($"Symbol reader said: {diagnostic}", "debug");
        }
    }

    /// <summary>
    /// Removes the ETLX transcript of the capture.
    ///
    /// It is a pure intermediate: it duplicates the capture, is several times larger, and only
    /// exists so the method and module maps can be built. The capture itself is kept, because it
    /// is the artifact PerfView or dotnet-trace can reopen.
    /// </summary>
    private static void DeleteEtlx(TraceLog? log, ProbeContext context, ref string etlxPath)
    {
        if (string.IsNullOrEmpty(etlxPath))
            return;

        try
        {
            // Released first: the trace log holds the file open while it is mapped.
            log?.Dispose();
        }
        catch
        {
            // Closing a file we are about to delete is not worth reporting.
        }

        var path = etlxPath;
        etlxPath = string.Empty;

        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            context.Log($"Could not delete the intermediate ETLX at {path}: {ex.Message}", "warn");
        }
    }

    private static string FormatBytes(long bytes) => bytes switch
    {
        >= 1024L * 1024 * 1024 => $"{bytes / 1024.0 / 1024 / 1024:F1} GB",
        >= 1024L * 1024 => $"{bytes / 1024.0 / 1024:F1} MB",
        >= 1024 => $"{bytes / 1024.0:F0} KB",
        _ => $"{bytes} B",
    };

    /// <summary>A point in the source, as the PDB recorded it.</summary>
    private readonly record struct FrameSource(string File, int Line);

    /// <summary>One frame of a raw stack, kept with its code address so it can be located later.</summary>
    private readonly record struct FrameRef(TraceCodeAddress? Address, string Method);

    /// <summary>A frame as it is reported: the method always, the source location when known.</summary>
    private sealed class FrameInfo
    {
        public string Method = string.Empty;
        public FrameSource? Source;
    }

    private sealed class AnalysisResult
    {
        public Dictionary<string, SiteAccumulator> Sites { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, TypeTotals> Types { get; } = new(StringComparer.Ordinal);
        public long SampledEvents;
        public long TotalBytes;
        public long LargeObjectSamples;
        public long UnresolvedFrames;
        public long DroppedSites;
        public long DroppedTypes;
        public long WindowStartUnixMs;
        public long WindowEndUnixMs;
        public long ConversionMs;
        public long AnalysisMs;
        public long FrameworkOnlySites;

        /// <summary>
        /// GC/AllocationTick events seen while folding, which is how a capture that produced
        /// no sampled allocations is told apart from one that measured nothing: ticks mean the
        /// process was allocating and the session was live, so the sampler mechanism is what
        /// failed — that is the zero-samples warning's whole evidence.
        /// </summary>
        public long AllocationTickEvents;

        /// <summary>The version directory of the runtime that wrote the capture, if its CoreLib is named.</summary>
        public string? RuntimeVersion;
    }

    private sealed class TypeTotals
    {
        public string TypeName = string.Empty;
        public long SampledBytes;
        public long Samples;
        public readonly Dictionary<string, long> SiteBytes = new(StringComparer.Ordinal);
    }

    private sealed class SiteAccumulator
    {
        /// <summary>The allocating method — the label, and the fallback when there is no PDB.</summary>
        public string Site = string.Empty;

        public FrameInfo[] Frames = Array.Empty<FrameInfo>();

        /// <summary>Where the allocating frame is in the source, when a PDB could say.</summary>
        public FrameSource? Source;

        public bool UserCode;
        public bool Counted;
        public long SampledBytes;
        public long Samples;
        public long ObjectBytes;
        public readonly Dictionary<string, long> TypeBytes = new(StringComparer.Ordinal);
    }

    /// <summary>
    /// Turns a code address into a file and line by reading the owning module's PDB.
    ///
    /// Two caches keep this affordable, because it runs once per frame per site rather than
    /// once per allocation event: one for addresses that have already been located, and a
    /// per-module write-off for modules whose symbols could not be found at all.
    ///
    /// <para>
    /// The subtlety that decides whether this works at all is <c>SecurityCheck</c>. TraceEvent
    /// refuses PDBs found by probing next to the binary unless a callback approves them, and
    /// without that callback every lookup returns null — the analysis still names methods, so
    /// nothing looks broken, it simply never reports a line. Measured on this codebase: 0 of 50
    /// sampled addresses resolved before the callback was supplied, 6 of 50 after (the 6 that
    /// belong to the profiled assembly's own module).
    /// </para>
    ///
    /// <para>
    /// The approval is not blanket. A PDB is accepted only when it sits in a directory of an
    /// assembly the profiled process actually loaded, which is the same trust boundary as the
    /// binary being profiled, and a PDB is never allowed to run a source-server command — a PDB
    /// can embed one, and this analysis has no reason to execute anything.
    /// </para>
    /// </summary>
    private sealed class SourceResolver : IDisposable
    {
        private readonly SymbolReader? _reader;
        private readonly SymbolLogWriter _symbolLog = new();
        private readonly Dictionary<(ulong Address, string Module), FrameSource?> _byAddress = new();
        private readonly Dictionary<string, int> _failedAttempts = new(StringComparer.Ordinal);

        /// <summary>Modules kept for the report, in the order they were first seen.</summary>
        private readonly List<string> _modulesWithoutSource = new();

        /// <summary>
        /// The same modules as a set. The report wants the order; the lookup wants an answer per
        /// event, and a linear scan of a list that grows with every framework assembly the target
        /// loaded is the wrong shape for something on the hot path.
        /// </summary>
        private readonly HashSet<string> _writtenOff = new(StringComparer.Ordinal);

        private readonly string? _symbolPath;

        /// <summary>
        /// Modules with no PDB beside them, when no symbol path is configured to look elsewhere.
        /// Knowing this before the first lookup is what makes the common case free instead of a
        /// failed file-system search per frame.
        /// </summary>
        private readonly HashSet<string> _nothingToRead = new(StringComparer.Ordinal);

        /// <summary>
        /// Modules that do have a PDB beside them, so their lookups are local and cheap.
        ///
        /// These are exempt from the time budget, and that exemption is the point: when a symbol
        /// path is configured but the server behind it does not answer, a single stalled request
        /// can consume the whole budget, and without this set the modules that never needed the
        /// server — the ones belonging to the code being profiled — would be skipped along with
        /// it. Measured before the exemption: a black-holed server cost 62 seconds *and* the
        /// profiled assembly's own line, which is the worst of both.
        /// </summary>
        private readonly HashSet<string> _localPdb = new(StringComparer.Ordinal);

        public SourceResolver(IEnumerable<TraceModuleFile> modules)
        {
            // The symbol path follows _NT_SYMBOL_PATH, the convention every other .NET
            // diagnostic tool uses. Unset means no server is consulted, so lookups stay local
            // to the assemblies the process loaded.
            _symbolPath = Environment.GetEnvironmentVariable("_NT_SYMBOL_PATH");
            if (string.IsNullOrWhiteSpace(_symbolPath))
                _symbolPath = null;

            var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var withoutPdb = new HashSet<string>(StringComparer.Ordinal);

            try
            {
                foreach (var module in modules)
                {
                    var path = module.FilePath;
                    if (string.IsNullOrEmpty(path))
                        continue;

                    if (Path.GetDirectoryName(path) is { Length: > 0 } directory)
                        directories.Add(directory);

                    if (HasPdbBeside(module))
                        _localPdb.Add(path);
                    else
                        withoutPdb.Add(path);
                }

                // Without a symbol path there is nowhere else a PDB could come from, so a module
                // with no PDB beside it is decided up front rather than 24 000 lookups later.
                if (_symbolPath is null)
                    _nothingToRead = withoutPdb;

                _reader = new SymbolReader(_symbolLog, _symbolPath, null)
                {
                    SecurityCheck = path =>
                        directories.Contains(Path.GetDirectoryName(path) ?? string.Empty),
                    AuthorizeSourceServerCommand = _ => false,
                    ServerTimeout = TimeSpan.FromSeconds(SymbolServerTimeoutSeconds),
                };
            }
            catch (Exception ex)
            {
                // Symbols are a bonus on top of the method names the stacks already carry, so a
                // symbol layer that cannot even be built must cost the user their lines and not
                // their call sites: the resolver stays usable and answers "unknown" for everything.
                _reader = null;
                FailureReason = ex.Message;
            }
        }

        /// <summary>Why the lookup is unavailable, or null when it is working.</summary>
        public string? FailureReason { get; }

        /// <summary>Why the lookup stopped early, or null when it ran to the end.</summary>
        public string? StopReason { get; private set; }

        /// <summary>
        /// Whether a PDB sits next to the module, preferring the name the module itself declares.
        ///
        /// The declared name is the one the build recorded, so it also covers a PDB that was
        /// renamed relative to the assembly, which guessing ".pdb" from the assembly name misses.
        /// The declared name may be a Windows path from the build machine even when this runs on
        /// Unix, so the file name is taken by splitting on both separators.
        /// </summary>
        private static bool HasPdbBeside(TraceModuleFile module)
        {
            var path = module.FilePath;
            if (string.IsNullOrEmpty(path) || Path.GetDirectoryName(path) is not { Length: > 0 } directory)
                return false;

            var declared = LastPathSegment(module.PdbName ?? string.Empty);
            if (declared.EndsWith(".pdb", StringComparison.OrdinalIgnoreCase) &&
                File.Exists(Path.Combine(directory, declared)))
                return true;

            return File.Exists(Path.ChangeExtension(path, ".pdb"));
        }

        private static string LastPathSegment(string path)
        {
            var separator = path.LastIndexOfAny(new[] { '/', '\\' });
            return separator >= 0 ? path[(separator + 1)..] : path;
        }

        public string? SymbolPath => _symbolPath;

        public IReadOnlyList<string> ModulesWithoutSource => _modulesWithoutSource;

        /// <summary>Time spent inside the PDB lookup itself, which is the expensive part.</summary>
        public long SymbolMs { get; private set; }

        /// <summary>True once the budget has been spent, so no further lookups are attempted.</summary>
        private bool BudgetSpent => SymbolMs >= SymbolBudgetMs;

        /// <summary>
        /// Why the lookup stopped, phrased against the clock rather than against the budget alone.
        ///
        /// The two numbers are not the same, and measuring is what showed it: a request to a symbol
        /// server that never answers is not interruptible from here, so the check that ends the
        /// phase runs only after that request returns. A run that spent its 5 s budget in one
        /// 62 s stall would otherwise report "stopped after 5000 ms", which is exactly the kind of
        /// claim that sends a reader looking in the wrong place.
        /// </summary>
        private string BudgetOverrunReason()
        {
            var elapsed = SymbolMs;
            var overrun = elapsed - SymbolBudgetMs;

            return overrun > 1_000
                ? $"stopped once its {SymbolBudgetMs} ms budget was gone — {elapsed / 1000.0:0.#} s into it, because one request to the symbol server never answered"
                : $"stopped once its {SymbolBudgetMs} ms budget was gone — usually a symbol server that does not answer";
        }

        public string? FirstDiagnostic => _symbolLog.FirstLine;

        public FrameSource? Resolve(TraceCodeAddress? address)
        {
            if (address is null)
                return null;

            if (_reader is null)
                return null;

            var module = address.ModuleFilePath ?? string.Empty;
            if (_writtenOff.Contains(module))
                return null;

            var key = (address.Address, module);
            if (_byAddress.TryGetValue(key, out var cached))
                return cached;

            FrameSource? resolved = null;

            if (_nothingToRead.Contains(module))
            {
                Report(module);
            }
            else if (BudgetSpent && !_localPdb.Contains(module))
            {
                // Only server-dependent modules are dropped when the budget is gone: a module with
                // a PDB next to it answers from disk in microseconds and must never lose its
                // line to a request that went out to a server. Deliberately silent per address —
                // one line of reasons is written by the caller.
                StopReason ??= BudgetOverrunReason();
            }
            else
            {
                var started = Environment.TickCount64;
                try
                {
                    // A code address carries the IL offset but not the line: the PDB has to be
                    // read again for that, which is what this call does.
                    //
                    // BuildTimeFilePath rather than GetSourceFile: the latter can contact a
                    // source server, which would make an analysis that is supposed to be local
                    // both slow and surprising. The path recorded at build time is what we
                    // report, and the file it names can be opened by the editor.
                    var location = address.GetSourceLine(_reader);
                    var file = location?.SourceFile?.BuildTimeFilePath;
                    if (!string.IsNullOrWhiteSpace(file))
                        resolved = new FrameSource(file, location!.LineNumber);
                }
                catch (Exception)
                {
                    // A PDB that cannot be read is the same outcome as one that is missing.
                }

                SymbolMs += Environment.TickCount64 - started;

                if (resolved is null)
                {
                    var attempts = _failedAttempts.TryGetValue(module, out var previous) ? previous + 1 : 1;
                    _failedAttempts[module] = attempts;
                    if (attempts >= MaxFailedLookupsPerModule)
                        Report(module);
                }
            }

            _byAddress[key] = resolved;
            return resolved;
        }

        private void Report(string module)
        {
            if (_writtenOff.Add(module))
                _modulesWithoutSource.Add(module);
        }

        public void Dispose()
        {
            try
            {
                _reader?.Dispose();
            }
            catch
            {
                // Closing a symbol reader is not worth reporting.
            }
        }
    }

    /// <summary>
    /// Keeps the symbol reader's diagnostics from reaching the user's log unfiltered, while
    /// preserving enough of them to explain why nothing resolved.
    /// </summary>
    private sealed class SymbolLogWriter : TextWriter
    {
        private readonly List<string> _lines = new();
        private readonly StringBuilder _pending = new();

        public override Encoding Encoding => Encoding.UTF8;

        public string? FirstLine => _lines.Count > 0 ? _lines[0] : null;

        public override void Write(char value)
        {
            if (value == '\n')
            {
                FlushPending();
                return;
            }

            if (value != '\r')
                _pending.Append(value);
        }

        public override void Write(string? value)
        {
            if (value is null)
                return;

            foreach (var character in value)
                Write(character);
        }

        private void FlushPending()
        {
            var line = _pending.ToString().Trim();
            _pending.Clear();

            if (line.Length == 0 || _lines.Count >= MaxCapturedSymbolLogLines)
                return;

            _lines.Add(line);
        }
    }

    /// <summary>
    /// Walks the capture's events and folds every sampled allocation into its call site.
    /// </summary>
    private static AnalysisResult Aggregate(TraceLog log, int maxSites, SourceResolver resolver)
    {
        var result = new AnalysisResult();

        // The capture is the evidence of what runtime wrote it: the rundown names CoreLib, and
        // its containing directory is the runtime's version folder (…\Microsoft.NETCore.App\7.0.3\).
        // Read once, up front, so a zero-sample diagnosis can say what was attached to.
        result.RuntimeVersion = log.ModuleFiles
            .OfType<TraceModuleFile>()
            .Select(m => m.FilePath)
            .FirstOrDefault(p => p is not null &&
                                 p.Contains("System.Private.CoreLib", StringComparison.OrdinalIgnoreCase))
            is { } coreLibPath
                ? Path.GetFileName(Path.GetDirectoryName(coreLibPath))
                : null;

        // Legacy sampled allocations carry only a TypeID; the names live in GC/BulkType
        // events, which the runtime writes at rundown — that is, after every allocation. The
        // map is collected in a first pass so the folding pass can name types it meets
        // earlier in the file. Without it, every type in a pre-.NET 10 capture reports as
        // "(unknown type)" and the type leaderboard is useless.
        Dictionary<ulong, string>? legacyTypeNames = null;
        foreach (var ev in log.Events)
        {
            if (ev is not GCBulkTypeTraceData bulk)
                continue;

            legacyTypeNames ??= new Dictionary<ulong, string>();
            for (var i = 0; i < bulk.Count; i++)
            {
                var values = bulk.Values(i);
                if (!string.IsNullOrWhiteSpace(values.TypeName))
                    legacyTypeNames[values.TypeID] = values.TypeName;
            }
        }

        foreach (var ev in log.Events)
        {
            var isModern = ev.EventName.Contains("AllocationSampling", StringComparison.Ordinal);
            var isLegacy = !isModern && ev.EventName.Contains("SampledObjectAllocation", StringComparison.Ordinal);
            if (!isModern && !isLegacy)
            {
                if (ev.EventName.Contains("AllocationTick", StringComparison.Ordinal))
                    result.AllocationTickEvents++;
                continue;
            }

            var typeName = ReadString(ev, "TypeName");
            if (string.IsNullOrWhiteSpace(typeName) &&
                legacyTypeNames is not null &&
                ev is GCSampledObjectAllocationTraceData legacy &&
                legacyTypeNames.TryGetValue(legacy.TypeID, out var mapped))
            {
                // The legacy event names its type by ID; the BulkType pass holds the names.
                typeName = mapped;
            }

            if (string.IsNullOrWhiteSpace(typeName))
                typeName = "(unknown type)";

            var bytes = ReadLong(ev, isModern ? "ObjectSize" : "TotalSizeForTypeSample");
            var kind = ReadString(ev, "AllocationKind");

            var frames = ReadStack(ev, result);
            var siteIndex = ResolveSiteIndex(frames, out var frameworkOnly);

            var hasSiteFrame = frames.Length > siteIndex;
            var siteFrame = hasSiteFrame ? frames[siteIndex] : default;
            var siteSource = resolver.Resolve(siteFrame.Address);
            var siteMethod = hasSiteFrame ? siteFrame.Method : "(unresolved)";

            // The key separates two allocation sites inside one method, which is the difference
            // between "this method allocates" and "this statement allocates". Without a PDB the
            // line is unknown and the sites merge by method, exactly as they did before.
            var siteKey = hasSiteFrame ? BuildSiteKey(siteMethod, siteSource) : "(unresolved)";

            var displayFrames = hasSiteFrame
                ? frames[siteIndex..Math.Min(frames.Length, siteIndex + MaxFramesPerSite)]
                : Array.Empty<FrameRef>();

            result.SampledEvents++;
            result.TotalBytes += bytes;
            if (string.Equals(kind, "Large", StringComparison.OrdinalIgnoreCase))
                result.LargeObjectSamples++;
            if (frameworkOnly)
                result.FrameworkOnlySites++;

            var unixMs = (long)ev.TimeStamp.ToUniversalTime().Subtract(DateTime.UnixEpoch).TotalMilliseconds;
            if (result.WindowStartUnixMs == 0 || unixMs < result.WindowStartUnixMs)
                result.WindowStartUnixMs = unixMs;
            if (unixMs > result.WindowEndUnixMs)
                result.WindowEndUnixMs = unixMs;

            if (!result.Sites.TryGetValue(siteKey, out var site))
            {
                if (result.Sites.Count >= Math.Max(1, maxSites))
                {
                    result.DroppedSites++;
                    continue;
                }

                site = new SiteAccumulator
                {
                    Site = siteMethod,
                    Source = siteSource,
                    UserCode = !frameworkOnly,
                    // Resolved once, on the event that first saw this site, so the call chain is
                    // located while the trace log is still open.
                    Frames = displayFrames
                        .Select(frame => new FrameInfo
                        {
                            Method = frame.Method,
                            Source = resolver.Resolve(frame.Address),
                        })
                        .ToArray(),
                };
                result.Sites[siteKey] = site;
            }

            site.SampledBytes += bytes;
            site.Samples++;
            site.ObjectBytes += bytes;
            site.Counted = true;
            site.TypeBytes[typeName] = site.TypeBytes.TryGetValue(typeName, out var tb) ? tb + bytes : bytes;

            if (!result.Types.TryGetValue(typeName, out var totals))
            {
                if (result.Types.Count >= MaxTypes)
                {
                    result.DroppedTypes++;
                    continue;
                }

                totals = new TypeTotals { TypeName = typeName };
                result.Types[typeName] = totals;
            }

            totals.SampledBytes += bytes;
            totals.Samples++;
            totals.SiteBytes[siteKey] = totals.SiteBytes.TryGetValue(siteKey, out var sb) ? sb + bytes : bytes;
        }

        return result;
    }

    /// <summary>
    /// Identity of a call site: the method, qualified by the source line when a PDB supplied one.
    /// </summary>
    private static string BuildSiteKey(string method, FrameSource? source) =>
        source is { } location ? $"{method} @ {location.File}:{location.Line}" : method;

    /// <summary>
    /// Reads the managed stack, newest frame first, tolerating frames TraceEvent could not
    /// resolve (a capture without rundown, or JIT-generated code).
    /// </summary>
    private static FrameRef[] ReadStack(TraceEvent ev, AnalysisResult result)
    {
        var frames = new List<FrameRef>(16);
        try
        {
            var stack = ev.CallStack();
            for (var frame = stack; frame is not null && frames.Count < MaxStackDepth; frame = frame.Caller)
            {
                var codeAddress = frame.CodeAddress;
                var name = codeAddress?.FullMethodName;
                if (string.IsNullOrWhiteSpace(name))
                {
                    result.UnresolvedFrames++;
                    continue;
                }

                frames.Add(new FrameRef(codeAddress, TypeKeywordNoise.Replace(name, string.Empty).Trim()));
            }
        }
        catch (Exception)
        {
            // A stack that cannot be read is not fatal: the sample still counts towards the
            // type totals, and the caller falls back to the "(unresolved)" site.
        }

        return frames.ToArray();
    }

    /// <summary>
    /// Index of the frame that names a place in the developer's code, or 0 when every frame
    /// belongs to the runtime.
    /// </summary>
    private static int ResolveSiteIndex(FrameRef[] frames, out bool frameworkOnly)
    {
        frameworkOnly = false;

        for (var i = 0; i < frames.Length; i++)
        {
            if (IsFrameworkFrame(frames[i].Method))
                continue;

            return i;
        }

        frameworkOnly = frames.Length > 0;
        return 0;
    }

    private static bool IsFrameworkFrame(string frame) =>
        FrameworkPrefixes.Any(prefix => frame.StartsWith(prefix, StringComparison.Ordinal));

    private static string ReadString(TraceEvent ev, string name)
    {
        try
        {
            return ev.PayloadByName(name)?.ToString() ?? string.Empty;
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    private static long ReadLong(TraceEvent ev, string name)
    {
        try
        {
            return Convert.ToInt64(ev.PayloadByName(name) ?? 0L);
        }
        catch (Exception)
        {
            return 0;
        }
    }

    private static object BuildPayload(AnalysisResult result, string capturePath, long captureBytes, SourceResolver resolver)
    {
        var ordered = result.Sites.Values
            .Where(s => s.Counted)
            .OrderByDescending(s => s.SampledBytes)
            .ToList();

        var denominator = Math.Max(1, result.TotalBytes);

        var sites = ordered.Select(s =>
        {
            var types = s.TypeBytes
                .OrderByDescending(kv => kv.Value)
                .Take(MaxTypesPerSite)
                .Select(kv => new
                {
                    typeName = kv.Key,
                    sampledBytes = kv.Value,
                    share = (double)kv.Value / Math.Max(1, s.SampledBytes),
                })
                .ToList();

            return new
            {
                site = s.Site,
                sourceFile = s.Source?.File,
                sourceLine = s.Source?.Line,
                frames = s.Frames
                    .Select(frame => new
                    {
                        method = frame.Method,
                        sourceFile = frame.Source?.File,
                        sourceLine = frame.Source?.Line,
                    })
                    .ToList(),
                userCode = s.UserCode,
                frameworkOnly = !s.UserCode,
                sampledBytes = s.SampledBytes,
                samples = s.Samples,
                share = (double)s.SampledBytes / denominator,
                averageObjectBytes = s.Samples > 0 ? (double)s.ObjectBytes / s.Samples : 0,
                dominantTypeName = types.Count > 0 ? types[0].typeName : null,
                types,
            };
        }).ToList();

        var types = result.Types.Values
            .OrderByDescending(t => t.SampledBytes)
            .Take(50)
            .Select(t =>
            {
                var topSites = t.SiteBytes
                    .OrderByDescending(kv => kv.Value)
                    .Take(MaxSitesPerType)
                    .Select(kv =>
                    {
                        result.Sites.TryGetValue(kv.Key, out var accumulator);
                        return new
                        {
                            site = accumulator?.Site ?? kv.Key,
                            sourceFile = accumulator?.Source?.File,
                            sourceLine = accumulator?.Source?.Line,
                            sampledBytes = kv.Value,
                            share = (double)kv.Value / Math.Max(1, t.SampledBytes),
                        };
                    })
                    .ToList();

                return new
                {
                    typeName = t.TypeName,
                    sampledBytes = t.SampledBytes,
                    samples = t.Samples,
                    share = (double)t.SampledBytes / denominator,
                    dominantSite = topSites.Count > 0 ? topSites[0].site : null,
                    dominantSourceFile = topSites.Count > 0 ? topSites[0].sourceFile : null,
                    dominantSourceLine = topSites.Count > 0 ? topSites[0].sourceLine : null,
                    sites = topSites,
                };
            })
            .ToList();

        var modulesWithoutSource = resolver.ModulesWithoutSource
            .Select(Path.GetFileName)
            .Where(name => !string.IsNullOrEmpty(name))
            .Distinct()
            .Take(MaxReportedModulesWithoutSymbols)
            .ToList();

        return new
        {
            captureFile = Path.GetFileName(capturePath),
            captureBytes,
            eventsScanned = result.SampledEvents,
            sampledEvents = result.SampledEvents,
            allocationTickEvents = result.AllocationTickEvents,
            runtimeVersion = result.RuntimeVersion,
            totalSampledBytes = result.TotalBytes,
            totalSamples = result.SampledEvents,
            largeObjectSamples = result.LargeObjectSamples,
            distinctSites = ordered.Count,
            distinctTypes = result.Types.Count,
            droppedSites = result.DroppedSites,
            droppedTypes = result.DroppedTypes,
            unresolvedFrames = result.UnresolvedFrames,
            frameworkOnlySites = result.FrameworkOnlySites,
            sitesWithSource = ordered.Count(s => s.Source is not null),
            sitesWithoutSource = ordered.Count(s => s.Source is null),
            modulesWithoutSource,
            symbolPath = resolver.SymbolPath,
            symbolMs = resolver.SymbolMs,
            symbolStopReason = resolver.StopReason,
            windowStartUnixMs = result.WindowStartUnixMs,
            windowEndUnixMs = result.WindowEndUnixMs,
            durationMs = Math.Max(0, result.WindowEndUnixMs - result.WindowStartUnixMs),
            conversionMs = result.ConversionMs,
            analysisMs = result.AnalysisMs,
            sampling = "Sampled allocation volumes, not exact accounting: the runtime reports a sample " +
                        "rather than every allocation. Shares between sites are unbiased.",
            sites,
            types,
        };
    }
}
