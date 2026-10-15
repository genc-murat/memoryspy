import { formatBytes, formatBytesPerSecond, formatDuration, formatPercent } from './format';
import type { MetricsStore, Point, TypeRecord } from './store';

/**
 * The diagnosis layer.
 *
 * Every rule below encodes a specific, checkable claim about .NET memory problems — the
 * signature that distinguishes a managed leak from allocation churn, a Large Object Heap
 * problem from a generation 2 problem, or a GC problem from a thread pool problem. The
 * point is to state the conclusion *and* the evidence, so a reader can disagree with the
 * tool instead of having to trust it.
 */

export type Severity = 'critical' | 'warning' | 'info' | 'good';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  summary: string;
  evidence: string[];
  actions: string[];
  /** Counter or panel the finding is about, used to jump to the right view. */
  target?: string;
}

export interface Trend {
  /** Bytes per minute. */
  ratePerMinute: number;
  /** Coefficient of determination: how linear the growth is, 0..1. */
  r2: number;
  /** Number of points the fit used. */
  samples: number;
  /** Wall clock duration the fit covers, in milliseconds. */
  windowMs: number;
  /** Value span over the window, in bytes. */
  delta: number;
  first: number;
  last: number;
}

export interface Suspect {
  record: TypeRecord;
  /** Share of all sampled allocation bytes in the most recent interval. */
  share: number;
  /** True when the type's allocation rate is accelerating. */
  accelerating: boolean;
  /** A short reason this type is listed. */
  reason: string;
  score: number;
}

export interface Diagnosis {
  findings: Finding[];
  workingSet: Trend | null;
  gcHeap: Trend | null;
  suspects: Suspect[];
  /** Highest severity present, for the header badge. */
  overall: Severity;
}

/**
 * Least squares fit over a series, returning the slope in bytes per minute.
 *
 * The r² value is what makes the result trustworthy: a high slope with a poor fit is
 * usually a sawtooth (allocation followed by collection), which is normal operation rather
 * than a leak, so callers must check both numbers.
 */
export function trend(points: Point[], windowPoints = 120): Trend | null {
  if (points.length < 8) return null;

  const slice = points.slice(-windowPoints);
  const n = slice.length;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;

  // Normalise x to seconds offset from the first sample: keeps the variance arithmetic well
  // conditioned even though raw epoch milliseconds are ~1.7e12.
  const t0 = slice[0].t;
  for (const point of slice) {
    const x = (point.t - t0) / 1000;
    const y = point.v;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
    sumYY += y * y;
  }

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  const numerator = n * sumXY - sumX * sumY;
  const slopePerSecond = numerator / denominator;

  // Pearson r², computed directly from the same accumulators. A high slope with a low r² is
  // usually a sawtooth (allocate, collect, allocate) — normal operation, not a leak.
  const yVariance = n * sumYY - sumY * sumY;
  const r2 = yVariance > 1e-6 ? Math.max(0, Math.min(1, (numerator * numerator) / (denominator * yVariance))) : 0;

  return {
    ratePerMinute: slopePerSecond * 60,
    r2,
    samples: n,
    // Taken from the samples themselves rather than assumed from the sample count: the
    // interval can change mid-session and a dropped sample would otherwise inflate the
    // reported window.
    windowMs: Math.max(0, slice[n - 1].t - slice[0].t),
    delta: slice[n - 1].v - slice[0].v,
    first: slice[0].v,
    last: slice[n - 1].v,
  };
}

const MB = 1024 * 1024;

export function diagnose(store: MetricsStore): Diagnosis {
  const findings: Finding[] = [];

  const workingSet = trend(store.counter('working-set')?.points ?? []);
  const gcHeap = trend(store.counter('gc-heap-size')?.points ?? []);
  const gen2 = trend(store.counter('gen-2-size')?.points ?? []);
  const loh = trend(store.counter('loh-size')?.points ?? []);
  const allocRate = trend(store.counter('alloc-rate')?.points ?? []);
  const timeInGc = latest(store, 'time-in-gc');
  const threadQueue = latest(store, 'threadpool-queue-length');
  const threadCount = trend(store.counter('threadpool-thread-count')?.points ?? []);
  const exceptions = latest(store, 'exception-count');
  const fragmentation = latest(store, 'gc-fragmentation');
  const heap = store.latestHeap();

  const suspects = rankSuspects(store);

  // ---- The headline question: is anything actually growing? -------------------------
  const growing = (t: Trend | null, threshold: number) => t !== null && t.ratePerMinute > threshold && t.r2 > 0.55 && t.samples >= 20;

  if (workingSet && growing(workingSet, 50 * MB)) {
    findings.push({
      id: 'working-set-growth',
      severity: 'critical',
      title: 'Working set is climbing fast',
      summary: `Resident memory grew about ${formatBytes(workingSet.ratePerMinute)} per minute across the last ${formatDuration(workingSet.windowMs)}, with a steady (${formatPercent(workingSet.r2 * 100, 0)} linear) trend — this is a real leak, not a sawtooth.`,
      evidence: [
        `${formatBytes(workingSet.first)} → ${formatBytes(workingSet.last)} over the window`,
        gcHeap ? `GC heap moved ${formatBytes(gcHeap.ratePerMinute)}/min over the same window` : 'GC heap trend unavailable',
      ],
      actions: [
        'Open the Types view and confirm whether one type dominates the allocation share.',
        'Take a snapshot, wait for memory to grow, and diff it to find what is retained.',
        'Check whether the growth is in Gen 2 (long-lived objects) or the LOH (large arrays).',
      ],
      target: 'types',
    });
  } else if (workingSet && growing(workingSet, 5 * MB)) {
    findings.push({
      id: 'working-set-growth-mild',
      severity: 'warning',
      title: 'Working set is growing',
      summary: `Resident memory grew about ${formatBytes(workingSet.ratePerMinute)} per minute. Slow enough to be steady-state caching, but worth confirming.`,
      evidence: [`${formatBytes(workingSet.first)} → ${formatBytes(workingSet.last)}`, `Linear fit r² = ${workingSet.r2.toFixed(2)}`],
      actions: ['Let it run longer to see if the rate is constant or decaying (caching) versus unbounded.'],
      target: 'overview',
    });
  }

  // ---- Where the growth lives -------------------------------------------------------
  if (gen2 && loh) {
    const gen2Rate = gen2.ratePerMinute;
    const lohRate = loh.ratePerMinute;

    if (gen2Rate > 5 * MB && gen2.r2 > 0.5 && gen2Rate > lohRate * 3) {
      findings.push({
        id: 'gen2-growth',
        severity: gen2Rate > 50 * MB ? 'critical' : 'warning',
        title: 'Generation 2 is accumulating',
        summary: `Long-lived objects are piling up at ${formatBytes(gen2Rate)} per minute while the Large Object Heap stays relatively flat. That is the classic signature of objects that stay reachable — a collection or cache that is never evicted, an event handler that is never detached, or a static field that keeps growing.`,
        evidence: [
          `Gen 2: ${formatBytes(gen2.first)} → ${formatBytes(gen2.last)} (${formatBytes(gen2Rate)}/min)`,
          `LOH: ${formatBytes(loh.first)} → ${formatBytes(loh.last)} (${formatBytes(lohRate)}/min)`,
          heap ? `GC handles held: ${heap.gcHandleCount.toLocaleString()}` : '',
        ].filter(Boolean),
        actions: [
          'Look at the Types view: the top allocating type is usually the same type that is being retained.',
          'Check caches, dictionaries and static collections for missing eviction or size limits.',
          'Check `Changed +=` style subscriptions that are never unsubscribed.',
        ],
        target: 'types',
      });
    }

    if (lohRate > 5 * MB && loh.r2 > 0.5 && lohRate > gen2Rate) {
      findings.push({
        id: 'loh-growth',
        severity: lohRate > 50 * MB ? 'critical' : 'warning',
        title: 'Large Object Heap is growing',
        summary: `Objects of 85 KB or larger are accumulating at ${formatBytes(lohRate)} per minute. The LOH is not compacted by default, so this both eats memory and fragments it.`,
        evidence: [
          `LOH: ${formatBytes(loh.first)} → ${formatBytes(loh.last)} (${formatBytes(lohRate)}/min)`,
          fragmentation !== null ? `Heap fragmentation: ${formatPercent(fragmentation)}` : '',
          suspects[0] ? `Largest sampled type: ${suspects[0].record.typeName} (avg object ${formatBytes(suspects[0].record.averageObjectBytes)})` : '',
        ].filter(Boolean),
        actions: [
          'Find the large arrays, buffers or strings in the Types view.',
          'Reuse buffers (ArrayPool) instead of allocating large arrays per operation.',
          'Consider `GCSettings.LargeObjectHeapCompactionMode` if fragmentation is the main cost.',
        ],
        target: 'types',
      });
    }
  }

  // ---- Allocation churn vs a leak ---------------------------------------------------
  if (allocRate && workingSet && allocRate.last > 10 * MB && workingSet.ratePerMinute < 2 * MB) {
    findings.push({
      id: 'allocation-churn',
      severity: 'info',
      title: 'High allocation rate without a leak',
      summary: `The process allocates about ${formatBytesPerSecond(allocRate.last)}, but the heap stays flat — this is allocation churn rather than a leak. The cost here is GC CPU, not memory growth.`,
      evidence: [
        `Allocation rate: ${formatBytesPerSecond(allocRate.last)}`,
        `Working set trend: ${formatBytes(workingSet.ratePerMinute)}/min`,
        timeInGc !== null ? `Time in GC: ${formatPercent(timeInGc)}` : '',
      ].filter(Boolean),
      actions: [
        'Reduce short-lived allocations on hot paths to cut GC pressure.',
        'Look for `string` concatenation, LINQ chains and boxing in the Types view.',
      ],
      target: 'types',
    });
  }

  // ---- GC health --------------------------------------------------------------------
  if (timeInGc !== null && timeInGc > 20) {
    findings.push({
      id: 'gc-pressure',
      severity: timeInGc > 40 ? 'critical' : 'warning',
      title: 'High time spent in GC',
      summary: `The runtime spends ${formatPercent(timeInGc)} of its time in garbage collection. Above roughly 10% throughput measurably drops; above 40% the application is mostly collecting.`,
      evidence: [
        `Time in GC: ${formatPercent(timeInGc)}`,
        allocRate ? `Allocation rate: ${formatBytesPerSecond(allocRate.last)}` : '',
        threadQueue !== null ? `Thread pool queue: ${threadQueue}` : '',
      ].filter(Boolean),
      actions: [
        'Reduce the allocation rate first — GC frequency follows allocation, not heap size.',
        'Check for a Gen 2 bottleneck: if full collections are rare, the heap may be sized poorly.',
      ],
      target: 'gc',
    });
  }

  if (heap && heap.stats.gen2Collections === 0 && (gen2?.last ?? 0) > 64 * MB && store.heapHistory.length > 20) {
    findings.push({
      id: 'no-full-gc',
      severity: 'warning',
      title: 'Gen 2 is large but never collected',
      summary: `Generation 2 holds ${formatBytes(heap.stats.gen2Bytes)} and no full (Gen 2) collection has been observed this session. Either the heap is still within budget or the runtime has decided collection is not worth the pause.`,
      evidence: [
        `Gen 2 size: ${formatBytes(heap.stats.gen2Bytes)}`,
        `Gen 2 collections observed: ${heap.stats.gen2Collections}`,
        heap.stats.gen1Collections || heap.stats.gen0Collections
          ? `Gen 0 / Gen 1 collections: ${heap.stats.gen0Collections} / ${heap.stats.gen1Collections}`
          : '',
      ].filter(Boolean),
      actions: [
        'Watch whether Gen 2 growth ever comes back down; an unbounded climb with no collection is the leak signature.',
        'Consider whether a long-lived reference (static, cache, event handler) pins these objects.',
      ],
      target: 'gc',
    });
  }

  // ---- Thread pool ------------------------------------------------------------------
  if (threadQueue !== null && threadQueue > 0) {
    findings.push({
      id: 'threadpool-queue',
      severity: threadQueue > 20 ? 'critical' : 'warning',
      title: 'Thread pool work is queueing',
      summary: `${threadQueue} work items are waiting for a thread. A persistently non-zero queue means blocking work is starving the pool, which also shows up as memory growth when responses buffer.`,
      evidence: [
        `Queue length: ${threadQueue}`,
        threadCount ? `Thread count: ${threadCount.last.toFixed(0)} (${threadCount.ratePerMinute > 0 ? '+' : ''}${threadCount.ratePerMinute.toFixed(1)}/min)` : '',
      ].filter(Boolean),
      actions: ['Find synchronous IO or `.Result` / `.Wait()` calls on async paths.'],
      target: 'summary',
    });
  }

  if (threadCount && threadCount.last > 50 && threadCount.ratePerMinute > 1) {
    findings.push({
      id: 'threadpool-growth',
      severity: 'warning',
      title: 'Thread pool is growing',
      summary: `Thread count reached ${threadCount.last.toFixed(0)} and keeps climbing. The pool injects threads when work is blocked, so this usually tracks a blocking problem — each thread also costs stack memory.`,
      evidence: [
        `Threads: ${threadCount.last.toFixed(0)}, trend ${threadCount.ratePerMinute.toFixed(2)}/min`,
        threadQueue !== null ? `Queue length: ${threadQueue}` : '',
      ].filter(Boolean),
      actions: ['Audit blocking calls, then compare with the memory curve — blocked requests often retain their buffers.'],
      target: 'summary',
    });
  }

  // ---- Handles and pinning ----------------------------------------------------------
  const handleTrend = trendSeries(store.heapHistory.map((p) => ({ t: p.t, v: p.gcHandleCount })));

  if (handleTrend && handleTrend.ratePerMinute > 60 && handleTrend.r2 > 0.6 && handleTrend.samples >= 20) {
    findings.push({
      id: 'gc-handle-growth',
      severity: 'warning',
      title: 'GC handles are leaking',
      summary: `The number of GC handles grew by about ${handleTrend.ratePerMinute.toFixed(0)} per minute (now ${handleTrend.last.toFixed(0)}). Handles are not reclaimed unless they are released, so this is a distinct leak from object retention.`,
      evidence: [
        `GC handles: ${handleTrend.first.toFixed(0)} → ${handleTrend.last.toFixed(0)}`,
        heap ? `Pinned objects: ${heap.stats.pinnedObjectCount.toLocaleString()}` : '',
      ].filter(Boolean),
      actions: [
        'Look for `GCHandle.Alloc` without a matching `Free`, and for `Marshal.AllocHGlobal` without `FreeHGlobal`.',
        'Check interop code that pins buffers for the lifetime of a call.',
      ],
      target: 'gc',
    });
  }

  if (heap && heap.pinnedObjectCount > 0) {
    findings.push({
      id: 'pinned-objects',
      severity: 'info',
      title: 'Pinned objects present',
      summary: `${heap.stats.pinnedObjectCount.toLocaleString()} objects are pinned. Pinning prevents the GC from moving them, which is a common source of heap fragmentation.`,
      evidence: [
        `Pinned objects: ${heap.stats.pinnedObjectCount.toLocaleString()}`,
        `GC handles: ${heap.stats.gcHandleCount.toLocaleString()}`,
        fragmentation !== null ? `Fragmentation: ${formatPercent(fragmentation)}` : '',
      ].filter(Boolean),
      actions: ['Prefer `fixed` scopes or `Memory<T>` over long-lived `GCHandle.Alloc(..., Pinned)`.'],
      target: 'gc',
    });
  }

  // ---- Exceptions -------------------------------------------------------------------
  if (exceptions !== null && exceptions > 100) {
    findings.push({
      id: 'exception-volume',
      severity: exceptions > 1000 ? 'warning' : 'info',
      title: 'Exceptions are being thrown heavily',
      summary: `${exceptions.toLocaleString()} exceptions in the last interval. Throwing is expensive, and each one allocates — exception-heavy paths often show up as allocation churn.`,
      evidence: [`Exceptions: ${exceptions.toLocaleString()} per interval`],
      actions: ['Search for `try`/`catch` used for control flow, and for parse-and-retry loops.'],
      target: 'summary',
    });
  }

  // ---- The suspect list -------------------------------------------------------------
  if (suspects.length > 0 && (workingSet?.ratePerMinute ?? gcHeap?.ratePerMinute ?? 0) > 2 * MB) {
    const top = suspects[0];
    findings.push({
      id: 'suspect-type',
      severity: (workingSet?.ratePerMinute ?? 0) > 50 * MB ? 'critical' : 'warning',
      title: `Top suspect: ${top.record.typeName}`,
      summary: `${top.record.typeName} accounts for ${formatPercent(top.share * 100)} of sampled allocations at ${formatBytesPerSecond(top.record.currentRate)}${top.accelerating ? ' and its rate is still rising' : ''}. Combined with the heap growth above, this is the type to inspect first.`,
      evidence: [
        `Allocated this session: ${formatBytes(top.record.totalBytes)}`,
        `Average object size: ${formatBytes(top.record.averageObjectBytes)}`,
        top.record.largestObjectBytes > 85 * 1024 ? `Largest sampled object: ${formatBytes(top.record.largestObjectBytes)} — large enough for the LOH` : '',
        top.record.currentRate > top.record.previousRate
          ? `Rate rising: ${formatBytesPerSecond(top.record.previousRate)} → ${formatBytesPerSecond(top.record.currentRate)}`
          : '',
      ].filter(Boolean),
      actions: [
        'Search the codebase for where this type is created and stored.',
        'Check whether instances are put into a collection that never evicts.',
        'Take a snapshot diff after the heap grows to confirm it is retained, not just allocated.',
      ],
      target: 'types',
    });
  }

  if (findings.length === 0 && store.samples > 30) {
    findings.push({
      id: 'healthy',
      severity: 'good',
      title: 'No memory problem detected yet',
      summary: 'Nothing is growing in a way that the current rules consider a problem. Keep it running if the issue is intermittent, or lower the sampling interval to catch short spikes.',
      evidence: [`${store.samples.toLocaleString()} samples analysed`],
      actions: [],
      target: 'overview',
    });
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, good: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    findings,
    workingSet,
    gcHeap,
    suspects,
    overall: findings[0]?.severity ?? 'good',
  };
}

/** Same fit as `trend`, exposed for series that do not live in the counter map. */
function trendSeries(points: Point[]): Trend | null {
  return trend(points);
}

function latest(store: MetricsStore, name: string): number | null {
  const series = store.counter(name);
  if (!series || series.points.length === 0) return null;
  return series.points[series.points.length - 1].v;
}

/**
 * Ranks allocating types by how much they plausibly contribute to the memory problem.
 *
 * Allocation volume alone is a poor signal — a short-lived `string` at the top of the
 * allocation table is usually harmless. The score therefore weights share of total
 * allocation, whether the rate is *rising*, and the size of the objects, because big objects
 * are both more expensive and more likely to be retained.
 */
export function rankSuspects(store: MetricsStore, limit = 12): Suspect[] {
  const records = [...store.types.values()].filter((r) => r.currentRate > 0 || r.totalBytes > 0);
  if (records.length === 0) return [];

  const totalRate = records.reduce((sum, r) => sum + Math.max(0, r.currentRate), 0) || 1;

  const scored = records.map((record) => {
    const share = Math.max(0, record.currentRate) / totalRate;
    const accelerating = record.intervals > 3 && record.currentRate > record.previousRate * 1.15 && record.currentRate > 64 * 1024;

    // A rising rate is the strongest available hint that a type is involved in a leak,
    // followed by its share of allocations, followed by object size.
    let score = share * 100;
    if (accelerating) score += 35;
    if (record.averageObjectBytes >= 85 * 1024) score += 20;
    if (record.totalBytes > 100 * MB) score += 10;

    const reasons: string[] = [];
    if (accelerating) reasons.push('rate rising');
    if (record.averageObjectBytes >= 85 * 1024) reasons.push('large objects (LOH)');
    if (!accelerating && share > 0.2) reasons.push('dominant allocator');

    return {
      record,
      share,
      accelerating,
      score,
      reason: reasons.length > 0 ? reasons.join(', ') : 'steady allocation',
    };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
