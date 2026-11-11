using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using MemorySpy.Collector.Protocol;

namespace MemorySpy.Collector.Core;

internal static class DumpSourceLookup
{
    public static int Run(string[] args, Emitter emitter)
    {
        if (args.Length is not (4 or 5))
        {
            emitter.Error("dump-source requires an assembly path, dump module identity and runtime type name.");
            return 1;
        }

        try
        {
            var path = Path.GetFullPath(args[1]);
            using var assembly = new PEReader(File.OpenRead(path));
            var metadata = assembly.GetMetadataReader();
            if (!MatchesDumpModule(assembly, metadata, args[2]))
            {
                emitter.Error("This assembly belongs to a different build. Choose the assembly recorded in the dump.");
                return 1;
            }
            var requestedType = args[3];
            var type = metadata.TypeDefinitions.FirstOrDefault(handle => TypeName(metadata, handle) == requestedType);
            if (type.IsNil && GenericDefinitionName(requestedType) is { } definition)
                type = metadata.TypeDefinitions.FirstOrDefault(handle => TypeName(metadata, handle) == definition);
            if (type.IsNil)
            {
                emitter.Error($"The assembly does not contain type '{requestedType}'.");
                return 1;
            }

            if (!assembly.TryOpenAssociatedPortablePdb(path, File.OpenRead, out var provider, out _) || provider is null)
            {
                emitter.Error("No matching portable PDB was found beside or embedded in the assembly.");
                return 1;
            }

            using (provider)
            {
                var symbols = provider.GetMetadataReader();
                var methodName = args.Length == 5 ? args[4] : null;
                var methods = metadata.GetTypeDefinition(type).GetMethods()
                    .Where(method => methodName is null ||
                        metadata.GetString(metadata.GetMethodDefinition(method).Name) == methodName)
                    .ToArray();
                if (methodName is not null && methods.Length > 1)
                {
                    emitter.Error("The stack frame matches multiple overloads. Use the method name to navigate in your editor.");
                    return 1;
                }
                var points = methods
                    .Select(method => LocateMethod(metadata, symbols, method, methodName is not null))
                    .OfType<SourceLocation>()
                    .OrderByDescending(location => location.IsMethodLocation)
                    .ThenBy(location => location.SourceLine)
                    .ToArray();
                if (points.Length == 0)
                {
                    emitter.Error("The matching PDB has no source location for this type.");
                    return 1;
                }

                emitter.Emit("dump.source", null, points[0]);
                return 0;
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or BadImageFormatException)
        {
            emitter.Error("Could not read the assembly or its symbols.", ex: error);
            return 1;
        }
    }

    private static bool MatchesDumpModule(PEReader assembly, MetadataReader metadata, string identity)
    {
        if (identity.StartsWith("mvid:", StringComparison.Ordinal))
        {
            var handle = metadata.GetModuleDefinition().Mvid;
            return !handle.IsNil && string.Equals(
                "mvid:" + Convert.ToHexString(metadata.GetGuid(handle).ToByteArray()),
                identity, StringComparison.OrdinalIgnoreCase);
        }
        if (identity.StartsWith("codeview:", StringComparison.Ordinal))
        {
            foreach (var entry in assembly.ReadDebugDirectory())
            {
                if (entry.Type != DebugDirectoryEntryType.CodeView)
                    continue;
                var codeView = assembly.ReadCodeViewDebugDirectoryData(entry);
                var candidate = $"codeview:{Convert.ToHexString(codeView.Guid.ToByteArray())}:{codeView.Age}";
                if (string.Equals(identity, candidate, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
        }
        return false;
    }

    private static string TypeName(MetadataReader metadata, TypeDefinitionHandle handle)
    {
        var definition = metadata.GetTypeDefinition(handle);
        var name = metadata.GetString(definition.Name);
        var parent = definition.GetDeclaringType();
        if (!parent.IsNil)
            return TypeName(metadata, parent) + "+" + name;

        var ns = metadata.GetString(definition.Namespace);
        return ns.Length == 0 ? name : ns + "." + name;
    }

    private static SourceLocation? LocateMethod(
        MetadataReader metadata, MetadataReader symbols, MethodDefinitionHandle method, bool matchedMethod)
    {
        var debug = symbols.GetMethodDebugInformation(method);
        var kickoff = debug.GetStateMachineKickoffMethod();
        var methodName = metadata.GetString(metadata.GetMethodDefinition(kickoff.IsNil ? method : kickoff).Name);
        foreach (var point in debug.GetSequencePoints())
        {
            var document = point.Document.IsNil ? debug.Document : point.Document;
            if (point.IsHidden || document.IsNil)
                continue;

            var source = symbols.GetDocument(document);
            var sha256 = !source.HashAlgorithm.IsNil &&
                symbols.GetGuid(source.HashAlgorithm) == new Guid("8829d00f-11b8-4213-878b-770e8597ac16");
            return new SourceLocation(symbols.GetString(source.Name), point.StartLine,
                FriendlyMethodName(methodName), matchedMethod || !kickoff.IsNil,
                sha256 ? Convert.ToHexString(symbols.GetBlobBytes(source.Hash)) : null);
        }
        return null;
    }

    private static string FriendlyMethodName(string method)
    {
        var start = method.IndexOf(">g__", StringComparison.Ordinal);
        var end = start >= 0 ? method.IndexOf('|', start + 4) : -1;
        return end > start ? method[(start + 4)..end] : method;
    }

    private static string? GenericDefinitionName(string name)
    {
        var open = name.IndexOf('<');
        if (open <= 0 || name[open - 1] == '+')
            return null;

        var depth = 0;
        var arity = 1;
        for (var index = open; index < name.Length; index++)
        {
            switch (name[index])
            {
                case '<':
                    depth++;
                    break;
                case '>':
                    if (--depth == 0)
                        return index == name.Length - 1 ? name[..open] + "`" + arity : null;
                    break;
                case ',' when depth == 1:
                    arity++;
                    break;
            }
        }
        return null;
    }

    private sealed record SourceLocation(
        string SourceFile, int SourceLine, string MethodName, bool IsMethodLocation, string? Sha256);
}
