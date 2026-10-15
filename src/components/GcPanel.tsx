import { useMemo } from 'react';

import { formatBytes, formatBytesCompact, formatClock, formatMilliseconds } from '../lib/format';
import { heapColors, heapLabels, palette } from '../lib/palette';
import type { MetricsStore } from '../lib/store';
import { TimeSeriesChart } from './TimeSeriesChart';

interface Props {
  store: MetricsStore;
}

/**
 * GC behaviour, which is where "the process is using memory" turns into "the process is
 * spending its time collecting".
 *
 * Two things are shown that a counter table cannot convey: the *shape* of the pause
 * distribution, and the *reasons* the runtime chose to collect — a wall of "Induced" or
 * "Low memory" reasons is a very different situation from steady small-allocation Gen 0s.
 */
export function GcPanel({ store }: Props) {
  const heap = store.latestHeap();

  const heapSeries = useMemo(
    () =>
      (['gen0', 'gen1', 'gen2', 'loh', 'poh'] as const).map((key) => ({
        key,
        label: heapLabels[key],
        color: heapColors[key],
        points: store.heapHistory.map((point) => ({ t: point.t, v: point[key] as number })),
      })),
    // Every snapshot below has to depend on `store.version`: `store` itself is a stable
    // reference, so depending on it alone pinned these lists to their first render and the
    // panel contradicted itself — "63 collections observed" beside a list that stopped at 46.
    [store, store.version],
  );

  const recent = useMemo(() => [...store.gcEvents].reverse().slice(0, 60), [store, store.version]);
  const maxPause = Math.max(1, ...recent.map((event) => event.pauseMs ?? 0));

  const byGeneration = useMemo(() => {
    const counts = new Map<number, number>();
    for (const event of store.gcEvents) counts.set(event.generation, (counts.get(event.generation) ?? 0) + 1);
    return counts;
  }, [store, store.version]);

  const reasons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of store.gcEvents) counts.set(event.reasonName, (counts.get(event.reasonName) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [store, store.version]);

  const totalPause = store.gcEvents.reduce((sum, event) => sum + (event.pauseMs ?? 0), 0);
  const background = store.gcEvents.filter((event) => event.isBackground).length;

  return (
    <div className="panel">
      <section className="metrics-strip">
        <div className="metric-tile">
          <span className="eyebrow">Heap composition</span>
          <span className="metric-value">{heap ? formatBytes(heap.stats.totalHeapBytes) : '—'}</span>
          <span className="metric-sub">
            {heap
              ? `${formatBytes(heap.stats.gen2Bytes)} gen 2 · ${formatBytes(heap.stats.lohBytes)} LOH`
              : 'no collections yet'}
          </span>
        </div>
        <div className="metric-tile">
          <span className="eyebrow">Collections observed</span>
          <span className="metric-value">{store.gcEvents.length.toLocaleString()}</span>
          <span className="metric-sub">
            {byGeneration.get(0) ?? 0} gen 0 · {byGeneration.get(1) ?? 0} gen 1 · {byGeneration.get(2) ?? 0} gen 2
          </span>
        </div>
        <div className="metric-tile">
          <span className="eyebrow">Total pause</span>
          <span className="metric-value">{formatMilliseconds(totalPause)}</span>
          <span className="metric-sub">{background} background collections</span>
        </div>
        <div className="metric-tile">
          <span className="eyebrow">Handles &amp; pinning</span>
          <span className="metric-value">{heap ? heap.stats.gcHandleCount.toLocaleString() : '—'}</span>
          <span className="metric-sub">
            {heap ? `${heap.stats.pinnedObjectCount.toLocaleString()} pinned objects` : ''}
          </span>
        </div>
      </section>

      <section className="chart-block">
        <header className="block-head">
          <h2>Heap composition over time</h2>
          <p>
            Straight from the runtime's end-of-collection heap statistics, so these are true sizes rather than
            estimates. A sawtooth in Gen 0 with a flat Gen 2 is healthy; a rising Gen 2 floor is not.
          </p>
        </header>
        <TimeSeriesChart
          height={240}
          stepBase="binary"
          format={(value) => formatBytesCompact(value)}
          series={heapSeries}
        />
      </section>

      <div className="two-col">
        <section className="chart-block">
          <header className="block-head">
            <h2>Recent collections</h2>
            <p>Pause duration is measured from the trace timestamps, so it is the runtime's real pause.</p>
          </header>

          {recent.length === 0 && <p className="empty-note">No collections observed yet.</p>}

          <ul className="gc-list">
            {recent.map((event) => (
              <li key={event.seq} className={`gc-row gc-gen${event.generation}`}>
                <span className="gc-time">{formatClock(event.receivedAt)}</span>
                <span className="gc-gen">{event.generationName}</span>
                <span className="gc-pause-bar">
                  <span
                    className="gc-pause-fill"
                    style={{ width: `${Math.max(1, ((event.pauseMs ?? 0) / maxPause) * 100)}%` }}
                  />
                </span>
                <span className="gc-pause">{event.pauseMs === null ? '—' : formatMilliseconds(event.pauseMs)}</span>
                <span className="gc-reason">
                  {event.reasonName}
                  {event.isBackground && <span className="chip chip-quiet">background</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="chart-block">
          <header className="block-head">
            <h2>Why the runtime collected</h2>
            <p>
              Collection reasons separate healthy behaviour from distress. "Out of space" and "Low memory" mean the
              heap budget is the constraint; "Induced" means something explicitly asked.
            </p>
          </header>

          {reasons.length === 0 && <p className="empty-note">No collections observed yet.</p>}

          <ul className="reason-list">
            {reasons.map(([reason, count]) => (
              <li key={reason}>
                <span className="reason-label">{reason}</span>
                <span className="reason-bar">
                  <span
                    className={`reason-fill${/low memory|out of space/i.test(reason) ? ' is-alarm' : ''}`}
                    style={{ width: `${(count / Math.max(...reasons.map((entry) => entry[1]))) * 100}%`, background: /low memory|out of space/i.test(reason) ? palette.critical : palette.gen1 }}
                  />
                </span>
                <span className="reason-count">{count}</span>
              </li>
            ))}
          </ul>

          {store.gcSummary.length > 1 && (
            <div className="gc-totals">
              <span>
                Finalizable objects promoted:{' '}
                <strong>{store.gcSummary[store.gcSummary.length - 1].finalizedObjects.toLocaleString()}</strong> in the
                last interval
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
