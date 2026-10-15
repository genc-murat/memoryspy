import { useCallback, useEffect, useState } from 'react';

import { formatAge, formatBytes, formatDuration } from '../lib/format';
import { api } from '../lib/ipc';
import type { RecordingSummary } from '../lib/types';

interface Props {
  recordingsDir: string;
  /** The recording currently being replayed, if any. */
  activePath: string | null;
  /** The file a live session is writing right now, if any. */
  recordingPath: string | null;
  /** Bumped by the shell when a recording finishes, to pull the new file into the list. */
  refreshToken: number;
  onReplay: (path: string) => void;
}

const END_REASON_LABEL: Record<string, string> = {
  detached: 'detached cleanly',
  'target-exited': 'target exited',
  'collector-exited': 'collector exited',
  'collector-failed': 'collector failed',
  'recording-stopped': 'recording stopped',
};

/**
 * The recordings library.
 *
 * This is the view that makes the feature useful after the fact: the leak already happened,
 * the process is long gone, and the only thing left is a file someone sent over. So the
 * panel leads with what the file *is* — which process, how long, how much data — and treats
 * opening an arbitrary path as a first-class action next to the ones MemorySpy wrote itself.
 */
export function RecordingsPanel({
  recordingsDir,
  activePath,
  recordingPath,
  refreshToken,
  onReplay,
}: Props) {
  const [recordings, setRecordings] = useState<RecordingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openPath, setOpenPath] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRecordings(await api.listRecordings());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const remove = async (recording: RecordingSummary) => {
    try {
      await api.deleteRecording(recording.path);
      setError(null);
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const open = () => {
    const path = openPath.trim();
    if (!path) return;
    onReplay(path);
  };

  const totalBytes = recordings?.reduce((sum, recording) => sum + recording.sizeBytes, 0) ?? 0;

  return (
    <div className="panel">
      <div className="block-head">
        <div>
          <h2>Recordings</h2>
          <p className="dim">
            A recording is the collector's event stream written verbatim to disk. Replaying one runs it through the
            same pipeline as a live session, so every view and every diagnosis rule works offline.
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="inline-error inline-error-wide">{error}</div>}

      <div className="recording-import">
        <label className="field">
          <span className="field-label">Open a recording from elsewhere</span>
          <span className="recording-import-row">
            <input
              className="input"
              placeholder="/path/to/memoryspy-OrderService-4242-20261014-031502.jsonl"
              value={openPath}
              spellCheck={false}
              onChange={(event) => setOpenPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') open();
              }}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={open} disabled={!openPath.trim()}>
              Open
            </button>
          </span>
        </label>
        <p className="caveat">
          A colleague can send you the file itself; nothing else is needed to analyse it. Recordings live in{' '}
          <code className="tag-mono">{recordingsDir || 'the app data folder'}</code>.
        </p>
      </div>

      {recordings && recordings.length > 0 && (
        <p className="dim recording-summary">
          {recordings.length} recording{recordings.length === 1 ? '' : 's'} · {formatBytes(totalBytes)} on disk
        </p>
      )}

      {recordings !== null && recordings.length === 0 && (
        <p className="empty-note">
          Nothing has been recorded yet. Tick <strong>Record session to disk</strong> in the left rail before attaching —
          or while attached — and the session's events are written as they arrive.
        </p>
      )}

      {recordings !== null && recordings.length > 0 && (
        <div className="recording-list">
          {recordings.map((recording) => {
            const isActive = recording.path === activePath;
            const isRecording = recording.path === recordingPath;
            const broken = Boolean(recording.error);

            return (
              <article key={recording.path} className={`recording-row${isActive ? ' is-active' : ''}`}>
                <div className="recording-row-main">
                  <span className="recording-name">
                    {recording.targetName ?? recording.fileName}
                    {recording.targetPid != null && <span className="recording-pid">pid {recording.targetPid}</span>}
                    {isActive && <span className="tag tag-live">replaying</span>}
                    {isRecording && <span className="tag tag-live">recording now</span>}
                    {!recording.complete && !isRecording && <span className="tag tag-warn">incomplete</span>}
                  </span>

                  <span className="recording-file" title={recording.path}>
                    {recording.fileName}
                  </span>

                  <span className="recording-meta">
                    <span>{formatAge(recording.startedAtUnixMs)}</span>
                    <span>{formatDuration(recording.durationMs)}</span>
                    <span>{formatBytes(recording.sizeBytes)}</span>
                    <span>{recording.messageCount.toLocaleString()} messages</span>
                    {recording.runtimeVersion && <span>.NET {recording.runtimeVersion}</span>}
                    {recording.endReason && (
                      <span>{END_REASON_LABEL[recording.endReason] ?? recording.endReason}</span>
                    )}
                  </span>

                  {broken && <span className="recording-error">{recording.error}</span>}
                </div>

                <div className="recording-row-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => onReplay(recording.path)}
                    disabled={broken || isActive}
                  >
                    {isActive ? 'Playing' : 'Replay'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => void remove(recording)}
                    disabled={isRecording}
                    title={isRecording ? 'Stop recording before deleting this file.' : 'Delete this recording'}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <p className="caveat">
        The format is plain newline delimited JSON: a header line naming the target, one line per event, and a footer
        written when the session ends. Files are meant to be quotable — <code className="tag-mono">wc -l</code> or{' '}
        <code className="tag-mono">jq</code> on one is a valid way to check it before sending it on. Treat a recording as
        production data: it contains type names and process details from the machine it came from.
      </p>
    </div>
  );
}
