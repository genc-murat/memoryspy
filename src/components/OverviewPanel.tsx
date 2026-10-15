import { useState } from 'react';

import { diagnose } from '../lib/analysis';
import { formatBytes, formatBytesCompact, formatBytesPerSecond, formatDuration, formatPercent } from '../lib/format';
import { palette } from '../lib/palette';
import type { MetricsStore } from '../lib/store';
import { CounterGrid } from './CounterGrid';
import { TimeSeriesChart } from './TimeSeriesChart';

interface Props {
  store: MetricsStore;
  showAllCounters: boolean;
  /** True when the data came from a recording, which changes what the empty states advise. */
  replaying?: boolean;
  onOpenFinding: (target?: string) => void;
}

function MetricTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="metric-tile">
      <span className="eyebrow">{label}</span>
      <span className="metric-value" style={accent ? { color: accent } : undefined}>
        {value}
      </span>
      {sub && <span className="metric-sub">{sub}</span>}
    </div>
  );
}

/**
 * The overview answers three questions in order: how big, how fast, and what kind of problem.
 *
 * The growth rate is deliberately the largest number on the screen. Totals are ambiguous —
 * 2 GB may be perfectly fine for one service and alarming for another — whereas "412 MB per
 * minute" is unambiguous and is the number that decides whether anyone needs to act.
 */
export function OverviewPanel({ store, showAllCounters, replaying = false, onOpenFinding }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const diagnosis = diagnose(store);

  const workingSet = store.counter('working-set');
  const gcHeap = store.counter('gc-heap-size');
  const committed = store.counter('gc-committed');
  const allocRate = store.counter('alloc-rate');
  const timeInGc = store.counter('time-in-gc');
  const cpu = store.counter('cpu-usage');

  const growth = diagnosis.gcHeap;
  const growthText =
    growth === null ? '—' : `${growth.ratePerMinute > 0 ? '+' : '−'}${formatBytes(Math.abs(growth.ratePerMinute))}/min`;

  const growthAccent =
    growth === null || growth.ratePerMinute < 1 * 1024 * 1024 || growth.r2 < 0.45
      ? undefined
      : growth.ratePerMinute > 50 * 1024 * 1024
        ? palette.critical
        : palette.warning;

  const latest = (name: string): string => {
    const series = store.counter(name);
    if (!series || series.points.length === 0) return '—';
    const value = series.points[series.points.length - 1].v;
    if (series.meta.unit === 'bytes') return formatBytes(value);
    if (series.meta.unit === 'bytes-per-second') return formatBytesPerSecond(value);
    if (series.meta.unit === 'percent') return formatPercent(value);
    if (series.meta.unit === 'ms') return `${value.toFixed(1)} ms`;
    return value.toFixed(0);
  };

  return (
    <div className="panel">
      <section className="hero">
        <div className="hero-main">
          <span className="eyebrow">GC heap growth rate</span>
          <span className="hero-number" style={growthAccent ? { color: growthAccent } : undefined}>
            {growthText}
          </span>
          <span className="hero-caption">
            {growth === null
              ? replaying
                ? 'Waiting for samples — the replay resumes from here.'
                : 'Collecting… attach to a process to see a trend.'
              : growth.r2 < 0.45
                ? `Trend is noisy (r² ${growth.r2.toFixed(2)}) — the heap rises and falls with collection rather than climbing.`
                : `Steady over the last ${formatDuration(growth.windowMs)} (r² ${growth.r2.toFixed(2)}, ${growth.samples} samples). ${formatBytes(growth.first)} → ${formatBytes(growth.last)}.`}
          </span>
        </div>

        <div className="hero-tiles">
          <MetricTile label="Working set" value={latest('working-set')} sub={diagnosis.workingSet ? `${formatBytes(diagnosis.workingSet.ratePerMinute)}/min` : undefined} />
          <MetricTile label="Gen 2" value={latest('gen-2-size')} sub="long-lived objects" />
          <MetricTile label="LOH" value={latest('loh-size')} sub="≥ 85 KB objects" />
          <MetricTile label="Allocation rate" value={latest('alloc-rate')} sub="allocated per second" />
          <MetricTile label="Time in GC" value={latest('time-in-gc')} sub="of elapsed time" />
          <MetricTile label="CPU" value={latest('cpu-usage')} sub="of one core (100% = 1 core)" />
        </div>
      </section>

      {store.samples < 5 && (
        <div className="notice notice-info">
          Waiting for the first samples. Counters arrive once per interval; heap and allocation data needs a
          collection or two to appear.
        </div>
      )}

      <section className="chart-block">
        <header className="block-head">
          <h2>Memory</h2>
          <p>
            Working set is the resident memory the OS is holding; GC heap is what the runtime is managing. The heap can
            legitimately read larger than the working set — committed pages are faulted in lazily, and the OS can
            compress or swap them — so read the two lines as shapes over time rather than a strict hierarchy.
          </p>
        </header>
        <TimeSeriesChart
          height={240}
          format={(value) => formatBytesCompact(value)}
          series={[
            {
              key: 'working-set',
              label: 'Working set',
              color: palette.workingSet,
              points: workingSet?.points ?? [],
            },
            {
              key: 'gc-heap-size',
              label: 'GC heap',
              color: palette.gen2,
              points: gcHeap?.points ?? [],
              fill: true,
            },
            {
              key: 'gc-committed',
              label: 'GC committed',
              color: palette.committed,
              points: committed?.points ?? [],
            },
          ]}
        />
      </section>

      <section className="chart-block">
        <header className="block-head">
          <h2>Heap by generation</h2>
          <p>Where objects live tells you what kind of problem you have: Gen 2 accumulates retained graphs, the LOH accumulates large arrays and strings.</p>
        </header>
        <TimeSeriesChart
          height={220}
          format={(value) => formatBytesCompact(value)}
          series={[
            { key: 'gen2', label: 'Gen 2', color: palette.gen2, points: store.counter('gen-2-size')?.points ?? [] },
            { key: 'loh', label: 'LOH', color: palette.loh, points: store.counter('loh-size')?.points ?? [] },
            { key: 'gen1', label: 'Gen 1', color: palette.gen1, points: store.counter('gen-1-size')?.points ?? [] },
            { key: 'gen0', label: 'Gen 0', color: palette.gen0, points: store.counter('gen-0-size')?.points ?? [] },
          ]}
        />
      </section>

      <section className="chart-block">
        <header className="block-head">
          <h2>Allocation and GC cost</h2>
          <p>Allocation rate drives collection frequency. High allocation with a flat heap is churn; high allocation with a rising heap is a leak being filled.</p>
        </header>
        <TimeSeriesChart
          height={200}
          format={(value) => formatBytesCompact(value)}
          series={[
            { key: 'alloc-rate', label: 'Allocation rate', color: palette.allocRate, points: allocRate?.points ?? [], fill: true },
            { key: 'gc-pause', label: 'GC pause time', color: palette.gcPause, points: store.counter('total-pause-time-by-gc')?.points ?? [] },
            { key: 'time-in-gc', label: 'Time in GC', color: palette.info, points: timeInGc?.points ?? [] },
            { key: 'cpu', label: 'CPU', color: palette.cpu, points: cpu?.points ?? [] },
          ]}
        />
      </section>

      {diagnosis.findings.length > 0 && (
        <section className="notice-row">
          {diagnosis.findings.slice(0, 3).map((finding) => (
            <button
              type="button"
              key={finding.id}
              className={`notice notice-${finding.severity} notice-button`}
              onClick={() => onOpenFinding(finding.target)}
            >
              <strong>{finding.title}</strong>
              <span>{finding.summary}</span>
            </button>
          ))}
        </section>
      )}

      <section className="chart-block">
        <header className="block-head">
          <h2>All counters</h2>
          <p>Every counter the runtime publishes. Click one to open it full width.</p>
        </header>

        {selected && (
          <div className="focused-counter">
            <header className="focused-head">
              <h3>{store.counter(selected)?.meta.displayName ?? selected}</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>
                Close
              </button>
            </header>
            <p className="focused-desc">{store.counter(selected)?.meta.description}</p>
            <TimeSeriesChart
              height={200}
              format={(value) =>
                store.counter(selected!)?.meta.unit === 'percent'
                  ? `${value.toFixed(1)}%`
                  : (store.counter(selected!)?.meta.unit ?? '') === 'bytes'
                    ? formatBytesCompact(value)
                    : value.toFixed(2)
              }
              series={[
                {
                  key: selected,
                  label: store.counter(selected)?.meta.displayName ?? selected,
                  color: palette.workingSet,
                  points: store.counter(selected)?.points ?? [],
                  fill: true,
                },
              ]}
            />
          </div>
        )}

        <CounterGrid
          counters={[...store.counters.values()]}
          showAll={showAllCounters}
          selected={selected}
          onSelect={(name) => setSelected(name === selected ? null : name)}
        />
      </section>
    </div>
  );
}
