import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PlaybackBar } from './components/PlaybackBar';
import { ProcessPicker } from './components/ProcessPicker';
import { Spine } from './components/Spine';
import { diagnose } from './lib/analysis';
import { formatBytes, formatDuration } from './lib/format';
import { api, isBackendAvailable, MOCK_ENABLED, onLog, onMessages, onPlayback, onStatus } from './lib/ipc';
import { severityColor } from './lib/palette';
import { MetricsStore } from './lib/store';
import type {
  Capabilities,
  CollectorLocation,
  DotnetProcessInfo,
  PlaybackStatusEvent,
  RecordingSummary,
  Settings,
  SessionState,
} from './lib/types';
import { useMetrics } from './lib/useMetrics';
import { resolvePanels, resolvePanelsForRecording, type PanelContext } from './panels/registry';

const EMPTY_SETTINGS: Settings = {
  collectorPath: null,
  defaultProbes: [],
  intervalMs: 1000,
  maxAllocationTypes: 150,
  historySeconds: 300,
  showAllCounters: false,
  verboseCollector: false,
  lastSession: null,
};

const COLLECTOR_PLACEHOLDER: CollectorLocation = {
  found: false,
  source: 'missing',
  searched: [],
};

const STATE_LABEL: Record<SessionState | 'idle', string> = {
  idle: 'Idle',
  starting: 'Attaching',
  running: 'Live',
  stopping: 'Detaching',
  stopped: 'Stopped',
  failed: 'Failed',
};

const REPLAY_LABEL: Record<PlaybackStatusEvent['state'], string> = {
  loading: 'Opening recording',
  playing: 'Replaying',
  paused: 'Replay paused',
  stopped: 'Replay stopped',
  finished: 'Replay finished',
  failed: 'Replay failed',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The application shell: target selection, view switching, and session lifecycle. */
export function App() {
  const storeRef = useRef<MetricsStore | null>(null);
  if (storeRef.current === null) storeRef.current = new MetricsStore();
  const store = useMetrics(storeRef.current);

  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [collector, setCollector] = useState<CollectorLocation>(COLLECTOR_PLACEHOLDER);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [processes, setProcesses] = useState<DotnetProcessInfo[]>([]);
  const [loadingProcesses, setLoadingProcesses] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [attachedPid, setAttachedPid] = useState<number | null>(null);
  const [selectedProbes, setSelectedProbes] = useState<string[]>([]);
  const [activePanel, setActivePanel] = useState('overview');
  const [error, setError] = useState<string | null>(null);

  const [playback, setPlayback] = useState<PlaybackStatusEvent | null>(null);
  const [replayRecording, setReplayRecording] = useState<RecordingSummary | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [recording, setRecording] = useState<RecordingSummary | null>(null);
  const [recordEnabled, setRecordEnabled] = useState(false);
  const [deepCaptureEnabled, setDeepCaptureEnabled] = useState(false);
  const [recordingsDir, setRecordingsDir] = useState('');
  const [recordingsToken, setRecordingsToken] = useState(0);

  // The latest playback status, kept outside React state so the event handler can compare
  // runs synchronously: two statuses can arrive in one batch, and reading `playback` from a
  // stale closure would miss the second one's generation change.
  const playbackRef = useRef<PlaybackStatusEvent | null>(null);

  const sessionState: SessionState | 'idle' = store.session.state;
  const replayActive = playback !== null && playback.state !== 'finished' && playback.state !== 'stopped' && playback.state !== 'failed';
  const attachedProcess = processes.find((process_) => process_.pid === attachedPid) ?? null;

  // ---- Startup ------------------------------------------------------------------------

  useEffect(() => {
    if (!isBackendAvailable()) {
      setError(
        'The MemorySpy backend is not reachable from a plain browser tab. Run `npm run app:dev` to open the desktop app.',
      );
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const environment = await api.getEnvironment();
        if (cancelled) return;

        setCollector(environment.collector);
        setSettings(environment.settings);
        setRecordingsDir(environment.recordingsDir);
        store.setHistorySeconds(environment.settings.historySeconds, environment.settings.intervalMs);

        const probes = await api.getCapabilities().catch(() => null);
        if (cancelled) return;

        setCapabilities(probes);
        setSelectedProbes(
          environment.settings.defaultProbes.length > 0
            ? environment.settings.defaultProbes
            : (probes?.probes.map((probe) => probe.id) ?? []),
        );

        await refreshProcesses(probes !== null);
      } catch (startupError) {
        if (!cancelled) setError(messageOf(startupError));
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally run once: the store is a stable ref and this is the bootstrap path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshProcesses = useCallback(async (quiet = false) => {
    if (!quiet) setLoadingProcesses(true);
    try {
      const list = await api.listProcesses(false);
      setProcesses(list);
      setError(null);
    } catch (listError) {
      setError(messageOf(listError));
    } finally {
      setLoadingProcesses(false);
    }
  }, []);

  // Keep the process list fresh while nothing is attached, so a restarted service reappears
  // without the user having to press Rescan.
  useEffect(() => {
    if (sessionState === 'running' || sessionState === 'starting') return;
    const timer = setInterval(() => void refreshProcesses(true), 5000);
    return () => clearInterval(timer);
  }, [sessionState, refreshProcesses]);

  // Persist the detail so a support request or a bug report carries the mode with it.
  useEffect(() => {
    if (!MOCK_ENABLED) return;
    store.addHostLog('warn', 'Running against the built-in mock backend; no real process is being inspected.');
  }, [store]);

  // ---- Event subscriptions ------------------------------------------------------------

  useEffect(() => {
    if (!isBackendAvailable()) return;

    const unlisteners: (() => void)[] = [];
    let disposed = false;

    const register = async () => {
      const unlistenMessages = await onMessages((batch) => {
        store.ingest(batch.messages);
      });
      const unlistenLog = await onLog((entry) => {
        store.addHostLog(entry.level, entry.message);
      });
      const unlistenStatus = await onStatus((status) => {
        store.setSession({
          sessionId: status.sessionId,
          pid: status.pid,
          state: status.state,
          detail: status.detail ?? null,
          stats: status.stats,
        });
        if (status.state === 'stopped' || status.state === 'failed') {
          setAttachedPid(null);
          // The session's stdout pump writes the recording footer before it reports the
          // terminal status, so by now the file is complete and worth re-reading.
          setRecording(null);
          setRecordingsToken((token) => token + 1);
        }
      });
      const unlistenPlayback = await onPlayback((status) => {
        const previous = playbackRef.current;

        // A new run, or a seek inside the current one: either way the buffers on screen
        // describe a timeline that no longer exists, and appending to them would draw a
        // chart of two unrelated series spliced together.
        if (!previous || previous.playbackId !== status.playbackId || previous.generation !== status.generation) {
          store.clearData();
          store.setSession({
            sessionId: status.playbackId,
            pid: status.recording.targetPid ?? null,
            detail: `Replaying ${status.recording.fileName}`,
          });
        }

        playbackRef.current = status;
        setPlayback(status);
        setReplayRecording(status.recording);
        if (status.error) setPlaybackError(status.error);
      });

      if (disposed) {
        unlistenMessages();
        unlistenLog();
        unlistenStatus();
        unlistenPlayback();
        return;
      }

      unlisteners.push(unlistenMessages, unlistenLog, unlistenStatus, unlistenPlayback);
    };

    void register();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [store]);

  // ---- Session control ----------------------------------------------------------------

  const attach = useCallback(
    async (process_: DotnetProcessInfo) => {
      setError(null);
      store.reset();
      store.setHistorySeconds(settings.historySeconds, settings.intervalMs);

      const wantsRecording = recordEnabled;
      const wantsCapture = deepCaptureEnabled;
      store.addHostLog(
        'info',
        `Attaching to ${process_.name} (pid ${process_.pid})…${wantsRecording ? ' Recording to disk.' : ''}${
          wantsCapture ? ' Deep capture armed for allocation call sites.' : ''
        }`,
      );

      // A deep capture is produced by the probe that consumes it, so arming the capture has to
      // pull that probe in. An empty selection already means "every probe".
      const probes = wantsCapture && selectedProbes.length > 0 && !selectedProbes.includes('allocation-sites')
        ? [...selectedProbes, 'allocation-sites']
        : selectedProbes;

      try {
        const session = await api.startSession({
          pid: process_.pid,
          probes,
          deepCapture: wantsCapture,
          intervalMs: settings.intervalMs,
          maxTypes: settings.maxAllocationTypes,
          verbose: settings.verboseCollector,
          record: wantsRecording,
          targetName: process_.name,
          targetRuntime: process_.runtimeVersion ?? null,
        });
        setSessionId(session.sessionId);
        setAttachedPid(process_.pid);
        setRecording(session.recording ?? null);
        store.setSession({ sessionId: session.sessionId, pid: process_.pid, state: 'running', detail: null });

        if (session.recording) {
          store.addHostLog('info', `Recording to ${session.recording.path}.`);
          setRecordingsToken((token) => token + 1);
        }
      } catch (attachError) {
        const message = messageOf(attachError);
        setError(message);
        store.addHostLog('error', message);
      }
    },
    [deepCaptureEnabled, recordEnabled, selectedProbes, settings, store],
  );

  const detach = useCallback(async () => {
    if (!sessionId) return;

    try {
      await api.stopSession(sessionId);
    } catch (detachError) {
      setError(messageOf(detachError));
    } finally {
      setAttachedPid(null);
      setSessionId(null);
    }
  }, [sessionId]);

  /**
   * Turns recording on or off for the session in front of the user.
   *
   * `start_recording` exists for the case that matters most in practice: the leak is already
   * visible and the user decides *now* that they want the evidence. So the toggle acts on a
   * live session rather than only arming the next attach.
   */
  const toggleRecord = useCallback(
    async (enabled: boolean) => {
      setRecordEnabled(enabled);
      if (!sessionId) return;

      try {
        if (enabled) {
          const started = await api.startRecording(
            sessionId,
            null,
            attachedProcess?.name ?? null,
            attachedProcess?.runtimeVersion ?? null,
          );
          setRecording(started);
          setRecordingsToken((token) => token + 1);
          store.addHostLog('info', `Recording to ${started.path}.`);
        } else {
          const stopped = await api.stopRecording(sessionId);
          setRecording(null);
          setRecordingsToken((token) => token + 1);
          if (stopped) {
            store.addHostLog(
              'info',
              `Recording finished: ${stopped.messageCount.toLocaleString()} messages, ${formatBytes(stopped.sizeBytes)}.`,
            );
          }
        }
      } catch (recordError) {
        const message = messageOf(recordError);
        setError(message);
        store.addHostLog('error', message);
      }
    },
    [attachedProcess, sessionId, store],
  );

  const resetCounters = useCallback(async () => {
    if (sessionId && !playback) {
      await api.sendSessionCommand(sessionId, { cmd: 'reset' }).catch(() => undefined);
    }
    store.reset();
    store.addHostLog('info', 'Counters and history cleared.');
  }, [sessionId, playback, store]);

  // ---- Replay -------------------------------------------------------------------------

  /**
   * Opens a recording, optionally advancing it to a position straight away.
   *
   * The `seekToMs` path exists because a replay that has ended cannot be scrubbed or resumed:
   * its thread has exited. Seeking from that state means a fresh run advanced to the position
   * the user asked for, which is also what makes the scrubber work on a finished replay.
   */
  const startReplay = useCallback(
    async (path: string, seekToMs?: number) => {
      setPlaybackError(null);
      try {
        const status = await api.startPlayback(path, 1);
        playbackRef.current = status;
        setPlayback(status);
        setReplayRecording(status.recording);
        store.clearData();
        store.setSession({
          sessionId: status.playbackId,
          pid: status.recording.targetPid ?? null,
          detail: `Replaying ${status.recording.fileName}`,
        });
        store.addHostLog(
          'info',
          `Replaying ${status.recording.fileName} (${status.recording.messageCount.toLocaleString()} recorded messages).`,
        );

        if (seekToMs && seekToMs > 0) {
          await api.seekPlayback(status.playbackId, seekToMs).catch(() => undefined);
        }
      } catch (replayError) {
        const message = messageOf(replayError);
        setPlaybackError(message);
        store.addHostLog('error', message);
      }
    },
    [store],
  );

  /** True once a replay's thread has exited, so it can only be continued by restarting it. */
  const playbackEnded =
    playback !== null &&
    (playback.state === 'finished' || playback.state === 'stopped' || playback.state === 'failed');

  const withPlayback = useCallback(
    async (command: (playbackId: string) => Promise<void>) => {
      if (!playback) return;
      try {
        await command(playback.playbackId);
      } catch (commandError) {
        setPlaybackError(messageOf(commandError));
      }
    },
    [playback],
  );

  const closeReplay = useCallback(async () => {
    if (playback) await api.stopPlayback(playback.playbackId).catch(() => undefined);
    playbackRef.current = null;
    setPlayback(null);
    setReplayRecording(null);
    setPlaybackError(null);
    store.reset();
    store.addHostLog('info', 'Replay closed.');
  }, [playback, store]);

  const saveSettings = useCallback(
    async (next: Settings) => {
      const saved = await api.saveSettings(next);
      setSettings(saved);
      store.setHistorySeconds(saved.historySeconds, saved.intervalMs);
      store.addHostLog('info', 'Settings saved.');
    },
    [store],
  );

  const refreshCollector = useCallback(async () => {
    const location = await api.refreshCollector();
    setCollector(location);
    const probes = await api.getCapabilities().catch(() => null);
    setCapabilities(probes);
    if (probes && selectedProbes.length === 0) {
      setSelectedProbes(probes.probes.map((probe) => probe.id));
    }
  }, [selectedProbes.length]);

  // ---- Derived ------------------------------------------------------------------------

  const diagnosis = useMemo(() => diagnose(store), [store]);
  const panels = useMemo(
    () =>
      replayRecording
        ? resolvePanelsForRecording(replayRecording.messageTypes)
        : resolvePanels(capabilities, selectedProbes),
    [capabilities, replayRecording, selectedProbes],
  );
  const activeDefinition = panels.find((panel) => panel.definition.id === activePanel) ?? panels[0];

  // If the active view is not available for the connected collector, fall back to one that is.
  useEffect(() => {
    if (!activeDefinition?.available) {
      const fallback = panels.find((panel) => panel.available);
      if (fallback) setActivePanel(fallback.definition.id);
    }
  }, [activeDefinition, panels]);

  const panelContext: PanelContext = {
    store,
    sessionId,
    settings,
    collector,
    capabilities,
    recordingsDir,
    activeRecordingPath: playback?.recording.path ?? null,
    recordingPath: recording?.path ?? null,
    recordingsToken,
    onReplayRecording: (path) => void startReplay(path),
    onOpenTarget: (target) => {
      if (target) setActivePanel(target);
    },
    onResetCounters: () => void resetCounters(),
    onSaveSettings: saveSettings,
    onRefreshCollector: refreshCollector,
  };

  const uptime = store.session.stats ? formatDuration(store.session.stats.uptimeMs) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">MemorySpy</span>
          <span className="brand-tagline">.NET memory, in real time</span>
        </div>

        <div className="topbar-status">
          {playback ? (
            <>
              <span className={`state-pill state-replay${playback.state === 'paused' ? ' is-paused' : ''}`}>
                <span className="state-dot" />
                {REPLAY_LABEL[playback.state]}
              </span>
              {replayRecording?.targetName && (
                <span className="topbar-meta">{replayRecording.targetName}</span>
              )}
              {playback.recording.targetPid != null && (
                <span className="topbar-meta">pid {playback.recording.targetPid}</span>
              )}
              <span className="topbar-meta">from {playback.recording.fileName}</span>
            </>
          ) : (
            <>
              <span className={`state-pill state-${sessionState}`}>
                <span className="state-dot" />
                {STATE_LABEL[sessionState]}
              </span>
              {store.session.pid && <span className="topbar-meta">pid {store.session.pid}</span>}
              {uptime && <span className="topbar-meta">{uptime}</span>}
              {store.session.stats && (
                <span className="topbar-meta">{store.session.stats.messages.toLocaleString()} msgs</span>
              )}
            </>
          )}
          {diagnosis.overall !== 'good' && (
            <span
              className="state-pill"
              style={{ borderColor: severityColor(diagnosis.overall), color: severityColor(diagnosis.overall) }}
            >
              {diagnosis.overall === 'critical' ? 'memory problem detected' : 'check diagnosis'}
            </span>
          )}
        </div>
      </header>

      {playback && (
        <PlaybackBar
          playback={playback}
          error={playbackError}
          onPause={() => void withPlayback((id) => api.pausePlayback(id))}
          onResume={() =>
            void (playbackEnded
              ? startReplay(playback.recording.path, playback.positionMs)
              : withPlayback((id) => api.resumePlayback(id)))
          }
          onSpeedChange={(speed) => void withPlayback((id) => api.setPlaybackSpeed(id, speed))}
          onSeek={(positionMs) =>
            void (playbackEnded
              ? startReplay(playback.recording.path, positionMs)
              : withPlayback((id) => api.seekPlayback(id, positionMs)))
          }
          onStop={() => void withPlayback((id) => api.stopPlayback(id))}
          onRestart={() => void startReplay(playback.recording.path)}
          onClose={() => void closeReplay()}
        />
      )}

      {!collector.found && !playback && (
        <div className="banner banner-critical">
          <strong>Collector not found.</strong>
          <span>{collector.error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActivePanel('settings')}>
            Open settings
          </button>
        </div>
      )}

      {error && (
        <div className="banner banner-warning">
          <strong>Something went wrong.</strong>
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="body">
        <ProcessPicker
          processes={processes}
          loading={loadingProcesses}
          attachedPid={attachedPid}
          sessionState={sessionState}
          probeIds={capabilities?.probes.map((probe) => probe.id) ?? []}
          selectedProbes={selectedProbes}
          intervalMs={settings.intervalMs}
          maxTypes={settings.maxAllocationTypes}
          error={null}
          recordingPath={recording?.path ?? null}
          recordEnabled={recordEnabled}
          deepCaptureSupported={capabilities?.supports?.includes('allocation-call-sites') ?? false}
          deepCaptureEnabled={deepCaptureEnabled}
          capturePath={store.capturePath}
          replayActive={replayActive}
          onRefresh={() => void refreshProcesses()}
          onAttach={(process_) => void attach(process_)}
          onDetach={() => void detach()}
          onToggleRecord={(enabled) => void toggleRecord(enabled)}
          onToggleDeepCapture={setDeepCaptureEnabled}
          onToggleProbe={(probeId) =>
            setSelectedProbes((current) =>
              current.includes(probeId) ? current.filter((id) => id !== probeId) : [...current, probeId],
            )
          }
          onIntervalChange={(intervalMs) => {
            const next = { ...settings, intervalMs };
            setSettings(next);
            void saveSettings(next);
          }}
          onMaxTypesChange={(maxAllocationTypes) => {
            const next = { ...settings, maxAllocationTypes };
            setSettings(next);
            void saveSettings(next);
          }}
        />

        <main className="main">
          <nav className="tabs" role="tablist">
            {panels.map(({ definition, available, missing }) => (
              <button
                type="button"
                key={definition.id}
                role="tab"
                aria-selected={definition.id === activePanel}
                className={`tab${definition.id === activePanel ? ' is-active' : ''}${available ? '' : ' is-unavailable'}`}
                onClick={() => available && setActivePanel(definition.id)}
                disabled={!available}
                title={available ? definition.hint : `Needs the ${missing.join(', ')} probe`}
              >
                {definition.label}
              </button>
            ))}
            <span className="tabs-spacer" />
            <span className="tabs-meta">{activeDefinition?.definition.hint}</span>
          </nav>

          <div className="main-scroll">
            {activeDefinition && !activeDefinition.available ? (
              <div className="notice notice-warning">
                <strong>{activeDefinition.definition.label} is not available.</strong>
                <span>
                  {replayRecording
                    ? `This recording contains no ${activeDefinition.missing.join(', ')} data.`
                    : `This view needs the ${activeDefinition.missing.join(', ')} probe, which is not enabled for the current session. Enable it in the Collectors list on the left and attach again.`}
                </span>
              </div>
            ) : (
              activeDefinition && <activeDefinition.definition.component {...panelContext} />
            )}
          </div>
        </main>

        <Spine
          heap={store.latestHeap()}
          growthPerMinute={diagnosis.gcHeap?.ratePerMinute ?? null}
          confidence={diagnosis.gcHeap?.r2 ?? 0}
          history={store.heapHistory}
        />
      </div>
    </div>
  );
}
