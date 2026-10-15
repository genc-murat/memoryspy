import { useMemo, useState } from 'react';

import { formatBytes, formatDuration } from '../lib/format';
import type { DotnetProcessInfo, SessionState } from '../lib/types';

interface Props {
  processes: DotnetProcessInfo[];
  loading: boolean;
  attachedPid: number | null;
  sessionState: SessionState | 'idle';
  probeIds: string[];
  selectedProbes: string[];
  intervalMs: number;
  maxTypes: number;
  error: string | null;
  /** The live session is writing its events to a file. */
  recordingPath: string | null;
  recordEnabled: boolean;
  /** The collector can copy its raw event stream, which is what call sites need. */
  deepCaptureSupported: boolean;
  deepCaptureEnabled: boolean;
  /** Where the running session's capture is going, if it is capturing. */
  capturePath: string | null;
  /** A replay is open, so attaching is refused by the host. */
  replayActive: boolean;
  onRefresh: () => void;
  onAttach: (process_: DotnetProcessInfo) => void;
  onDetach: () => void;
  onToggleProbe: (probeId: string) => void;
  onIntervalChange: (intervalMs: number) => void;
  onMaxTypesChange: (maxTypes: number) => void;
  onToggleRecord: (enabled: boolean) => void;
  onToggleDeepCapture: (enabled: boolean) => void;
}

/** The file name of a host path, so the rail can name an artifact without a wall of path. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * The left rail: choose a target, choose what to collect, then attach.
 *
 * The process list is the one place a user can tell this tool apart from a bare
 * `dotnet-counters --process-id`, so each row carries the detail needed to identify the right
 * process — the command line and the runtime version, not just a pid and an executable name.
 */
export function ProcessPicker({
  processes,
  loading,
  attachedPid,
  sessionState,
  probeIds,
  selectedProbes,
  intervalMs,
  maxTypes,
  error,
  recordingPath,
  recordEnabled,
  deepCaptureSupported,
  deepCaptureEnabled,
  capturePath,
  replayActive,
  onRefresh,
  onAttach,
  onDetach,
  onToggleProbe,
  onIntervalChange,
  onMaxTypesChange,
  onToggleRecord,
  onToggleDeepCapture,
}: Props) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const sorted = [...processes].sort((a, b) => (b.workingSetBytes ?? 0) - (a.workingSetBytes ?? 0));
    if (!needle) return sorted;
    return sorted.filter((process_) =>
      [process_.name, process_.commandLine, process_.runtimeVersion, String(process_.pid)]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle)),
    );
  }, [processes, filter]);

  const attached = processes.find((process_) => process_.pid === attachedPid) ?? null;
  const isLive = sessionState === 'running' || sessionState === 'starting';

  return (
    <aside className="rail">
      <div className="rail-section">
        <div className="rail-head">
          <span className="eyebrow">Target process</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loading}>
            {loading ? 'Scanning…' : 'Rescan'}
          </button>
        </div>

        <input
          className="input"
          placeholder="Filter by name, command line, pid"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          spellCheck={false}
        />

        {error && <div className="inline-error">{error}</div>}

        {replayActive && (
          <p className="rail-note">
            A recording is open. Close the replay (top of the window) to attach to a live process.
          </p>
        )}

        <div className="process-list">
          {filtered.length === 0 && !loading && (
            <p className="empty-note">
              No attachable .NET processes found. Start the service you want to inspect, then rescan.
            </p>
          )}

          {filtered.map((process_) => {
            const isAttached = process_.pid === attachedPid && isLive;
            return (
              <button
                type="button"
                key={process_.pid}
                className={`process-row${isAttached ? ' is-attached' : ''}`}
                onClick={() => (isAttached ? onDetach() : onAttach(process_))}
                disabled={loading || replayActive || (isLive && !isAttached)}
                title={process_.commandLine ?? process_.name}
              >
                <span className="process-row-top">
                  <span className="process-name">{process_.name}</span>
                  <span className="process-pid">{process_.pid}</span>
                </span>
                <span className="process-row-meta">
                  {process_.runtimeVersion && <span className="tag">.NET {process_.runtimeVersion}</span>}
                  {process_.workingSetBytes != null && <span>{formatBytes(process_.workingSetBytes)}</span>}
                  {process_.startTimeUnixMs != null && (
                    <span>{formatDuration(Date.now() - process_.startTimeUnixMs)} up</span>
                  )}
                </span>
                {process_.commandLine && <span className="process-cmd">{process_.commandLine}</span>}
                {isAttached && <span className="process-attached-badge">attached — click to detach</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rail-section">
        <span className="eyebrow">Collectors</span>
        <div className="probe-list">
          {probeIds.length === 0 && <p className="empty-note">Probe list unavailable until the collector is found.</p>}
          {probeIds.map((probeId) => (
            <label key={probeId} className="probe-row">
              <input
                type="checkbox"
                checked={selectedProbes.includes(probeId)}
                disabled={isLive}
                onChange={() => onToggleProbe(probeId)}
              />
              <span className="probe-id">{probeId}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="rail-section">
        <span className="eyebrow">Recording</span>

        <label className="probe-row">
          <input
            type="checkbox"
            checked={recordEnabled}
            onChange={(event) => onToggleRecord(event.target.checked)}
          />
          <span className="probe-id">Write session to disk</span>
        </label>

        {recordingPath ? (
          <p className="rail-note rail-note-live">
            Recording to <code className="tag-mono">{baseName(recordingPath)}</code>. Events are appended as they
            arrive, so the file is usable even if this machine is lost.
          </p>
        ) : (
          <p className="rail-note">
            The recording can be replayed later, on any machine, without the process it came from.
          </p>
        )}
      </div>

      <div className="rail-section">
        <span className="eyebrow">Deep capture</span>

        <label className="probe-row">
          <input
            type="checkbox"
            checked={deepCaptureEnabled}
            disabled={!deepCaptureSupported || isLive}
            onChange={(event) => onToggleDeepCapture(event.target.checked)}
          />
          <span className="probe-id">Resolve allocation call sites</span>
        </label>

        {!deepCaptureSupported ? (
          <p className="rail-note">
            This collector build cannot copy the raw event stream, so call sites are unavailable.
          </p>
        ) : isLive && capturePath ? (
          <p className="rail-note rail-note-live">
            Capturing to <code className="tag-mono">{baseName(capturePath)}</code>. Call sites are resolved when you detach.
          </p>
        ) : capturePath ? (
          <p className="rail-note">
            The last capture was written as <code className="tag-mono">{baseName(capturePath)}</code>. Its call sites are now
            in the Call Sites view.
          </p>
        ) : (
          <p className="rail-note">
            Copies the raw trace to disk and names the file and line behind every allocation — the only way to place a
            framework type such as <code>byte[]</code> in your own code. Reads the module's PDB, so a build whose PDB is
            next to the assembly answers with a line and a build without one answers with a method. Costs disk space and a
            few seconds when you detach, so arm it before attaching.
          </p>
        )}
      </div>

      <div className="rail-section">
        <span className="eyebrow">Sampling</span>

        <label className="field">
          <span className="field-label">Interval</span>
          <select
            className="input"
            value={intervalMs}
            disabled={isLive}
            onChange={(event) => onIntervalChange(Number(event.target.value))}
          >
            <option value={250}>250 ms — catch short spikes</option>
            <option value={500}>500 ms</option>
            <option value={1000}>1 s — default</option>
            <option value={2000}>2 s</option>
            <option value={5000}>5 s — long running</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">Types per sample</span>
          <select
            className="input"
            value={maxTypes}
            disabled={isLive}
            onChange={(event) => onMaxTypesChange(Number(event.target.value))}
          >
            <option value={50}>50</option>
            <option value={150}>150 — default</option>
            <option value={400}>400</option>
            <option value={1000}>1000 — noisy services</option>
          </select>
        </label>
      </div>

      {attached && isLive && (
        <div className="rail-section rail-attached">
          <span className="eyebrow">Attached</span>
          <p className="attached-name">{attached.name}</p>
          <p className="attached-detail">
            pid {attached.pid}
            {attached.runtimeVersion ? ` · .NET ${attached.runtimeVersion}` : ''}
          </p>
          <button type="button" className="btn btn-danger btn-block" onClick={onDetach}>
            Detach
          </button>
        </div>
      )}
    </aside>
  );
}
