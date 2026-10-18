import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { MOCK_ENABLED, mockApi, startMockStream } from './mock';
import type {
  Capabilities,
  CollectorMessage,
  CollectorLocation,
  DockerContainer,
  DockerStatus,
  DotnetProcessInfo,
  EnvironmentInfo,
  PlaybackStatusEvent,
  RecordingSummary,
  SessionRequest,
  SessionSnapshot,
  SessionStatusEvent,
  Settings,
} from './types';

/**
 * Event names must match the constants in the Rust host: `collector.rs` for the live
 * channels, `recording.rs` for playback.
 */
export const EVENTS = {
  messages: 'memoryspy://messages',
  log: 'memoryspy://log',
  status: 'memoryspy://status',
  playback: 'memoryspy://playback',
} as const;

export { MOCK_ENABLED };

/**
 * True when the Tauri bridge is present. The app can also be opened in a plain browser
 * during UI work, where every invoke would throw a confusing error.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** True when *some* backend can serve requests: the real host or the dev mock. */
export function isBackendAvailable(): boolean {
  return isTauri() || MOCK_ENABLED;
}

const NOT_IN_TAURI =
  'The MemorySpy backend is not reachable. Open the app with `npm run app:dev` (or add ?mock=1 to a dev build to preview the UI with synthetic data).';

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(NOT_IN_TAURI);

  try {
    return await invoke<T>(command, args);
  } catch (error) {
    // Tauri rejects with the plain string the Rust command returned, which is already
    // written for a human to read.
    throw new Error(typeof error === 'string' ? error : String(error));
  }
}

const realApi = {
  getEnvironment: () => call<EnvironmentInfo>('get_environment'),
  refreshCollector: () => call<CollectorLocation>('refresh_collector'),
  listProcesses: (fast = false) => call<DotnetProcessInfo[]>('list_processes', { fast }),
  // Containerised targets. Discovery is a separate call because staging the Linux collector into
  // a container is real work and must not ride on the five-second process-list refresh.
  dockerStatus: () => call<DockerStatus>('get_docker_status'),
  listDockerContainers: () => call<DockerContainer[]>('list_docker_containers'),
  listContainerProcesses: (container: string) =>
    call<DotnetProcessInfo[]>('list_container_processes', { container }),
  getCapabilities: () => call<Capabilities>('get_capabilities'),
  startSession: (request: SessionRequest) => call<SessionSnapshot>('start_session', { request }),
  stopSession: (sessionId: string) => call<void>('stop_session', { sessionId }),
  stopAllSessions: () => call<void>('stop_all_sessions'),
  sendSessionCommand: (sessionId: string, command: Record<string, unknown>) =>
    call<void>('send_session_command', { sessionId, command }),
  listSessions: () => call<SessionSnapshot[]>('list_sessions'),
  pruneSessions: () => call<number>('prune_sessions'),
  getSettings: () => call<Settings>('get_settings'),
  saveSettings: (settings: Settings) => call<Settings>('save_settings', { settings }),

  // Recording the live session.
  startRecording: (sessionId: string, path: string | null, targetName: string | null, targetRuntime: string | null) =>
    call<RecordingSummary>('start_recording', { sessionId, path, targetName, targetRuntime }),
  stopRecording: (sessionId: string) => call<RecordingSummary | null>('stop_recording', { sessionId }),

  // Recordings on disk.
  listRecordings: () => call<RecordingSummary[]>('list_recordings'),
  deleteRecording: (path: string) => call<void>('delete_recording', { path }),
  // The webview cannot open a file manager, so a printed path is only reachable through the
  // host. Rejects with the host's wording when the file is no longer there.
  revealInFolder: (path: string) => call<void>('reveal_in_folder', { path }),

  // Replaying one offline.
  startPlayback: (path: string, speed?: number) =>
    call<PlaybackStatusEvent>('start_playback', { path, speed: speed ?? null }),
  pausePlayback: (playbackId: string) => call<void>('pause_playback', { playbackId }),
  resumePlayback: (playbackId: string) => call<void>('resume_playback', { playbackId }),
  setPlaybackSpeed: (playbackId: string, speed: number) =>
    call<void>('set_playback_speed', { playbackId, speed }),
  seekPlayback: (playbackId: string, positionMs: number) =>
    call<void>('seek_playback', { playbackId, positionMs }),
  stopPlayback: (playbackId: string) => call<void>('stop_playback', { playbackId }),
};

/** Every backend call the app makes, routed to the real host or the dev mock. */
export const api: typeof realApi = MOCK_ENABLED ? mockApi : realApi;

export interface MessageBatch {
  sessionId: string;
  messages: CollectorMessage[];
}

export interface LogEvent {
  sessionId: string;
  level: string;
  message: string;
}

type Handler<T> = (payload: T) => void;

/**
 * In mock mode all three event channels are fed by one simulated stream, started the first
 * time anything subscribes and torn down when the last listener leaves.
 */
const mockListeners: {
  messages: Set<Handler<MessageBatch>>;
  logs: Set<Handler<LogEvent>>;
  statuses: Set<Handler<SessionStatusEvent>>;
  playback: Set<Handler<PlaybackStatusEvent>>;
} = { messages: new Set(), logs: new Set(), statuses: new Set(), playback: new Set() };

let mockTeardown: (() => void) | null = null;

function ensureMockStream(): void {
  if (mockTeardown) return;

  mockTeardown = startMockStream(
    (batch) => mockListeners.messages.forEach((handler) => handler(batch)),
    (entry) => mockListeners.logs.forEach((handler) => handler(entry)),
    (status) => mockListeners.statuses.forEach((handler) => handler(status)),
    (status) => mockListeners.playback.forEach((handler) => handler(status)),
  );
}

function subscribe<T>(set: Set<Handler<T>>, handler: Handler<T>): UnlistenFn {
  set.add(handler);
  ensureMockStream();
  return () => set.delete(handler);
}

export function onMessages(handler: (batch: MessageBatch) => void): Promise<UnlistenFn> {
  if (MOCK_ENABLED) return Promise.resolve(subscribe(mockListeners.messages, handler));
  return listen<MessageBatch>(EVENTS.messages, (event) => handler(event.payload));
}

export function onLog(handler: (entry: LogEvent) => void): Promise<UnlistenFn> {
  if (MOCK_ENABLED) return Promise.resolve(subscribe(mockListeners.logs, handler));
  return listen<LogEvent>(EVENTS.log, (event) => handler(event.payload));
}

export function onStatus(handler: (status: SessionStatusEvent) => void): Promise<UnlistenFn> {
  if (MOCK_ENABLED) return Promise.resolve(subscribe(mockListeners.statuses, handler));
  return listen<SessionStatusEvent>(EVENTS.status, (event) => handler(event.payload));
}

export function onPlayback(handler: (status: PlaybackStatusEvent) => void): Promise<UnlistenFn> {
  if (MOCK_ENABLED) return Promise.resolve(subscribe(mockListeners.playback, handler));
  return listen<PlaybackStatusEvent>(EVENTS.playback, (event) => handler(event.payload));
}
