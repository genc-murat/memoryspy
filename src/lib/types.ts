/**
 * TypeScript mirrors of the collector protocol.
 *
 * These types are the contract between three processes: the .NET collector that produces
 * the messages, the Rust host that forwards them, and this UI. They are written by hand
 * rather than generated so the protocol stays readable, but the collector's `capabilities`
 * command remains the source of truth for *which* probes exist — the UI renders panels from
 * that handshake instead of from a hard coded list.
 */

export type CanonicalUnit =
  | 'bytes'
  | 'bytes-per-second'
  | 'percent'
  | 'count'
  | 'ms'
  | 'ratio';

export type CounterCategory =
  | 'Memory'
  | 'GC'
  | 'ThreadPool'
  | 'JIT'
  | 'CPU'
  | 'Exceptions'
  | 'Other';

/** One reading inside a `counter.sample` batch. */
export interface CounterReading {
  name: string;
  displayName: string;
  category: CounterCategory;
  /** Value already normalised to `unit`. */
  value: number;
  unit: CanonicalUnit;
  /** Unit exactly as the runtime reported it, for auditing the normalisation. */
  rawUnit?: string | null;
  counterType?: string | null;
  isMemory: boolean;
  /** What the counter means, used as the card and chart tooltip. */
  description?: string | null;
  warnAbove?: number | null;
  criticalAbove?: number | null;
}

export interface CounterSampleData {
  intervalMs: number;
  sampleIndex: number;
  counters: CounterReading[];
}

export interface TypeSnapshot {
  typeName: string;
  intervalBytes: number;
  intervalBytesPerSecond: number;
  totalBytes: number;
  tickCount: number;
  sizedSampleCount: number;
  averageObjectBytes: number;
  largestObjectBytes: number;
  firstSeenUnixMs: number;
  lastSeenUnixMs: number;
}

export interface AllocationSampleData {
  intervalMs: number;
  totalIntervalBytes: number;
  totalIntervalTicks: number;
  totalBytes: number;
  totalTicks: number;
  tickApproximateBytes: number;
  typeCount: number;
  types: TypeSnapshot[];
}

export interface HeapStatsData {
  totalHeapBytes: number;
  totalPromotedBytes: number;
  gen0Bytes: number;
  gen1Bytes: number;
  gen2Bytes: number;
  lohBytes: number;
  pohBytes: number;
  promotedGen0Bytes: number;
  promotedGen1Bytes: number;
  promotedGen2Bytes: number;
  promotedLohBytes: number;
  promotedPohBytes: number;
  finalizationPromotedBytes: number;
  finalizationPromotedCount: number;
  pinnedObjectCount: number;
  gcHandleCount: number;
  sinkBlockCount: number;
  gen0Collections: number;
  gen1Collections: number;
  gen2Collections: number;
}

export interface GcEventData {
  kind: string;
  gcCount: number;
  generation: number;
  generationName: string;
  reason: number;
  reasonName: string;
  isBackground: boolean;
  pauseMs: number | null;
  startedAt: number | null;
}

export interface GcSummaryData {
  intervalMs: number;
  gen0Collections: number;
  gen1Collections: number;
  gen2Collections: number;
  finalizedObjects: number;
}

export interface LogData {
  level: string;
  message: string;
}

/** The envelope every collector line is wrapped in. */
export interface CollectorMessage<T = unknown> {
  v: number;
  seq: number;
  ts: number;
  type: string;
  probe?: string | null;
  data?: T;
}

export interface SessionStartedData {
  pid: number;
  intervalMs: number;
  probes: { id: string; displayName: string; eventTypes: string[] }[];
  providers: { name: string; level: string; keywords: string; arguments: Record<string, string> | null }[];
  /** Set when this session is copying its raw event stream to disk for the deep-capture analysis. */
  deepCapture?: { path: string; maxBytes: number } | null;
}

export interface TargetExitedData {
  pid: number;
  eventsProcessed: number;
  flushOverruns: number;
  /** Where the raw capture went, and whether the size limit cut it short. */
  capture?: { path: string; bytes: number; truncated: boolean } | null;
}

// ---------------------------------------------------------------------------------------
// Allocation call sites (deep capture)
// ---------------------------------------------------------------------------------------

/**
 * One frame of a resolved call chain.
 *
 * The method always arrives; the source location only when the module's PDB could be read, which
 * is why both are carried instead of a single formatted string — the method stays searchable, and
 * the line is what turns a method into the statement that allocates.
 */
export interface AllocationFrame {
  /** The method, as the runtime reports it — pasteable into an IDE search. */
  method: string;
  /**
   * Full path the PDB recorded at build time. Absent when no PDB supplied one — the protocol
   * omits null properties, so "no location" arrives as a missing key rather than as null.
   */
  sourceFile?: string | null;
  sourceLine?: number | null;
}

/** One ranked destination of sampled allocations, located in the source where a PDB allowed it. */
export interface AllocationSite {
  /** The calling method, as the runtime reports it — pasteable into an IDE search. */
  site: string;
  /**
   * The allocating statement, when the module's PDB could be read. These two fields are what
   * separate two allocation sites inside one method: without a PDB both sites collapse into the
   * single `site` method name.
   *
   * Absent — not null — when there was no PDB: the protocol omits null properties.
   */
  sourceFile?: string | null;
  sourceLine?: number | null;
  /**
   * The call chain from that method outwards, so the path that reached it is visible. The
   * first entry is the site itself.
   */
  frames: AllocationFrame[];
  /** True when the site is (or is below) code outside the runtime's own namespaces. */
  userCode: boolean;
  /** True when every frame in the stack belongs to the runtime — a runtime-internal allocation. */
  frameworkOnly: boolean;
  /** Sampled allocation volume attributed to this site, in bytes. */
  sampledBytes: number;
  samples: number;
  /** Fraction of all sampled bytes in the capture, 0–1. */
  share: number;
  averageObjectBytes: number;
  /** The type this site mostly allocates. */
  dominantTypeName: string | null;
  types: { typeName: string; sampledBytes: number; share: number }[];
}

/** The same aggregation seen from the type's side: where a type comes from. */
export interface AllocationSiteType {
  typeName: string;
  sampledBytes: number;
  samples: number;
  share: number;
  /** The site responsible for most of this type — the answer for framework types. */
  dominantSite: string | null;
  /** Where that site is, when a PDB named the statement. Absent when no PDB was readable. */
  dominantSourceFile?: string | null;
  dominantSourceLine?: number | null;
  sites: {
    site: string;
    sourceFile?: string | null;
    sourceLine?: number | null;
    sampledBytes: number;
    share: number;
  }[];
}

/**
 * The result of analysing one deep capture.
 *
 * It arrives once, after the session stops: allocation call stacks can only be named from a
 * finished stream on disk. Everything here describes the capture window, not the live session.
 */
export interface AllocationSiteData {
  captureFile: string;
  captureBytes: number;
  eventsScanned: number;
  sampledEvents: number;
  totalSampledBytes: number;
  totalSamples: number;
  largeObjectSamples: number;
  distinctSites: number;
  distinctTypes: number;
  droppedSites: number;
  droppedTypes: number;
  unresolvedFrames: number;
  frameworkOnlySites: number;
  /** Sites that resolved to a file and line. */
  sitesWithSource: number;
  /** Sites that kept a method name because no PDB was available for their module. */
  sitesWithoutSource: number;
  /** The modules whose PDBs could not be found, so their frames carry no line. */
  modulesWithoutSource: string[];
  /** The symbol path that was consulted, when the environment provided one. */
  symbolPath?: string | null;
  /** Time spent reading PDBs, which is part of `analysisMs`. */
  symbolMs: number;
  /**
   * Set when the symbol phase stopped at its time budget instead of running to the end — the
   * usual cause is a symbol server that does not answer. Sites past that point keep a name only,
   * for a reason that is not a missing PDB, so it is shown next to the other caveats.
   */
  symbolStopReason?: string | null;
  windowStartUnixMs: number;
  windowEndUnixMs: number;
  durationMs: number;
  conversionMs: number;
  analysisMs: number;
  /** The caveat to show verbatim: these are sampled volumes, not exact accounting. */
  sampling: string;
  sites: AllocationSite[];
  types: AllocationSiteType[];
}

// ---------------------------------------------------------------------------------------
// Host (Rust) types
// ---------------------------------------------------------------------------------------

export interface DotnetProcessInfo {
  pid: number;
  name: string;
  commandLine?: string | null;
  executablePath?: string | null;
  runtimeVersion?: string | null;
  runtimeDirectory?: string | null;
  workingSetBytes?: number | null;
  privateBytes?: number | null;
  startTimeUnixMs?: number | null;
}

export interface CollectorLocation {
  found: boolean;
  dotnetPath?: string | null;
  assemblyPath?: string | null;
  source: string;
  dotnetVersion?: string | null;
  searched: string[];
  error?: string | null;
}

export interface Settings {
  collectorPath?: string | null;
  defaultProbes: string[];
  intervalMs: number;
  maxAllocationTypes: number;
  historySeconds: number;
  showAllCounters: boolean;
  verboseCollector: boolean;
  lastSession?: { pid: number; name: string; atUnixMs: number } | null;
}

export interface EnvironmentInfo {
  collector: CollectorLocation;
  settings: Settings;
  sessions: SessionSnapshot[];
  /** Where recordings are written. Shown in the UI so it can be shared with a colleague. */
  recordingsDir: string;
}

export type SessionState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface SessionStats {
  messages: number;
  dropped: number;
  counters: number;
  allocationSamples: number;
  gcEvents: number;
  uptimeMs: number;
  messageCounts: Record<string, number>;
}

export interface SessionSnapshot {
  sessionId: string;
  pid: number;
  state: SessionState;
  stats: SessionStats;
  /** Set while this session is being written to disk. */
  recording?: RecordingSummary | null;
}

// ---------------------------------------------------------------------------------------
// Recording and replay
// ---------------------------------------------------------------------------------------

/** Metadata for one recording on disk. */

export interface RecordingSummary {
  path: string;
  fileName: string;
  targetName?: string | null;
  targetPid?: number | null;
  runtimeVersion?: string | null;
  startedAtUnixMs: number;
  lastEventUnixMs: number;
  durationMs: number;
  sizeBytes: number;
  lineCount: number;
  messageCount: number;
  logCount: number;
  skippedLines: number;
  endReason?: string | null;
  /** A footer was written, i.e. the session ended through a clean shutdown. */
  complete: boolean;
  formatVersion?: number | null;
  startedMidSession: boolean;
  /** Envelope type to count, used to decide which views a recording can feed. */
  messageTypes: Record<string, number>;
  error?: string | null;
}

export type PlaybackState = 'loading' | 'playing' | 'paused' | 'stopped' | 'finished' | 'failed';

/** Progress of a replay. Delivered on its own channel, never mixed with live status. */
export interface PlaybackStatusEvent {
  playbackId: string;
  state: PlaybackState;
  /** 0.5 = half speed, 8 = eight times faster. */
  speed: number;
  /** Recording-time offset, not wall clock: the timeline is the recording's own. */
  positionMs: number;
  durationMs: number;
  /** Bumped on every restart, so the UI knows its buffers describe a dead timeline. */
  generation: number;
  emitted: number;
  error?: string | null;
  recording: RecordingSummary;
}

export interface SessionStatusEvent {
  sessionId: string;
  pid: number;
  state: SessionState;
  detail?: string | null;
  stats: SessionStats;
}

export interface ProbeDescriptor {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  channel: string;
  eventTypes: string[];
  details: Record<string, unknown>;
}

export interface CounterDefinitionDescriptor {
  name: string;
  displayName: string;
  category: CounterCategory;
  unit: CanonicalUnit;
  isMemory: boolean;
  description: string;
  warnAbove?: number | null;
  criticalAbove?: number | null;
}

export interface Capabilities {
  protocolVersion: number;
  tool: string;
  runtime: string;
  os: string;
  architecture: string;
  supports: string[];
  probes: ProbeDescriptor[];
  enabledProbes?: string[];
  options?: { pid: number; intervalMs: number; maxAllocationTypes: number } | null;
  target?: DotnetProcessInfo | null;
}

export interface SessionRequest {
  pid: number;
  probes?: string[];
  intervalMs?: number;
  maxTypes?: number;
  verbose?: boolean;
  /**
   * Copy the raw EventPipe stream to a `.nettrace` so allocation call sites can be resolved
   * from it when the session stops. Costs extra disk I/O and a runtime rundown.
   */
  deepCapture?: boolean;
  /** Write this session's event stream to disk as it arrives. */
  record?: boolean;
  /** An explicit destination; omitted means an auto-named file in the recordings folder. */
  recordPath?: string | null;
  /** Target metadata for the recording header and file name. */
  targetName?: string | null;
  targetRuntime?: string | null;
}
