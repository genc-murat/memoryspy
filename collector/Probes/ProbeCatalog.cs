namespace MemorySpy.Collector.Probes;

/// <summary>
/// The single place where probes are registered.
///
/// To add a diagnostic capability: write an <see cref="ICollectorProbe"/> and add its
/// factory here. Everything else — the command line, the merged EventPipe session, the
/// NDJSON stream, the host and the UI panel registry — picks it up automatically through
/// <c>capabilities</c>, because the host renders panels from the handshake rather than
/// from a hard coded list.
/// </summary>
public static class ProbeCatalog
{
    /// <summary>All known probes, keyed by id, in the order they should appear in the UI.</summary>
    public static IReadOnlyList<Func<ICollectorProbe>> Factories { get; } = new Func<ICollectorProbe>[]
    {
        static () => new RuntimeCountersProbe(),
        static () => new AllocationProbe(),
        static () => new AllocationSiteProbe(),
        static () => new GcStatsProbe(),
    };

    public static IReadOnlyList<ICollectorProbe> CreateAll()
        => Factories.Select(f => f()).ToList();

    /// <summary>
    /// Resolve requested probe ids. An empty request means "every probe"; unknown ids are
    /// reported through <paramref name="unknown"/> so the CLI can fail loudly instead of
    /// silently collecting less than the user asked for.
    /// </summary>
    public static IReadOnlyList<ICollectorProbe> Resolve(IEnumerable<string> requestedIds, out IReadOnlyList<string> unknown)
    {
        var all = CreateAll();
        var requested = requestedIds.Where(id => !string.IsNullOrWhiteSpace(id)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        if (requested.Count == 0)
        {
            unknown = Array.Empty<string>();
            return all;
        }

        var selected = new List<ICollectorProbe>();
        var missing = new List<string>();

        foreach (var id in requested)
        {
            var match = all.FirstOrDefault(p => string.Equals(p.Id, id, StringComparison.OrdinalIgnoreCase));
            if (match is null)
                missing.Add(id);
            else
                selected.Add(match);
        }

        unknown = missing;
        return selected;
    }

    /// <summary>Descriptions of every probe, used by the <c>capabilities</c> command and the UI handshake.</summary>
    public static IReadOnlyList<object> DescribeAll()
        => CreateAll().Select(p => (object)new
        {
            id = p.Id,
            displayName = p.DisplayName,
            description = p.Description,
            icon = p.Icon,
            channel = p.Channel.ToString(),
            eventTypes = p.EventTypes,
            details = p.Describe(),
        }).ToList();
}
