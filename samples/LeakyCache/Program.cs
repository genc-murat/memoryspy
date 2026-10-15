using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;

// A deliberately misbehaving service used to exercise MemorySpy.
//
// Each mode reproduces a different real world memory problem so the tool can be judged on
// whether it actually points at the right culprit:
//
//   cache        a static dictionary that is only ever added to (the classic managed leak)
//   loh          large byte arrays that fragment the Large Object Heap
//   strings      unbounded string accumulation (duplicated keys, log buffers)
//   churn        no leak at all, just a very high allocation rate
//   handles      pinned buffers held forever, plus event handlers never unsubscribed
//   all          everything at once
//
// Usage: dotnet MemorySpy.Samples.LeakyCache.dll [mode] [--seconds N]

var mode = args.FirstOrDefault(a => !a.StartsWith("--", StringComparison.Ordinal)) ?? "cache";
var seconds = ParseSeconds(args);
var deadline = seconds > 0 ? DateTime.UtcNow.AddSeconds(seconds) : DateTime.MaxValue;

Console.WriteLine($"LeakyCache starting — mode={mode}, pid={Environment.ProcessId}" + (seconds > 0 ? $", running for {seconds}s" : ", running until Ctrl+C"));
Console.Out.Flush();

using var cancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cancellation.Cancel();
};

var workers = new List<Task>();

if (mode is "cache" or "all")
    workers.Add(Task.Run(() => RunCache(cancellation.Token)));

if (mode is "loh" or "all")
    workers.Add(Task.Run(() => RunLargeObjects(cancellation.Token)));

if (mode is "strings" or "all")
    workers.Add(Task.Run(() => RunStrings(cancellation.Token)));

if (mode is "churn" or "all")
    workers.Add(Task.Run(() => RunChurn(cancellation.Token)));

if (mode is "handles" or "all")
    workers.Add(Task.Run(() => RunHandles(cancellation.Token)));

if (workers.Count == 0)
{
    Console.Error.WriteLine($"Unknown mode '{mode}'. Use cache, loh, strings, churn, handles or all.");
    return 1;
}

if (seconds > 0)
{
    var delay = Task.Delay(TimeSpan.FromSeconds(seconds));
    await Task.WhenAny(Task.WhenAll(workers), delay);
    cancellation.Cancel();
}
else
{
    await Task.WhenAll(workers);
}

Console.WriteLine("LeakyCache stopped.");
return 0;

// ---------------------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------------------

// Never evicted, never bounded: the signature of a managed leak. Objects survive into
// generation 2, so Gen 2 size climbs while time spent in GC stays low.
static async Task RunCache(CancellationToken token)
{
    var cache = new Dictionary<Guid, SessionRecord>();
    var counter = 0;

    while (!token.IsCancellationRequested)
    {
        for (var i = 0; i < 250; i++)
        {
            var id = Guid.NewGuid();
            cache[id] = new SessionRecord(id, $"session-{counter++}", DateTime.UtcNow, new byte[256]);
        }

        await Task.Delay(5, token).ContinueWith(_ => { }, CancellationToken.None);
    }

    Console.WriteLine($"cache: final count = {cache.Count}");
}

// Allocations above 85 KB land on the LOH, which is not compacted by default. Growing it
// forever produces fragmentation and a soaring working set without much Gen 2 movement.
static async Task RunLargeObjects(CancellationToken token)
{
    var retained = new List<byte[]>();

    while (!token.IsCancellationRequested)
    {
        for (var i = 0; i < 20; i++)
            retained.Add(new byte[128 * 1024]);

        if (retained.Count > 4_000)
            retained.RemoveRange(0, 2_000);

        await Task.Delay(10, token).ContinueWith(_ => { }, CancellationToken.None);
    }

    Console.WriteLine($"loh: retained arrays = {retained.Count}");
}

// String building that keeps every intermediate result alive.
static async Task RunStrings(CancellationToken token)
{
    var log = new ConcurrentBag<string>();

    while (!token.IsCancellationRequested)
    {
        var builder = new StringBuilder();
        for (var i = 0; i < 200; i++)
            builder.Append(Guid.NewGuid().ToString("N"));

        log.Add(builder.ToString());
        await Task.Delay(2, token).ContinueWith(_ => { }, CancellationToken.None);
    }

    Console.WriteLine($"strings: entries = {log.Count}");
}

// No leak, just heavy allocation pressure: allocation rate is high while the heap stays flat.
static async Task RunChurn(CancellationToken token)
{
    var checksum = 0L;

    while (!token.IsCancellationRequested)
    {
        for (var i = 0; i < 5_000; i++)
        {
            var temp = new ChurnItem(i, i * 1.5, $"item-{i}");
            checksum += temp.Value.GetHashCode();
        }

        await Task.Yield();
    }

    Console.WriteLine($"churn: checksum = {checksum}");
}

// Pinned buffers and never-removed event handlers: memory that the GC cannot move or free.
static async Task RunHandles(CancellationToken token)
{
    var source = new EventSourceLike();
    var pinned = new List<GCHandle>();

    while (!token.IsCancellationRequested)
    {
        for (var i = 0; i < 100; i++)
        {
            var buffer = new byte[1024];
            pinned.Add(GCHandle.Alloc(buffer, GCHandleType.Pinned));
            source.Changed += (_, _) => { };
        }

        source.Raise();
        await Task.Delay(20, token).ContinueWith(_ => { }, CancellationToken.None);
    }

    Console.WriteLine($"handles: pinned = {pinned.Count}");
}

static int ParseSeconds(string[] args)
{
    var index = Array.IndexOf(args, "--seconds");
    return index >= 0 && index + 1 < args.Length && int.TryParse(args[index + 1], out var value) ? value : 0;
}

internal sealed record SessionRecord(Guid Id, string Name, DateTime CreatedAt, byte[] Payload);

internal sealed record ChurnItem(int Id, double Value, string Label);

internal sealed class EventSourceLike
{
    public event EventHandler? Changed;

    public void Raise() => Changed?.Invoke(this, EventArgs.Empty);
}
