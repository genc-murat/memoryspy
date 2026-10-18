import { useEffect, useMemo, useRef, useState } from 'react';

import { formatAge, formatBytes, formatDuration } from '../lib/format';
import { loadRailState, patchRailState, type LastTarget } from '../lib/railState';
import type { DockerContainer, DockerStatus, DotnetProcessInfo, SessionState } from '../lib/types';
import { RevealFileButton } from './RevealFileButton';

interface Props {
  processes: DotnetProcessInfo[];
  /** `null` until the host has answered; the Docker section only appears when it is available. */
  docker: DockerStatus | null;
  containers: DockerContainer[];
  /** Processes per container, filled the first time a container is expanded. */
  containerProcesses: Record<string, DotnetProcessInfo[]>;
  /** Containers whose process list is open in the rail. */
  expandedContainers: string[];
  /** Containers currently being staged/listed, so their rows can say so. */
  containerBusy: string[];
  /** The target of the last session, marked so it can be found again after a restart. */
  lastTarget: LastTarget | null;
  /** The remembered target is being checked before attaching to it. */
  resuming: boolean;
  /** Why the remembered target could not be resumed. */
  resumeNote: string | null;
  attachedContainer: string | null;
  attachedProcess: DotnetProcessInfo | null;
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
  /**
   * Whether `capturePath` is a file on this machine. False while a container capture is still
   * inside its container and true again once the host has copied it out.
   */
  captureOnThisMachine: boolean;
  /** Set when the last capture could not be copied out of its container. */
  captureCopyError: string | null;
  /** The container the capture belongs to, when it belongs to one. */
  captureContainer: string | null;
  /** A replay is open, so attaching is refused by the host. */
  replayActive: boolean;
  onRefresh: () => void;
  onRefreshContainers: () => void;
  onToggleContainer: (container: string) => void;
  onAttach: (process_: DotnetProcessInfo, container?: string) => void;
  onResume: () => void;
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
  docker,
  containers,
  containerProcesses,
  expandedContainers,
  containerBusy,
  lastTarget,
  resuming,
  resumeNote,
  attachedContainer,
  attachedProcess,
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
  captureOnThisMachine,
  captureCopyError,
  captureContainer,
  replayActive,
  onRefresh,
  onRefreshContainers,
  onToggleContainer,
  onAttach,
  onResume,
  onDetach,
  onToggleProbe,
  onIntervalChange,
  onMaxTypesChange,
  onToggleRecord,
  onToggleDeepCapture,
}: Props) {
  const [filter, setFilter] = useState('');
  const railRef = useRef<HTMLElement | null>(null);
  /** True while a remembered offset is being re-applied, so clamped values are not saved. */
  const restoringRailScrollRef = useRef(false);

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

  const attached = attachedProcess;
  const isLive = sessionState === 'running' || sessionState === 'starting';
  const dockerNeedsCollector = docker?.available && docker.stagedRids.length === 0;

  const isAttached = (process_: DotnetProcessInfo, container?: string) =>
    isLive &&
    process_.pid === attachedPid &&
    (container ?? null) === attachedContainer;

  // A pid only identifies a target together with its container, exactly as the attached row does.
  const isLastTarget = (process_: DotnetProcessInfo, container?: string) =>
    lastTarget !== null &&
    lastTarget.pid === process_.pid &&
    (lastTarget.container ?? null) === (container ?? null);

  // The rail scrolls on its own: Collectors, Recording, Deep capture and Sampling sit below the
  // target list, so reopening at the top would hide the section that was in use. The offset is
  // stored with the open containers — both describe how the rail looked, and both belong to the
  // webview rather than to the host settings file.
  useEffect(() => {
    const element = railRef.current;
    if (!element) return;

    const saved = loadRailState().scrollTop;
    const startedAt = performance.now();
    let saveTimer = 0;
    let frame = 0;
    let stopped = false;

    const stop = () => {
      stopped = true;
      restoringRailScrollRef.current = false;
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    // The rail grows after the first paint: probes, containers and the restored container lists
    // arrive from the host. Re-applying for a bounded window keeps the offset reachable while
    // that happens. The user's own input stops the attempt at once — fighting a scroll they just
    // made is worse than losing the old position.
    const onUserInput = () => stop();
    const inputEvents = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
    for (const type of inputEvents) element.addEventListener(type, onUserInput, { passive: true });

    if (saved > 0) {
      restoringRailScrollRef.current = true;

      const apply = () => {
        if (stopped) return;
        element.scrollTop = saved;
        const settled = Math.abs(element.scrollTop - saved) <= 1;
        if (settled || performance.now() - startedAt > 4000) {
          stop();
          return;
        }
        frame = requestAnimationFrame(apply);
      };

      apply();
    }

    // Trailing write rather than one per frame: localStorage is synchronous, and a fast scroll
    // must not block the rail. A closing window writes the last position immediately.
    const write = () => {
      saveTimer = 0;
      patchRailState({ scrollTop: element.scrollTop });
    };
    const onScroll = () => {
      if (restoringRailScrollRef.current) return;
      if (saveTimer === 0) saveTimer = window.setTimeout(write, 200);
    };
    const flushNow = () => {
      if (saveTimer !== 0) {
        clearTimeout(saveTimer);
        saveTimer = 0;
      }
      // While restoring, the value on screen is the browser's clamped one, not the remembered one.
      if (restoringRailScrollRef.current) return;
      patchRailState({ scrollTop: element.scrollTop });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushNow();
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flushNow);

    return () => {
      stop();
      element.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushNow);
      for (const type of inputEvents) element.removeEventListener(type, onUserInput);
      if (saveTimer !== 0) clearTimeout(saveTimer);
    };
  }, []);

  return (
    <aside className="rail" ref={railRef}>
      {lastTarget && !isLive && (
        <div className="rail-section rail-resume">
          <div className="rail-head">
            <span className="eyebrow">Last session</span>
            <span className="rail-note rail-note-detail">{formatAge(lastTarget.atUnixMs)}</span>
          </div>

          <p className="resume-target">
            <span className="resume-name">{lastTarget.name}</span>
            <span className="resume-detail">
              pid {lastTarget.pid}
              {lastTarget.container ? ` · ${lastTarget.container}` : ''}
            </span>
          </p>

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={onResume}
            // Not disabled for a replay or a live session: the click is what explains why it
            // cannot resume, and a greyed-out button would hide that reason.
            disabled={resuming}
            title={`Check that ${lastTarget.name} (pid ${lastTarget.pid}) still runs, then attach to it`}
          >
            {resuming ? 'Checking…' : 'Resume'}
          </button>

          {resumeNote && <p className="rail-note rail-note-warn">{resumeNote}</p>}
        </div>
      )}

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
            const attachedRow = isAttached(process_);
            const lastRow = isLastTarget(process_);
            return (
              <button
                type="button"
                key={process_.pid}
                className={`process-row${attachedRow ? ' is-attached' : ''}`}
                onClick={() => (attachedRow ? onDetach() : onAttach(process_))}
                disabled={loading || replayActive || (isLive && !attachedRow)}
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
                  {lastRow && <span className="tag tag-last">last target</span>}
                </span>
                {process_.commandLine && <span className="process-cmd">{process_.commandLine}</span>}
                {attachedRow && <span className="process-attached-badge">attached — click to detach</span>}
              </button>
            );
          })}
        </div>
      </div>

      {docker && (docker.available || docker.problem === 'daemonUnreachable') && (
        <div className="rail-section">
          <div className="rail-head">
            <span className="eyebrow">Containers</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onRefreshContainers}
              disabled={containerBusy.length > 0}
            >
              {containerBusy.length > 0 ? 'Listing…' : 'Refresh'}
            </button>
          </div>

          {!docker.available && (
            <>
              <p className="rail-note rail-note-warn">
                Docker is installed, but its daemon is not reachable. Start Docker (or Docker
                Desktop), then press Refresh.
              </p>
              {docker.error && <p className="rail-note rail-note-detail">{docker.error}</p>}
            </>
          )}

          {docker.available && dockerNeedsCollector && (
            <p className="rail-note rail-note-warn">
              No Linux collector has been published, so containers cannot be inspected yet. Run{' '}
              <code className="tag-mono">npm run collector:docker</code>.
            </p>
          )}

          {docker.available && (
            <div className="process-list">
              {containers.length === 0 && (
                <p className="empty-note">No running containers. Start one and refresh.</p>
              )}

              {containers.map((container) => {
                const isExpanded = expandedContainers.includes(container.name);
                const processes = containerProcesses[container.name];
                const busy = containerBusy.includes(container.name);
                const holdsLastTarget = lastTarget?.container === container.name;

                return (
                  <div key={container.id} className="container-group">
                    <button
                      type="button"
                      className="process-row"
                      onClick={() => onToggleContainer(container.name)}
                      disabled={busy || replayActive || isLive}
                      aria-expanded={isExpanded}
                      title={`${container.image}\n${container.status}\n${
                        isExpanded ? 'Click to collapse' : 'Click to list its .NET processes'
                      }`}
                    >
                      <span className="process-row-top">
                        <span className="process-name">{container.name}</span>
                        <span className="process-pid">
                          {busy ? 'listing…' : isExpanded ? '.NET ▾' : '.NET ▸'}
                        </span>
                      </span>
                      <span className="process-row-meta">
                        <span className="tag">docker</span>
                        <span>{container.status}</span>
                        {holdsLastTarget && <span className="tag tag-last">last target</span>}
                      </span>
                      <span className="process-cmd">{container.image}</span>
                    </button>

                    {isExpanded && !busy && processes?.length === 0 && (
                      <p className="rail-note">
                        No attachable .NET process in this container. Diagnostics must be enabled (it is by
                        default) and the process must be running.
                      </p>
                    )}

                    {isExpanded &&                      processes?.map((process_) => {
                        const attachedRow = isAttached(process_, container.name);
                        const lastRow = isLastTarget(process_, container.name);

                        return (
                          <button
                            type="button"
                            key={`${container.id}-${process_.pid}`}
                            className={`process-row process-row-nested${attachedRow ? ' is-attached' : ''}`}
                            onClick={() => (attachedRow ? onDetach() : onAttach(process_, container.name))}
                            disabled={replayActive || (isLive && !attachedRow)}
                            title={process_.commandLine ?? process_.name}
                          >
                            <span className="process-row-top">
                              <span className="process-name">{process_.name}</span>
                              <span className="process-pid">{process_.pid}</span>
                            </span>
                            <span className="process-row-meta">
                              {process_.runtimeVersion && (
                                <span className="tag">.NET {process_.runtimeVersion}</span>
                              )}
                              {process_.workingSetBytes != null && (
                                <span>{formatBytes(process_.workingSetBytes)}</span>
                              )}
                              {lastRow && <span className="tag tag-last">last target</span>}
                            </span>
                            {attachedRow && (
                              <span className="process-attached-badge">attached — click to detach</span>
                            )}
                          </button>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

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
          <>
            <p className="rail-note rail-note-live">
              Recording to <code className="tag-mono">{baseName(recordingPath)}</code>. Events are appended as they
              arrive, so the file is usable even if this machine is lost.
            </p>
            <RevealFileButton path={recordingPath} />
          </>
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
          <>
            <p className="rail-note rail-note-live">
              Capturing to <code className="tag-mono">{baseName(capturePath)}</code>. Call sites are resolved when you detach.
            </p>
            {captureOnThisMachine ? (
              <RevealFileButton path={capturePath} />
            ) : (
              <p className="rail-note">
                The file is written inside {captureContainer ?? 'its container'} and copied to this machine when the
                session ends.
              </p>
            )}
          </>
        ) : capturePath && captureCopyError ? (
          <>
            <p className="rail-note rail-note-warn">
              The last capture could not be copied out of {captureContainer ?? 'its container'}. The path below is
              inside that container, not a file on this machine.
            </p>
            <p className="rail-note rail-note-detail">
              <code className="tag-mono">{capturePath}</code> — {captureCopyError}
            </p>
          </>
        ) : capturePath && !captureOnThisMachine ? (
          <>
            <p className="rail-note rail-note-live">
              The capture is still being copied out of {captureContainer ?? 'its container'}. Until it lands, the path
              below is inside that container, not a file on this machine.
            </p>
            <p className="rail-note rail-note-detail">
              <code className="tag-mono">{capturePath}</code>
            </p>
          </>
        ) : capturePath ? (
          <>
            <p className="rail-note">
              The last capture was written to this file. Its call sites are now in the Call Sites view.
            </p>
            <div className="capture-path">
              <code className="tag-mono">{capturePath}</code>
              <RevealFileButton path={capturePath} />
            </div>
          </>
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
            {attachedContainer ? ` · ${attachedContainer}` : ''}
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
