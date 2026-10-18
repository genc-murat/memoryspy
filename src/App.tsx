import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PlaybackBar } from './components/PlaybackBar';
import { ProcessPicker } from './components/ProcessPicker';
import { Spine } from './components/Spine';
import { diagnose } from './lib/analysis';
import { formatBytes, formatDuration } from './lib/format';
import { api, isBackendAvailable, MOCK_ENABLED, onLog, onMessages, onPlayback, onStatus } from './lib/ipc';
import { severityColor } from './lib/palette';
import { loadRailState, patchRailState, type LastTarget } from './lib/railState';
import { MetricsStore } from './lib/store';
import { loadViewState, patchViewState, type ViewState } from './lib/viewState';
import type {
  Capabilities,
  CollectorLocation,
  DockerContainer,
  DockerStatus,
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

/**
 * How often the open container lists are re-read while the rail is idle.
 *
 * Slower than the host process list's 5 s on purpose: each tick shells out to the Docker CLI
 * (inspecting the image and probing the staged collector before it can list), which is far more
 * expensive than reading the local process list. Ten seconds is still well inside "the service I
 * just restarted is back" for someone watching the rail.
 */
const CONTAINER_REFRESH_MS = 10_000;

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
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [containerProcesses, setContainerProcesses] = useState<Record<string, DotnetProcessInfo[]>>({});
  /**
   * Containers whose process list is open in the rail.
   *
   * Kept apart from the list itself so the list can be refreshed without closing it — the
   * expanded set is what survives a session ending or a rescan.
   */
  const [expandedContainers, setExpandedContainers] = useState<string[]>(
    () => loadRailState().expandedContainers,
  );
  /** The target the last session was attached to, restored across restarts as a marker. */
  const [lastTarget, setLastTarget] = useState<LastTarget | null>(() => loadRailState().lastTarget);
  /** A resume is checking whether the remembered target still exists. */
  const [resuming, setResuming] = useState(false);
  /** Why the remembered target cannot be resumed, shown next to the button. */
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  /** Containers currently being staged/listed; several can be in flight during a refresh. */
  const [containerBusy, setContainerBusy] = useState<string[]>([]);
  const [containerError, setContainerError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [attachedPid, setAttachedPid] = useState<number | null>(null);
  /** The container the attached target runs in; `null` for a process on this machine. */
  const [attachedContainer, setAttachedContainer] = useState<string | null>(null);
  const [selectedProbes, setSelectedProbes] = useState<string[]>([]);

  /**
   * The tab and per-tab scroll offsets this window had when it was last closed.
   *
   * Read once per page load, not on every render: the stored value is only the starting point,
   * and the live refs below are the truth from then on.
   */
  const restoredViewRef = useRef<ViewState | null>(null);
  if (restoredViewRef.current === null) restoredViewRef.current = loadViewState();
  const restoredView = restoredViewRef.current;

  const [activePanel, setActivePanel] = useState(restoredView.panel);
  /** The element every tab renders into; its scroll offset is the one that is remembered. */
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  /** Latest offset per tab, updated on every scroll so a tab switch can put it back. */
  const scrollTopsRef = useRef<Record<string, number>>(restoredView.scrollTops);
  const activePanelRef = useRef(activePanel);
  /** True while an offset is being re-applied, so that clamped intermediate values are not saved. */
  const restoringScrollRef = useRef(false);
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

  // The event subscriptions are registered once, so a terminal session status has to read the
  // expanded set from a ref rather than from the render that installed the handler.
  // Seeded from the restored layout, so the startup pass can read it before any toggle happens.
  const expandedContainersRef = useRef<string[]>(expandedContainers);
  useEffect(() => {
    expandedContainersRef.current = expandedContainers;
  }, [expandedContainers]);

  // The busy set has the same problem as the expanded set: a tick and a click in the same frame
  // must see each other's decision, so the guard reads a ref rather than the last render.
  const containerBusyRef = useRef<string[]>([]);

  const sessionState: SessionState | 'idle' = store.session.state;
  const replayActive = playback !== null && playback.state !== 'finished' && playback.state !== 'stopped' && playback.state !== 'failed';

  // A pid is only meaningful together with its container, so the attached row is looked up in the
  // right list rather than in whichever list happens to share the number.
  const attachedProcess = useMemo(() => {
    if (attachedPid == null) return null;
    if (attachedContainer) {
      // A pid is only unique inside its container. Looking the pid up across every expanded
      // container would show whichever one came first — usually the wrong one, since a service
      // normally runs as pid 1.
      return (
        containerProcesses[attachedContainer]?.find((process_) => process_.pid === attachedPid) ??
        null
      );
    }
    return processes.find((process_) => process_.pid === attachedPid) ?? null;
  }, [attachedContainer, attachedPid, containerProcesses, processes]);

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
        const containerNames = await refreshContainers();

        // Containers that were open last time are restored, and their process lists are read now:
        // an expanded row with nothing under it would look like a listing that failed. Only the
        // ones that still exist are asked about — with Docker down there is nothing to list.
        await refreshContainerProcesses(
          expandedContainersRef.current.filter((name) => containerNames.includes(name)),
        );
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

  /**
   * Reads whether containers can be inspected at all, then lists the running ones.
   *
   * Deliberately not part of the five-second process refresh: this spawns the Docker CLI, and
   * the result only changes when the user starts or stops a container. Returns the names that
   * exist now, so a caller refreshing their process lists does not ask about one that is gone.
   */
  const refreshContainers = useCallback(async (): Promise<string[]> => {
    try {
      const status = await api.dockerStatus();
      setDocker(status);
      if (!status.available) {
        setContainers([]);
        setContainerProcesses({});
        // The saved layout is deliberately kept: Docker being down when the app starts (Docker
        // Desktop still booting) must not erase which containers were open. The next successful
        // listing prunes the names that are really gone.
        return [];
      }

      const list = await api.listDockerContainers();
      setContainers(list);
      const names = list.map((container) => container.name);

      // A container stopped while the rail was open must not stay expanded, and its cached
      // process list would describe a target that no longer exists. The pruned layout is what
      // the next launch restores, so it is written back rather than only held in state.
      const kept = expandedContainersRef.current.filter((name) => names.includes(name));
      expandedContainersRef.current = kept;
      setExpandedContainers(kept);
      patchRailState({ expandedContainers: kept });
      setContainerProcesses((current) => {
        const next: Record<string, DotnetProcessInfo[]> = {};
        for (const [name, processes] of Object.entries(current)) {
          if (names.includes(name)) next[name] = processes;
        }
        return next;
      });

      setContainerError(null);
      return names;
    } catch (dockerError) {
      setContainerError(messageOf(dockerError));
      return [];
    }
  }, []);

  /**
   * Lists one container's attachable processes, leaving whether it is expanded alone.
   *
   * The first listing stages the Linux collector into the container (an 80 MB copy, once), which
   * is why the row shows a busy state instead of doing this silently in the background.
   */
  const listContainerProcesses = useCallback(
    async (container: string, quiet = false): Promise<DotnetProcessInfo[] | null> => {
      // A listing already in flight for this container wins: a periodic tick must not stack on
      // top of it, and a double click must not become two `docker exec` calls.
      if (containerBusyRef.current.includes(container)) return null;

      containerBusyRef.current = [...containerBusyRef.current, container];
      setContainerBusy(containerBusyRef.current);

      try {
        const list = await api.listContainerProcesses(container);
        setContainerProcesses((current) => ({ ...current, [container]: list }));
        return list;
      } catch (inspectError) {
        // A background refresh is silent on purpose: the next tick retries, and a transient
        // failure must not put an error in the rail that nobody asked for.
        if (!quiet) {
          const message = messageOf(inspectError);
          setContainerError(message);
          store.addHostLog('error', message);
        }
        return null;
      } finally {
        containerBusyRef.current = containerBusyRef.current.filter((name) => name !== container);
        setContainerBusy(containerBusyRef.current);
      }
    },
    [store],
  );

  /**
   * Re-lists the process lists that are on screen.
   *
   * Parallel on purpose: waiting for one slow container before starting the next makes a refresh
   * look stuck, and each row reports its own busy state anyway.
   */
  const refreshContainerProcesses = useCallback(
    async (names: string[], quiet = false) => {
      await Promise.all(names.map((name) => listContainerProcesses(name, quiet)));
    },
    [listContainerProcesses],
  );

  /** Expands a container (listing its processes) or collapses it again. */
  const toggleContainer = useCallback(
    (container: string) => {
      // The ref is updated eagerly so two clicks in one frame cannot both decide "expand": the
      // second one sees the state the first one just wrote.
      const expanded = expandedContainersRef.current.includes(container);
      const next = expanded
        ? expandedContainersRef.current.filter((name) => name !== container)
        : [...expandedContainersRef.current, container];

      expandedContainersRef.current = next;
      setExpandedContainers(next);
      patchRailState({ expandedContainers: next });

      if (!expanded) {
        setContainerError(null);
        void listContainerProcesses(container);
      }
    },
    [listContainerProcesses],
  );

  /** Refreshes the container list and the processes of every container still open. */
  const refreshDocker = useCallback(async () => {
    const names = await refreshContainers();
    await refreshContainerProcesses(
      expandedContainersRef.current.filter((name) => names.includes(name)),
    );
  }, [refreshContainers, refreshContainerProcesses]);

  /** The rail's Rescan: local processes and containers, both brought up to date. */
  const refreshAll = useCallback(async () => {
    await refreshProcesses();
    await refreshDocker();
  }, [refreshProcesses, refreshDocker]);

  // Keep the process list fresh while nothing is attached, so a restarted service reappears
  // without the user having to press Rescan.
  useEffect(() => {
    if (sessionState === 'running' || sessionState === 'starting') return;
    const timer = setInterval(() => void refreshProcesses(true), 5000);
    return () => clearInterval(timer);
  }, [sessionState, refreshProcesses]);

  // The same for the containers that are open, so a service restarted *inside* one shows its new
  // pid without a manual Refresh. Off while attached, and off when no Linux collector has been
  // published: in that case every tick could only repeat an error the user has to fix once.
  useEffect(() => {
    if (sessionState === 'running' || sessionState === 'starting') return;
    if (expandedContainers.length === 0) return;
    if (!docker?.available || docker.stagedRids.length === 0) return;

    const timer = setInterval(() => {
      void refreshContainerProcesses(expandedContainersRef.current, true);
    }, CONTAINER_REFRESH_MS);

    return () => clearInterval(timer);
  }, [
    docker?.available,
    docker?.stagedRids.length,
    expandedContainers.length,
    sessionState,
    refreshContainerProcesses,
  ]);

  // Persist the detail so a support request or a bug report carries the mode with it.
  useEffect(() => {
    if (!MOCK_ENABLED) return;
    store.addHostLog('warn', 'Running against the built-in mock backend; no real process is being inspected.');
  }, [store]);

  // ---- View state ---------------------------------------------------------------------

  // The panel is written as soon as it changes; the offsets are written by the scroll handler
  // below. Together they are what the next launch opens with.
  useEffect(() => {
    activePanelRef.current = activePanel;
    patchViewState({ panel: activePanel });
  }, [activePanel]);

  // The scroll container is one element shared by every tab, so its position is remembered per
  // tab rather than globally: switching from a long table to a short view must not open the
  // short view halfway down another tab's content.
  useEffect(() => {
    const element = mainScrollRef.current;
    if (!element) return;

    // Trailing write rather than one per frame: localStorage is synchronous, and a fast scroll
    // would otherwise block the main thread dozens of times a second.
    let timer = 0;
    const flush = () => {
      timer = 0;
      patchViewState({ panel: activePanelRef.current, scrollTops: scrollTopsRef.current });
    };

    const remember = () => {
      // While an offset is being restored, the browser clamps it until the panel is tall enough.
      // Saving that intermediate value would replace the position still being restored.
      if (restoringScrollRef.current) return;
      scrollTopsRef.current[activePanelRef.current] = element.scrollTop;
      if (timer === 0) timer = window.setTimeout(flush, 200);
    };

    // A webview can be closed before the trailing write fires. Write the last position
    // synchronously when the window is being hidden instead of trusting the pending timer.
    const flushNow = () => {
      if (timer !== 0) {
        clearTimeout(timer);
        timer = 0;
      }
      if (restoringScrollRef.current) return;
      scrollTopsRef.current[activePanelRef.current] = element.scrollTop;
      patchViewState({ panel: activePanelRef.current, scrollTops: scrollTopsRef.current });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushNow();
    };

    element.addEventListener('scroll', remember, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flushNow);

    return () => {
      element.removeEventListener('scroll', remember);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushNow);
      if (timer !== 0) clearTimeout(timer);
    };
  }, []);

  // Re-applies the remembered offset whenever the open tab changes, including the first paint.
  //
  // A panel's content arrives after that paint — counters, tables and findings are rendered from
  // data that streams in — so the container can still be too short and the browser clamps the
  // offset. The position is therefore re-applied while the panel grows, for a bounded time. The
  // user's own scroll wins: as soon as they touch the view the remembered position is dropped,
  // because fighting a scroll the user just made is worse than losing the old one.
  useEffect(() => {
    const element = mainScrollRef.current;
    if (!element) return;

    const target = scrollTopsRef.current[activePanel] ?? 0;
    const startedAt = performance.now();
    let frame = 0;
    let stopped = false;

    const stop = () => {
      stopped = true;
      restoringScrollRef.current = false;
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    const onUserInput = () => stop();
    const inputEvents = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
    for (const type of inputEvents) element.addEventListener(type, onUserInput, { passive: true });

    if (target > 0) {
      restoringScrollRef.current = true;

      const apply = () => {
        if (stopped) return;
        element.scrollTop = target;
        const settled = Math.abs(element.scrollTop - target) <= 1;
        if (settled || performance.now() - startedAt > 4000) {
          stop();
          return;
        }
        frame = requestAnimationFrame(apply);
      };

      apply();
    } else {
      // A tab without a remembered offset opens at the top, not wherever the previous tab was.
      element.scrollTop = 0;
    }

    return () => {
      stop();
      for (const type of inputEvents) element.removeEventListener(type, onUserInput);
    };
  }, [activePanel]);

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
          setAttachedContainer(null);
          // The open container lists described the target of the session that just ended, so they
          // are re-listed now: a service that restarted shows its new pid without a manual Refresh.
          void refreshDocker();
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
  }, [store, refreshDocker]);

  // ---- Session control ----------------------------------------------------------------

  const attach = useCallback(
    async (process_: DotnetProcessInfo, container?: string): Promise<boolean> => {
      setError(null);
      setResumeNote(null);
      store.reset();
      store.setHistorySeconds(settings.historySeconds, settings.intervalMs);
      // Where a capture will be written is decided by the target, and only this call knows
      // whether that target lives in a container: such a capture stays a path inside it until
      // the host copies the file out, so the rail has to know before the first message arrives.
      store.setCaptureLocation(container ?? null);

      const wantsRecording = recordEnabled;
      const wantsCapture = deepCaptureEnabled;
      const where = container ? ` in container ${container}` : '';
      store.addHostLog(
        'info',
        `Attaching to ${process_.name} (pid ${process_.pid})${where}…${wantsRecording ? ' Recording to disk.' : ''}${
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
          container: container ?? null,
          probes,
          deepCapture: wantsCapture,
          intervalMs: settings.intervalMs,
          maxTypes: settings.maxAllocationTypes,
          verbose: settings.verboseCollector,
          record: wantsRecording,
          // The container is part of the target's identity: a recording of `dotnet` from two
          // services would otherwise carry the same name.
          targetName: container ? `${process_.name} (${container})` : process_.name,
          targetRuntime: process_.runtimeVersion ?? null,
        });
        setSessionId(session.sessionId);
        setAttachedPid(process_.pid);
        setAttachedContainer(container ?? null);
        // Remembered as a marker, not as an instruction to attach again: the rail can point at
        // the target after a restart, but starting a session is still the user's decision.
        const remembered: LastTarget = {
          pid: process_.pid,
          name: process_.name,
          container: container ?? null,
          atUnixMs: Date.now(),
        };
        setLastTarget(remembered);
        patchRailState({ lastTarget: remembered });
        setRecording(session.recording ?? null);
        store.setSession({ sessionId: session.sessionId, pid: process_.pid, state: 'running', detail: null });

        if (session.recording) {
          store.addHostLog('info', `Recording to ${session.recording.path}.`);
          setRecordingsToken((token) => token + 1);
        }
        return true;
      } catch (attachError) {
        const message = messageOf(attachError);
        setError(message);
        store.addHostLog('error', message);
        return false;
      }
    },
    [deepCaptureEnabled, recordEnabled, selectedProbes, settings, store],
  );

  /**
   * Attaches to the target of the last session with one click, after checking it still exists.
   *
   * The check is a fresh listing rather than a lookup in the rail: a collapsed container has no
   * process list at all, and the host list on screen may be seconds old — which is exactly the
   * window in which a restarted service changes pid. A target is matched by pid *and* name,
   * because pid reuse would otherwise attach the collector to an unrelated process. When the
   * target is gone the rail says why instead of leaving a button that silently does nothing.
   */
  const resumeLastTarget = useCallback(async () => {
    if (!lastTarget || resuming) return;

    setResumeNote(null);
    setError(null);

    if (replayActive) {
      setResumeNote('A recording is open. Close the replay before resuming a live session.');
      return;
    }
    if (sessionState === 'running' || sessionState === 'starting') {
      setResumeNote('A session is already attached. Detach first.');
      return;
    }
    if (sessionState === 'stopping') {
      setResumeNote('The previous session is still detaching. Try again in a moment.');
      return;
    }

    const { pid, name, container } = lastTarget;
    setResuming(true);

    try {
      if (container) {
        const status = await api.dockerStatus();
        setDocker(status);
        if (!status.available) {
          setResumeNote(
            `Docker is not reachable, so ${container} cannot be checked. Start Docker and try again.`,
          );
          return;
        }

        const containersNow = await api.listDockerContainers();
        setContainers(containersNow);
        if (!containersNow.some((entry) => entry.name === container)) {
          setResumeNote(`Container ${container} is not running, so ${name} (pid ${pid}) is gone.`);
          return;
        }

        // A periodic refresh may already be listing this container. Saying so is better than
        // reporting a listing failure that never happened.
        if (containerBusyRef.current.includes(container)) {
          setResumeNote(`A listing for ${container} is already running. Try again in a moment.`);
          return;
        }

        // Listing also stages the collector when needed, so a resume after a restart behaves
        // exactly like expanding the container by hand.
        const list = await listContainerProcesses(container);
        if (list === null) {
          setResumeNote(`Could not list the processes in ${container}. See the error above.`);
          return;
        }

        const again = list.find((entry) => entry.pid === pid);
        if (!again) {
          setResumeNote(`pid ${pid} (${name}) is no longer running in ${container}.`);
          return;
        }
        if (again.name !== name) {
          setResumeNote(
            `pid ${pid} in ${container} now belongs to ${again.name}, not ${name}. Refusing to attach to a different process.`,
          );
          return;
        }

        // The attached row lives under the container, so open it: otherwise a resume would leave
        // the rail looking as though nothing had been selected.
        if (!expandedContainersRef.current.includes(container)) {
          const next = [...expandedContainersRef.current, container];
          expandedContainersRef.current = next;
          setExpandedContainers(next);
          patchRailState({ expandedContainers: next });
        }

        if (!(await attach(again, container))) {
          setResumeNote(`The collector could not attach to ${name} (pid ${pid}). See the banner for the reason.`);
        }
        return;
      }

      const list = await api.listProcesses(false);
      setProcesses(list);

      const again = list.find((entry) => entry.pid === pid);
      if (!again) {
        setResumeNote(`pid ${pid} (${name}) is no longer running. Start it again, then resume.`);
        return;
      }
      if (again.name !== name) {
        setResumeNote(
          `pid ${pid} now belongs to ${again.name}, not ${name}. Refusing to attach to a different process.`,
        );
        return;
      }

      if (!(await attach(again))) {
        setResumeNote(`The collector could not attach to ${name} (pid ${pid}). See the banner for the reason.`);
      }
    } catch (resumeError) {
      setResumeNote(messageOf(resumeError));
    } finally {
      setResuming(false);
    }
  }, [attach, lastTarget, listContainerProcesses, replayActive, resuming, sessionState]);

  const detach = useCallback(async () => {
    if (!sessionId) return;

    try {
      await api.stopSession(sessionId);
    } catch (detachError) {
      setError(messageOf(detachError));
    } finally {
      setAttachedPid(null);
      setAttachedContainer(null);
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

  /**
   * Asks the collector to walk the live heap.
   *
   * Nothing comes back from this call: a walk stops the target for one collection and takes
   * seconds to minutes, so the collector acknowledges the request and the snapshot itself arrives
   * later as a `heap.snapshot` message. Both the acknowledgement and the walk's own log lines land
   * in the diagnostics view, which is where a failure to start belongs.
   */
  const takeSnapshot = useCallback(async () => {
    if (!sessionId || playback) {
      store.addHostLog('warn', 'A heap snapshot needs a live target; replaying a recording has none.');
      return;
    }

    try {
      await api.sendSessionCommand(sessionId, { cmd: 'snapshot' });
    } catch (snapshotError) {
      const message = messageOf(snapshotError);
      setError(message);
      store.addHostLog('error', message);
    }
  }, [sessionId, playback, store]);

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

  // If the restored view no longer exists, or is not available for the connected collector, fall
  // back to one that is. The id check matters because `activeDefinition` already falls back to
  // the first panel, which would otherwise leave no tab marked as selected.
  useEffect(() => {
    const known = panels.some((panel) => panel.definition.id === activePanel);
    if (!known || !activeDefinition?.available) {
      const fallback = panels.find((panel) => panel.available);
      if (fallback) setActivePanel(fallback.definition.id);
    }
  }, [activeDefinition, activePanel, panels]);

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
    onTakeSnapshot: () => void takeSnapshot(),
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
          docker={docker}
          containers={containers}
          containerProcesses={containerProcesses}
          expandedContainers={expandedContainers}
          containerBusy={containerBusy}
          lastTarget={lastTarget}
          resuming={resuming}
          resumeNote={resumeNote}
          attachedContainer={attachedContainer}
          attachedProcess={attachedProcess}
          loading={loadingProcesses}
          attachedPid={attachedPid}
          sessionState={sessionState}
          probeIds={capabilities?.probes.map((probe) => probe.id) ?? []}
          selectedProbes={selectedProbes}
          intervalMs={settings.intervalMs}
          maxTypes={settings.maxAllocationTypes}
          error={containerError}
          recordingPath={recording?.path ?? null}
          recordEnabled={recordEnabled}
          deepCaptureSupported={capabilities?.supports?.includes('allocation-call-sites') ?? false}
          deepCaptureEnabled={deepCaptureEnabled}
          capturePath={store.capturePath}
          captureOnThisMachine={store.captureOnThisMachine}
          captureCopyError={store.captureCopyError}
          captureContainer={store.captureContainer}
          replayActive={replayActive}
          onRefresh={() => void refreshAll()}
          onRefreshContainers={() => void refreshDocker()}
          onToggleContainer={toggleContainer}
          onAttach={(process_, container) => void attach(process_, container)}
          onResume={() => void resumeLastTarget()}
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

          <div className="main-scroll" ref={mainScrollRef}>
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
