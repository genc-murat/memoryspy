using System.Diagnostics.Tracing;
using Microsoft.Diagnostics.NETCore.Client;

namespace MemorySpy.Collector.Core;

/// <summary>
/// Folds the provider lists requested by every probe into a single, deduplicated list.
///
/// All probes share one EventPipe session on purpose: each additional session costs the
/// target process another buffer and another set of callbacks, so a tool that attaches
/// many probes must not attach many sessions. Merging is the price of that design —
/// two probes asking for the same provider must end up with the union of their keywords,
/// the higher of their levels and a merged argument dictionary.
/// </summary>
public static class ProviderMerger
{
    public static IReadOnlyList<EventPipeProvider> Merge(IEnumerable<EventPipeProvider> requested)
    {
        var merged = new Dictionary<string, (long Keywords, EventLevel Level, Dictionary<string, string> Args)>(StringComparer.Ordinal);

        foreach (var provider in requested)
        {
            if (string.IsNullOrWhiteSpace(provider.Name))
                continue;

            if (merged.TryGetValue(provider.Name, out var existing))
            {
                var args = existing.Args;
                if (provider.Arguments is not null)
                {
                    foreach (var kv in provider.Arguments)
                        args[kv.Key] = kv.Value;
                }

                merged[provider.Name] = (
                    existing.Keywords | provider.Keywords,
                    (EventLevel)Math.Max((int)existing.Level, (int)provider.EventLevel),
                    args);
            }
            else
            {
                var args = new Dictionary<string, string>(StringComparer.Ordinal);
                if (provider.Arguments is not null)
                {
                    foreach (var kv in provider.Arguments)
                        args[kv.Key] = kv.Value;
                }

                merged[provider.Name] = (provider.Keywords, provider.EventLevel, args);
            }
        }

        return merged
            .Select(kv => new EventPipeProvider(
                kv.Key,
                kv.Value.Level,
                kv.Value.Keywords,
                kv.Value.Args.Count == 0 ? null : kv.Value.Args))
            .ToList();
    }
}
