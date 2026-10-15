namespace MemorySpy.Collector.Core;

/// <summary>
/// Metadata for a single runtime counter: how to read it, how to display it and when it
/// is worth worrying about.
/// </summary>
/// <param name="Name">Runtime counter name, e.g. <c>gc-heap-size</c>.</param>
/// <param name="DisplayName">Friendly name for the UI.</param>
/// <param name="Category">Grouping used by the UI, e.g. Memory / GC / ThreadPool.</param>
/// <param name="Unit">Canonical unit this counter is reported in after normalisation.</param>
/// <param name="Description">Short explanation, shown as a tooltip.</param>
/// <param name="IsMemory">True when the counter describes memory usage.</param>
/// <param name="DefaultRawUnit">
/// Unit to assume when the runtime does not send <c>DisplayUnits</c>. Sizes are the tricky
/// case: a size counter reported without a unit must not be mistaken for bytes when the
/// runtime actually meant megabytes.
/// </param>
/// <param name="ExtraScale">
/// Multiplier applied after raw-unit conversion, for counters whose value is not expressed
/// in the unit the runtime claims. The only current case is <c>cpu-usage</c>, published as
/// a 0-1 fraction of a single core while advertising "%".
/// </param>
/// <param name="IsRate">
/// True when the value is a per-interval amount that should be converted to a per-second
/// rate, so charts stay comparable across sampling intervals.
/// </param>
/// <param name="ScaleByProcessorCount">
/// True for percentages the runtime reports as a share of *total* machine CPU. Multiplying
/// by the processor count converts them to "percent of one core", which is what `top` and
/// `ps` show and what a developer means by "this service uses one core".
/// </param>
public sealed record CounterDefinition(
    string Name,
    string DisplayName,
    string Category,
    string Unit,
    string Description,
    bool IsMemory = false,
    string? DefaultRawUnit = null,
    double ExtraScale = 1,
    bool IsRate = false,
    bool ScaleByProcessorCount = false,
    double? WarnAbove = null,
    double? CriticalAbove = null);

/// <summary>
/// Known <c>System.Runtime</c> counters plus the rules that turn their raw values into a
/// consistent unit system.
///
/// The runtime reports units inconsistently: <c>gc-heap-size</c> arrives in megabytes
/// while <c>gen-2-size</c> arrives in bytes, some counters omit <c>DisplayUnits</c>
/// entirely, and <c>cpu-usage</c> advertises "%" while sending a 0-1 fraction. Normalising
/// here means every chart, every analysis rule and every export in the app works in one
/// unit system instead of re-deriving these quirks per widget.
///
/// The runtime's own unit wins when it is present and meaningful; the catalog's
/// <see cref="CounterDefinition.DefaultRawUnit"/> is only a fallback. Counters that are
/// not in the catalog still flow through, labelled from <c>DisplayUnits</c>, so a new
/// runtime counter never requires a collector change.
/// </summary>
public static class CounterCatalog
{
    public const string UnitBytes = "bytes";
    public const string UnitBytesPerSecond = "bytes-per-second";
    public const string UnitPercent = "percent";
    public const string UnitCount = "count";
    public const string UnitMilliseconds = "ms";

    public const string CategoryMemory = "Memory";
    public const string CategoryGc = "GC";
    public const string CategoryThreadPool = "ThreadPool";
    public const string CategoryJit = "JIT";
    public const string CategoryCpu = "CPU";
    public const string CategoryExceptions = "Exceptions";
    public const string CategoryOther = "Other";

    private const double Kb = 1024d;
    private const double Mb = 1024d * 1024d;
    private const double Gb = 1024d * 1024d * 1024d;

    private static readonly Dictionary<string, CounterDefinition> Definitions = new(StringComparer.OrdinalIgnoreCase)
    {
        // ---- Memory: the headline numbers for a leak hunt -------------------------------
        ["working-set"] = new("working-set", "Working Set", CategoryMemory, UnitBytes,
            "Resident memory the OS has assigned to the process.", IsMemory: true, DefaultRawUnit: "MB"),

        ["gc-heap-size"] = new("gc-heap-size", "GC Heap Size", CategoryMemory, UnitBytes,
            "Total managed heap size reported by the GC.", IsMemory: true, DefaultRawUnit: "MB"),

        ["gen-0-size"] = new("gen-0-size", "Gen 0 Size", CategoryMemory, UnitBytes,
            "Size of generation 0 — short lived allocations.", IsMemory: true, DefaultRawUnit: "B"),

        ["gen-1-size"] = new("gen-1-size", "Gen 1 Size", CategoryMemory, UnitBytes,
            "Size of generation 1, the buffer between gen 0 and gen 2.", IsMemory: true, DefaultRawUnit: "B"),

        ["gen-2-size"] = new("gen-2-size", "Gen 2 Size", CategoryMemory, UnitBytes,
            "Size of generation 2 — long lived objects. Steady growth here is the classic signature of a managed leak.",
            IsMemory: true, DefaultRawUnit: "B", WarnAbove: 512 * Mb),

        ["loh-size"] = new("loh-size", "LOH Size", CategoryMemory, UnitBytes,
            "Large Object Heap (objects of 85 KB or more). Growth here usually means large arrays, buffers or strings.",
            IsMemory: true, DefaultRawUnit: "B", WarnAbove: 256 * Mb),

        ["poh-size"] = new("poh-size", "POH Size", CategoryMemory, UnitBytes,
            "Pinned Object Heap.", IsMemory: true, DefaultRawUnit: "B"),

        ["gc-committed"] = new("gc-committed", "GC Committed", CategoryMemory, UnitBytes,
            "Memory committed for the GC heap, including free segments.", IsMemory: true, DefaultRawUnit: "MB"),

        ["gen-0-gc-budget"] = new("gen-0-gc-budget", "Gen 0 Budget", CategoryMemory, UnitBytes,
            "Allocation budget for generation 0 before the next collection.", IsMemory: true, DefaultRawUnit: "MB"),

        ["alloc-rate"] = new("alloc-rate", "Allocation Rate", CategoryMemory, UnitBytesPerSecond,
            "Bytes allocated per second. A high rate churns the GC even when nothing leaks.",
            IsMemory: true, DefaultRawUnit: "B", IsRate: true),

        // ---- GC health -----------------------------------------------------------------
        ["time-in-gc"] = new("time-in-gc", "Time in GC", CategoryGc, UnitPercent,
            "Percentage of elapsed time spent in garbage collection.", DefaultRawUnit: "%",
            WarnAbove: 20, CriticalAbove: 40),

        ["gc-fragmentation"] = new("gc-fragmentation", "GC Fragmentation", CategoryGc, UnitPercent,
            "Percentage of the heap that is free space inside fragmented segments.", DefaultRawUnit: "%",
            WarnAbove: 30),

        ["total-pause-time-by-gc"] = new("total-pause-time-by-gc", "GC Pause Time", CategoryGc, UnitMilliseconds,
            "Time the runtime spent paused by the GC during the interval.", DefaultRawUnit: "ms"),

        ["gen-0-gc-count"] = new("gen-0-gc-count", "Gen 0 GC Count", CategoryGc, UnitCount,
            "Number of generation 0 collections."),

        ["gen-1-gc-count"] = new("gen-1-gc-count", "Gen 1 GC Count", CategoryGc, UnitCount,
            "Number of generation 1 collections."),

        ["gen-2-gc-count"] = new("gen-2-gc-count", "Gen 2 GC Count", CategoryGc, UnitCount,
            "Number of full, blocking generation 2 collections."),

        // ---- CPU -----------------------------------------------------------------------
        // Measured, not assumed: a single-threaded busy loop on an 18 core machine reports
        // cpu-usage ~= 5.6, i.e. exactly 100/18. The runtime expresses this counter as a
        // share of total machine CPU, so it is scaled by the processor count to match what
        // `top` and `ps` report.
        ["cpu-usage"] = new("cpu-usage", "CPU Usage", CategoryCpu, UnitPercent,
            "Process CPU time as a percentage of one core. 100% means one core fully busy, so "
            + "values above 100% are normal on multi-core machines and match what top and ps report.",
            DefaultRawUnit: "%", ScaleByProcessorCount: true,
            WarnAbove: 90, CriticalAbove: 100),

        // ---- ThreadPool -----------------------------------------------------------------
        ["threadpool-thread-count"] = new("threadpool-thread-count", "ThreadPool Threads", CategoryThreadPool, UnitCount,
            "Thread pool threads. Unbounded growth usually means blocking work is starving the pool."),

        ["threadpool-queue-length"] = new("threadpool-queue-length", "ThreadPool Queue", CategoryThreadPool, UnitCount,
            "Work items waiting for a thread pool thread. A persistently non-zero value signals starvation.",
            WarnAbove: 10),

        ["threadpool-completed-items-count"] = new("threadpool-completed-items-count", "ThreadPool Completed", CategoryThreadPool, UnitCount,
            "Work items completed by the thread pool."),

        ["monitor-lock-contention-count"] = new("monitor-lock-contention-count", "Lock Contention", CategoryThreadPool, UnitCount,
            "Times a thread had to wait for a contended monitor lock."),

        // ---- JIT and misc ----------------------------------------------------------------
        ["exception-count"] = new("exception-count", "Exceptions", CategoryExceptions, UnitCount,
            "Exceptions thrown during the interval. Thrown exceptions are expensive and often hide control-flow bugs."),

        ["assembly-count"] = new("assembly-count", "Assemblies", CategoryOther, UnitCount,
            "Number of assemblies loaded."),

        ["methods-jitted-count"] = new("methods-jitted-count", "Methods Jitted", CategoryJit, UnitCount,
            "Methods compiled by the JIT."),

        ["il-bytes-jitted"] = new("il-bytes-jitted", "IL Bytes Jitted", CategoryJit, UnitBytes,
            "IL bytes compiled by the JIT.", DefaultRawUnit: "B"),

        ["time-in-jit"] = new("time-in-jit", "Time in JIT", CategoryJit, UnitPercent,
            "Percentage of elapsed time spent compiling methods.", DefaultRawUnit: "%"),

        ["active-timer-count"] = new("active-timer-count", "Active Timers", CategoryOther, UnitCount,
            "Number of timers currently active."),
    };

    /// <summary>Look up metadata, synthesising an entry for counters we have not seen before.</summary>
    public static CounterDefinition Resolve(string name, string? displayName, string? rawUnit)
    {
        if (Definitions.TryGetValue(name, out var known))
            return known;

        var mapped = MapRawUnit(rawUnit);
        var unit = mapped.Unit ?? UnitCount;

        return new CounterDefinition(
            name,
            string.IsNullOrWhiteSpace(displayName) ? name : displayName!,
            CategoryOther,
            unit,
            "Runtime counter reported by System.Runtime.",
            IsMemory: unit is UnitBytes or UnitBytesPerSecond,
            DefaultRawUnit: rawUnit);
    }

    /// <summary>
    /// Converts a raw counter value into the canonical unit declared by
    /// <paramref name="definition"/>.
    ///
    /// Order matters: the runtime's own unit is applied first (that is what tells us
    /// whether "1700" means bytes, kilobytes or megabytes), then the catalog's extra scale,
    /// then the per-second conversion for rate counters.
    /// </summary>
    public static double Normalize(double rawValue, string? rawUnit, CounterDefinition definition, double intervalMs)
    {
        var fromRuntime = MapRawUnit(rawUnit);
        var scale = fromRuntime.Unit is not null
            ? fromRuntime.Scale
            : MapRawUnit(definition.DefaultRawUnit).Scale;

        var value = rawValue * scale;
        value *= definition.ExtraScale;

        if (definition.ScaleByProcessorCount)
            value *= Math.Max(1, Environment.ProcessorCount);

        if (definition.IsRate && intervalMs > 0)
            value = value * 1000d / intervalMs;

        return value;
    }

    private static (string? Unit, double Scale) MapRawUnit(string? rawUnit)
        => rawUnit?.Trim().ToUpperInvariant() switch
        {
            "B" => (UnitBytes, 1),
            "KB" => (UnitBytes, Kb),
            "MB" => (UnitBytes, Mb),
            "GB" => (UnitBytes, Gb),
            "%" => (UnitPercent, 1),
            "MS" => (UnitMilliseconds, 1),
            "MSEC" => (UnitMilliseconds, 1),
            // No usable unit from the runtime: signal the caller to fall back to the catalog.
            _ => (null, 1),
        };

    /// <summary>All catalogued definitions, exposed to the UI as capability metadata.</summary>
    public static IReadOnlyDictionary<string, CounterDefinition> All => Definitions;
}
