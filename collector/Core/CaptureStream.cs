namespace MemorySpy.Collector.Core;

/// <summary>
/// Copies an EventPipe stream to disk while the parser reads it.
///
/// The session has exactly one reader of the runtime's event stream — the TraceEvent parser —
/// so the copy has to be made by the thing doing the reading: a stream that forwards every
/// read to the network pipe and appends the same bytes to a file. That is how a live attach
/// produces a real <c>.nettrace</c>, which is the only form in which allocation call stacks
/// can be resolved.
///
/// The copy is best-effort by design:
/// <list type="item">
/// <item>a write error stops the copy and records why, but never fails the session — the
/// live stream is the primary product and the capture is a bonus;</item>
/// <item><see cref="MaxBytes"/> bounds how much disk a long session can consume — but a
/// nettrace file that is simply cut at a byte offset is not a trace any more: the format's
/// closing sequence depends on the writer's object state, so a truncated tail makes the
/// whole file unreadable to TraceEvent. Reaching the cap therefore only <em>flags</em> the
/// capture (<see cref="Truncated"/>, <see cref="CapReached"/>) and keeps writing — the
/// session stops itself in response, so the runtime's own flush and stream epilogue close
/// the file properly and the analysis still has a readable trace covering the prefix.</item>
/// </list>
/// </summary>
internal sealed class CaptureStream : Stream
{
    private readonly Stream _source;
    private readonly FileStream _file;
    private readonly long _maxBytes;
    private long _written;
    private int _capReached;
    private bool _truncated;
    private bool _disposed;
    private string? _writeError;

    public CaptureStream(Stream source, string path, long maxBytes)
    {
        _source = source;
        Path = path;
        _maxBytes = maxBytes <= 0 ? long.MaxValue : maxBytes;

        var directory = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
            Directory.CreateDirectory(directory);

        _file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 16);
    }

    /// <summary>Where the capture is being written.</summary>
    public string Path { get; }

    /// <summary>Bytes copied so far.</summary>
    public long Written => Interlocked.Read(ref _written);

    /// <summary>The configured size limit, for messages that name it.</summary>
    public long MaxBytes => _maxBytes;

    /// <summary>True when the size cap was reached and the tail of the stream was not kept.</summary>
    public bool Truncated => _truncated;

    /// <summary>The first write failure, if the capture stopped early.</summary>
    public string? WriteError => _writeError;

    /// <summary>
    /// Fired once, on the parser thread, the first time a write crosses the size cap.
    ///
    /// The session responds by stopping itself: only the runtime can close the stream with
    /// the sequence that makes the file readable, and only a stopped session produces one.
    /// </summary>
    public event Action? CapReached;

    private void Capture(ReadOnlySpan<byte> data)
    {
        if (data.Length == 0 || _writeError is not null)
            return;

        try
        {
            _file.Write(data);
            Interlocked.Add(ref _written, data.Length);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ObjectDisposedException)
        {
            _writeError = ex.Message;
            return;
        }

        if (_capReached == 0 && _written > _maxBytes && Interlocked.Exchange(ref _capReached, 1) == 0)
        {
            _truncated = true;
            CapReached?.Invoke();
        }
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        var read = _source.Read(buffer, offset, count);
        if (read > 0)
            Capture(buffer.AsSpan(offset, read));
        return read;
    }

    public override int Read(Span<byte> buffer)
    {
        var read = _source.Read(buffer);
        if (read > 0)
            Capture(buffer[..read]);
        return read;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        var read = await _source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
        if (read > 0)
            Capture(buffer.Span[..read]);
        return read;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    /// <summary>Flushes and closes the file so the capture can be read by another process.</summary>
    public void CloseFile()
    {
        if (_disposed)
            return;

        _disposed = true;
        try
        {
            _file.Flush();
            _file.Dispose();
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            _writeError ??= ex.Message;
        }
    }

    public override void Flush() => _file.Flush();

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
            CloseFile();
        base.Dispose(disposing);
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
