namespace MemorySpy.Collector.Core;

/// <summary>
/// Runtime options for a collector session. Populated from the command line by
/// <see cref="Program"/>; passed to every probe through <see cref="ProbeContext"/>.
/// </summary>
public sealed class CollectorOptions
{
    /// <summary>Target process id to attach to.</summary>
    public int Pid { get; set; }

    /// <summary>How often buffered aggregates are flushed, in milliseconds.</summary>
    public int IntervalMs { get; set; } = 1000;

    /// <summary>Ids of the probes to enable. Empty means "all discovered probes".</summary>
    public List<string> Probes { get; } = new();

    /// <summary>How many allocating types to report per interval (ranked by growth).</summary>
    public int MaxAllocationTypes { get; set; } = 150;

    /// <summary>Mirror every raw TraceEvent to stderr for troubleshooting probes.</summary>
    public bool Verbose { get; set; }

    /// <summary>Emit unresolved events so probes can be developed against unknown providers.</summary>
    public bool DumpRawEvents { get; set; }

    /// <summary>
    /// Where to write the raw EventPipe stream while the session runs, as a <c>.nettrace</c>.
    ///
    /// This is what turns on the deep-capture path: allocation call stacks can only be named
    /// from a complete stream on disk, so probes implementing <c>IRawCaptureConsumer</c> are
    /// inert without it. It also switches the session to request method rundown, which is what
    /// gives those stacks their method names.
    /// </summary>
    public string? CapturePath { get; set; }

    /// <summary>
    /// Hard ceiling on the capture file, in bytes, so an unattended session cannot fill a
    /// disk. Reaching it stops the copy and the analysis reports the capture as truncated.
    /// </summary>
    public long CaptureMaxBytes { get; set; } = 256L * 1024 * 1024;
}
