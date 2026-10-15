import type {
  AllocationSampleData,
  AllocationSiteData,
  CollectorMessage,
  CounterReading,
  GcEventData,
  GcSummaryData,
  HeapStatsData,
  ProbeDescriptor,
  SessionState,
  SessionStats,
  TypeSnapshot,
} from './types';

/** A point in a time series. `t` is a Unix millisecond timestamp. */
export interface Point {
  t: number;
  v: number;
}

/** A counter's metadata plus its rolling history. */
export interface CounterSeries {
  meta: CounterReading;
  points: Point[];
}

/** A single collection, kept for the GC timeline. */
export interface GcEventRecord extends GcEventData {
  seq: number;
  receivedAt: number;
}

export interface LogRecord {
  seq: number;
  at: number;
  level: string;
  message: string;
  /** Which session/log channel it came from. */
  source: 'collector' | 'host';
}

/** Allocation totals per type, accumulated across the whole session. */
export interface TypeRecord extends TypeSnapshot {
  /** Rolling history of the per-interval allocation rate, for the sparkline. */
  rate: Point[];
  /** How many consecutive intervals the type has appeared in. */
  intervals: number;
  /** Rate observed in the most recent interval, already in bytes per second. */
  currentRate: number;
  /** Rate observed N intervals ago, used to detect acceleration. */
  previousRate: number;
}

export interface HeapSnapshotPoint {
  t: number;
  /* Compact fields for the chart series. */
  total: number;
  gen0: number;
  gen1: number;
  gen2: number;
  loh: number;
  poh: number;
  gcHandleCount: number;
  pinnedObjectCount: number;
  gen2Collections: number;
  /** The untouched runtime payload, for panels that need fields the charts do not use. */
  stats: HeapStatsData;
}

export interface SessionMeta {
  sessionId: string | null;
  pid: number | null;
  state: SessionState | 'idle';
  detail: string | null;
  stats: SessionStats | null;
  startedAt: number | null;
  probes: ProbeDescriptor[];
}

/**
 * The single source of truth for live metrics.
 *
 * Why a class with a raw notification instead of React state: at a one second interval with
 * three probes the app receives dozens of messages per second, each of which extends a
 * history buffer. Putting those buffers through React's immutable update path would copy
 * tens of thousands of numbers per second for no benefit. Components subscribe and re-render
 * on a throttled tick; charts read the buffers directly.
 */
export class MetricsStore {
  readonly counters = new Map<string, CounterSeries>();
  readonly types = new Map<string, TypeRecord>();
  readonly heap = new Map<string, HeapSnapshotPoint>();
  readonly heapHistory: HeapSnapshotPoint[] = [];
  readonly gcEvents: GcEventRecord[] = [];
  readonly gcSummary: GcSummaryData[] = [];
  readonly logs: LogRecord[] = [];

  /**
   * Completed call-site analyses, newest first.
   *
   * A deep capture produces one analysis per session rather than a series, so this is a list
   * of reports rather than a timeline: the panel shows the newest and can show the rest.
   */
  readonly allocationSites: AllocationSiteData[] = [];

  /** Where the running session's raw capture is being written, if it is capturing at all. */
  capturePath: string | null = null;
  captureBytes = 0;
  captureTruncated = false;

  session: SessionMeta = {
    sessionId: null,
    pid: null,
    state: 'idle',
    detail: null,
    stats: null,
    startedAt: null,
    probes: [],
  };

  /** Number of samples received, useful for the status strip. */
  samples = 0;

  /**
   * Bumped once per coalesced notification. `useSyncExternalStore` needs a value that only
   * changes when the store really changed, otherwise every render would loop.
   */
  version = 0;

  /** Point budget per series, derived from the history setting. */
  historyPoints = 300;

  private listeners = new Set<() => void>();
  private seq = 0;
  private dirty = false;
  private notifyScheduled = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Coalesces bursts of messages into at most one re-render per frame. Without this a
   * burst of GC events would trigger a render per event and the UI would stutter exactly
   * when the app is under the most load.
   */
  private markDirty() {
    this.dirty = true;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;

    this.flushTimer = setTimeout(() => {
      this.notifyScheduled = false;
      this.flushTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.version += 1;
      for (const listener of this.listeners) listener();
    }, 120);
  }

  dispose() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.listeners.clear();
  }

  setHistorySeconds(seconds: number, intervalMs: number) {
    const pointCount = Math.max(20, Math.ceil((seconds * 1000) / Math.max(200, intervalMs)));
    this.historyPoints = pointCount;
    this.trim();
  }

  private trim() {
    for (const series of this.counters.values()) {
      if (series.points.length > this.historyPoints) {
        series.points.splice(0, series.points.length - this.historyPoints);
      }
    }
    for (const record of this.types.values()) {
      if (record.rate.length > this.historyPoints) {
        record.rate.splice(0, record.rate.length - this.historyPoints);
      }
    }
    if (this.heapHistory.length > this.historyPoints) {
      this.heapHistory.splice(0, this.heapHistory.length - this.historyPoints);
    }
    if (this.gcEvents.length > 400) {
      this.gcEvents.splice(0, this.gcEvents.length - 400);
    }
    if (this.gcSummary.length > this.historyPoints) {
      this.gcSummary.splice(0, this.gcSummary.length - this.historyPoints);
    }
  }

  // -------------------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------------------

  /** Applies a batch of collector messages. Returns the number of messages applied. */
  ingest(messages: CollectorMessage[]): number {
    let applied = 0;
    for (const message of messages) {
      this.apply(message);
      applied += 1;
    }
    if (applied > 0) this.markDirty();
    return applied;
  }

  private apply(message: CollectorMessage) {
    switch (message.type) {
      case 'counter.sample':
        this.applyCounterSample(unwrap<{ counters: CounterReading[] }>(message), message.ts);
        break;
      case 'allocation.sample':
        this.applyAllocationSample(unwrap<AllocationSampleData>(message), message.ts);
        break;
      case 'heap.stats':
        this.applyHeapStats(unwrap<HeapStatsData>(message), message.ts);
        break;
      case 'gc.event':
        this.applyGcEvent(unwrap<GcEventData>(message), message.ts);
        break;
      case 'gc.summary': {
        const summary = unwrap<GcSummaryData>(message);
        if (summary) this.gcSummary.push(summary);
        break;
      }
      case 'log': {
        const data = unwrap<{ level: string; message: string }>(message);
        if (data) this.pushLog(message.ts, 'collector', data);
        break;
      }
      case 'error': {
        const data = unwrap<{ message: string }>(message);
        if (data) this.pushLog(message.ts, 'collector', { level: 'error', message: data.message });
        break;
      }
      case 'session.started': {
        this.session.startedAt = message.ts;
        const data = unwrap<{ deepCapture?: { path: string } | null }>(message);
        this.capturePath = data?.deepCapture?.path ?? null;
        this.captureBytes = 0;
        this.captureTruncated = false;
        break;
      }
      case 'target.exited': {
        const data = unwrap<{ capture?: { path: string; bytes: number; truncated: boolean } | null }>(message);
        if (data?.capture) {
          this.capturePath = data.capture.path;
          this.captureBytes = data.capture.bytes;
          this.captureTruncated = data.capture.truncated;
        }
        break;
      }
      case 'allocation.site': {
        const analysis = unwrap<AllocationSiteData>(message);
        if (analysis) {
          this.allocationSites.unshift(analysis);
          // Only a handful are ever useful at once; the newest is the one that describes the
          // session the user just stopped.
          if (this.allocationSites.length > 6) this.allocationSites.pop();
        }
        break;
      }
      default:
        break;
    }
    this.samples += 1;
  }

  /**
   * `at` is the collector's timestamp, never the wall clock. A replay at 32x would otherwise
   * compress two hours of growth into four minutes and report a leak rate thirty times too
   * high, which is exactly the number the whole app exists to produce.
   */
  private applyCounterSample(
    data: { counters: CounterReading[]; intervalMs?: number } | null,
    at: number,
  ) {
    if (!data?.counters) return;

    for (const reading of data.counters) {
      let series = this.counters.get(reading.name);
      if (!series) {
        series = { meta: reading, points: [] };
        this.counters.set(reading.name, series);
      } else {
        // Metadata can change between runtime versions mid-session; keep the newest.
        series.meta = reading;
      }

      series.points.push({ t: at, v: reading.value });
      if (series.points.length > this.historyPoints + 8) {
        series.points.splice(0, series.points.length - this.historyPoints);
      }
    }
  }

  private applyAllocationSample(data: AllocationSampleData | null, at: number) {
    if (!data?.types) return;

    for (const snapshot of data.types) {
      const existing = this.types.get(snapshot.typeName);
      if (existing) {
        existing.previousRate = existing.currentRate;
        existing.currentRate = snapshot.intervalBytesPerSecond;
        existing.intervalBytes = snapshot.intervalBytes;
        existing.intervalBytesPerSecond = snapshot.intervalBytesPerSecond;
        existing.totalBytes = snapshot.totalBytes;
        existing.tickCount = snapshot.tickCount;
        existing.sizedSampleCount = snapshot.sizedSampleCount;
        existing.averageObjectBytes = snapshot.averageObjectBytes;
        existing.largestObjectBytes = snapshot.largestObjectBytes;
        existing.lastSeenUnixMs = snapshot.lastSeenUnixMs;
        existing.intervals += 1;
        existing.rate.push({ t: at, v: snapshot.intervalBytesPerSecond });
        if (existing.rate.length > this.historyPoints + 8) {
          existing.rate.splice(0, existing.rate.length - this.historyPoints);
        }
      } else {
        this.types.set(snapshot.typeName, {
          ...snapshot,
          currentRate: snapshot.intervalBytesPerSecond,
          previousRate: 0,
          intervals: 1,
          rate: [{ t: at, v: snapshot.intervalBytesPerSecond }],
        });
      }
    }
  }

  private applyHeapStats(data: HeapStatsData | null, at: number) {
    if (!data) return;

    const point: HeapSnapshotPoint = {
      t: at,
      total: data.totalHeapBytes,
      gen0: data.gen0Bytes,
      gen1: data.gen1Bytes,
      gen2: data.gen2Bytes,
      loh: data.lohBytes,
      poh: data.pohBytes,
      gcHandleCount: data.gcHandleCount,
      pinnedObjectCount: data.pinnedObjectCount,
      gen2Collections: data.gen2Collections,
      stats: data,
    };

    this.heapHistory.push(point);
    this.heap.set('current', point);
  }

  private applyGcEvent(data: GcEventData | null, at: number) {
    if (!data) return;
    this.gcEvents.push({ ...data, seq: ++this.seq, receivedAt: at });
  }

  private pushLog(at: number, source: 'collector' | 'host', data: { level?: string; message?: string }) {
    this.logs.push({
      seq: ++this.seq,
      at,
      level: data.level ?? 'info',
      message: data.message ?? '',
      source,
    });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  addHostLog(level: string, message: string) {
    this.pushLog(Date.now(), 'host', { level, message });
    this.markDirty();
  }

  setSession(partial: Partial<SessionMeta>) {
    this.session = { ...this.session, ...partial };
    this.markDirty();
  }

  /**
   * Clears the metric buffers but keeps the session identity.
   *
   * Used when a replay restarts: the buffers then describe a timeline that no longer exists,
   * and appending the new run to them would produce a chart that never happened.
   */
  clearData() {
    this.counters.clear();
    this.types.clear();
    this.heap.clear();
    this.heapHistory.length = 0;
    this.gcEvents.length = 0;
    this.gcSummary.length = 0;
    this.logs.length = 0;
    this.allocationSites.length = 0;
    this.capturePath = null;
    this.captureBytes = 0;
    this.captureTruncated = false;
    this.samples = 0;
    this.markDirty();
  }

  /** Clears every buffer. Used when attaching to a new process. */
  reset() {
    this.clearData();
    this.session = {
      ...this.session,
      sessionId: null,
      pid: null,
      state: 'idle',
      stats: null,
      detail: null,
      startedAt: null,
    };
    this.markDirty();
  }

  // -------------------------------------------------------------------------------------
  // Queries used by panels
  // -------------------------------------------------------------------------------------

  counter(name: string): CounterSeries | undefined {
    return this.counters.get(name);
  }

  latestHeap(): HeapSnapshotPoint | undefined {
    return this.heapHistory[this.heapHistory.length - 1];
  }

  /** Types ranked by current allocation rate, capped for rendering. */
  topTypes(by: 'rate' | 'total' | 'delta', limit = 60): TypeRecord[] {
    const all = [...this.types.values()];
    const comparator = (a: TypeRecord, b: TypeRecord) => {
      if (by === 'total') return b.totalBytes - a.totalBytes;
      if (by === 'delta') return b.currentRate - b.previousRate - (a.currentRate - a.previousRate);
      return b.currentRate - a.currentRate;
    };
    return all.sort(comparator).slice(0, limit);
  }
}

function unwrap<T>(message: CollectorMessage): T | null {
  return (message.data as T) ?? null;
}

/** Categories offered as filter chips, in the order they should appear. */
export const CATEGORY_ORDER = ['Memory', 'GC', 'CPU', 'ThreadPool', 'Exceptions', 'JIT', 'Other'] as const;
