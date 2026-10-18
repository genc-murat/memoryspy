using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Diagnostics.NETCore.Client;

namespace MemorySpy.Collector.Core;

/// <summary>A .NET process the collector can attach to.</summary>
public sealed record DotnetProcessInfo
{
    public required int Pid { get; init; }
    public required string Name { get; init; }
    public string? CommandLine { get; init; }
    public string? ExecutablePath { get; init; }
    public string? RuntimeVersion { get; init; }
    public string? RuntimeDirectory { get; init; }
    public long? WorkingSetBytes { get; init; }
    public long? PrivateBytes { get; init; }
    public long? StartTimeUnixMs { get; init; }
}

/// <summary>
/// Finds attachable .NET processes and enriches them with the OS-level detail a developer
/// needs to pick the right one (command line, resident memory, runtime version).
///
/// Process enumeration comes from <see cref="DiagnosticsClient.GetPublishedProcesses"/>,
/// which reads the diagnostic IPC endpoints the runtime publishes. Everything else is
/// best effort OS introspection: a process that dies mid-enumeration or belongs to another
/// user must degrade to "unknown" rather than failing the whole list.
/// </summary>
public static class ProcessDiscovery
{
    public static IReadOnlyList<DotnetProcessInfo> List(bool includeDetails = true)
    {
        int[] pids;
        try
        {
            pids = DiagnosticsClient.GetPublishedProcesses()
                // The collector publishes a diagnostics endpoint like any other .NET process, so
                // it would list itself as an attachable target. It is the tool, never a target.
                .Where(pid => pid != Environment.ProcessId)
                .Distinct()
                .OrderBy(p => p)
                .ToArray();
        }
        catch
        {
            return Array.Empty<DotnetProcessInfo>();
        }

        var results = new List<DotnetProcessInfo>(pids.Length);
        foreach (var pid in pids)
        {
            try
            {
                results.Add(Describe(pid, includeDetails));
            }
            catch
            {
                results.Add(new DotnetProcessInfo { Pid = pid, Name = $"pid {pid}" });
            }
        }

        return results;
    }

    public static DotnetProcessInfo? Describe(int pid)
    {
        try
        {
            return Describe(pid, includeDetails: true);
        }
        catch
        {
            return null;
        }
    }

    private static DotnetProcessInfo Describe(int pid, bool includeDetails)
    {
        string name = $"pid {pid}";
        string? executable = null;
        long? workingSet = null;
        long? privateBytes = null;
        long? startTime = null;

        try
        {
            using var process = Process.GetProcessById(pid);
            name = process.ProcessName;
            try
            {
                workingSet = process.WorkingSet64;
                // Several platforms report 0 for private memory rather than throwing;
                // reporting null is more honest than reporting a fake zero.
                var priv = process.PrivateMemorySize64;
                privateBytes = priv > 0 ? priv : null;
                startTime = new DateTimeOffset(process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
                executable = process.MainModule?.FileName;
            }
            catch
            {
                // Cross-user processes deny access to these properties; the name is enough.
            }
        }
        catch
        {
            // The process disappeared between enumeration and inspection.
        }

        string? commandLine = null;
        string? runtimeVersion = null;
        string? runtimeDirectory = null;

        if (includeDetails)
        {
            commandLine = GetCommandLine(pid);
            (runtimeVersion, runtimeDirectory) = GetRuntimeInfo(pid);
        }

        return new DotnetProcessInfo
        {
            Pid = pid,
            Name = name,
            CommandLine = commandLine,
            ExecutablePath = executable,
            RuntimeVersion = runtimeVersion,
            RuntimeDirectory = runtimeDirectory,
            WorkingSetBytes = workingSet,
            PrivateBytes = privateBytes,
            StartTimeUnixMs = startTime,
        };
    }

    /// <summary>
    /// Reads the process command line. On Unix the process table gives it to us directly;
    /// on Windows only the executable path is available without WMI, so the caller falls
    /// back to the process name.
    /// </summary>
    public static string? GetCommandLine(int pid)
    {
        if (OperatingSystem.IsWindows())
            return null;

        var output = RunTool("/bin/ps", $"-p {pid} -o command=", TimeSpan.FromSeconds(2));
        if (string.IsNullOrWhiteSpace(output))
            return null;

        var line = output.Trim();
        return line.Length == 0 ? null : line;
    }

    /// <summary>
    /// Derives the exact runtime version of the target process from the loaded coreclr
    /// library. The path of that library encodes the version
    /// (<c>.../Microsoft.NETCore.App/8.0.11/libcoreclr.dylib</c>), which is the most
    /// reliable cross-platform answer short of implementing the diagnostics IPC
    /// process-info command by hand.
    /// </summary>
    public static (string? Version, string? Directory) GetRuntimeInfo(int pid)
    {
        string? path = FindCoreClrPath(pid);
        if (path is null)
            return (null, null);

        var directory = Path.GetDirectoryName(path);

        // .../Microsoft.NETCore.App/<version>/libcoreclr.so
        var versionDirectory = directory is not null ? Path.GetFileName(directory) : null;
        return (versionDirectory, directory);
    }

    private static string? FindCoreClrPath(int pid)
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                using var process = Process.GetProcessById(pid);
                foreach (ProcessModule module in process.Modules)
                {
                    var name = module.ModuleName;
                    if (name is not null && name.StartsWith("coreclr", StringComparison.OrdinalIgnoreCase))
                        return module.FileName;
                }
            }
            catch
            {
                // Fall through to lsof-less behaviour.
            }

            return null;
        }

        // lsof lists the mapped runtime libraries; -Fn prints file names only.
        var output = RunTool("/usr/sbin/lsof", $"-p {pid} -F n", TimeSpan.FromSeconds(3))
                     ?? RunTool("/usr/bin/lsof", $"-p {pid} -F n", TimeSpan.FromSeconds(3));

        if (string.IsNullOrWhiteSpace(output))
            return null;

        return output
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(line => line.StartsWith("n", StringComparison.Ordinal))
            .Select(line => line[1..])
            .FirstOrDefault(path =>
                path.Contains("libcoreclr", StringComparison.OrdinalIgnoreCase) &&
                (path.EndsWith(".dylib", StringComparison.OrdinalIgnoreCase) ||
                 path.EndsWith(".so", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(Path.GetFileName(path), "libcoreclr", StringComparison.OrdinalIgnoreCase)));
    }

    /// <summary>
    /// Runs a small read-only helper process with a hard timeout. Returns null when the
    /// tool is missing, slow or fails — process introspection must never block the
    /// collector.
    /// </summary>
    private static string? RunTool(string fileName, string arguments, TimeSpan timeout)
    {
        try
        {
            var psi = new ProcessStartInfo(fileName, arguments)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var process = Process.Start(psi);
            if (process is null)
                return null;

            var stdout = process.StandardOutput.ReadToEndAsync();

            if (!process.WaitForExit((int)timeout.TotalMilliseconds))
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // Already gone.
                }

                return null;
            }

            return stdout.Wait(TimeSpan.FromMilliseconds(500)) ? stdout.Result : null;
        }
        catch
        {
            return null;
        }
    }
}
