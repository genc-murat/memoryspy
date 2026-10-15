import { useMemo, useState } from 'react';

import { rankSuspects } from '../lib/analysis';
import { formatBytes, formatBytesPerSecond, formatPercent } from '../lib/format';
import { palette } from '../lib/palette';
import type { MetricsStore, TypeRecord } from '../lib/store';
import type { AllocationSamplingBasis } from '../lib/types';
import { Sparkline } from './Sparkline';

interface Props {
  store: MetricsStore;
}

type SortKey = 'rate' | 'total' | 'acceleration' | 'size' | 'samples';

const SORTS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'rate', label: 'Allocation rate', hint: 'Bytes allocated per second in the most recent interval — the best signal for “what is being created right now”.' },
  { key: 'acceleration', label: 'Acceleration', hint: 'How much the rate rose compared with the previous interval — the best signal for “what is getting worse”.' },
  { key: 'total', label: 'Total allocated', hint: 'Everything allocated since attaching. Useful for volume, misleading for leaks.' },
  { key: 'size', label: 'Object size', hint: 'Average sampled object size. Objects of 85 KB or more land on the Large Object Heap.' },
  { key: 'samples', label: 'Samples', hint: 'Number of sampled allocations seen. A very low count means the numbers are noisy.' },
];

/**
 * What the numbers on this panel mean is decided by the session's keywords, not by the panel:
 * a plain session reports one tick per ~100 KB allocated, while a session with a deep capture
 * armed gets one event per sampled allocation carrying the object's own size. Naming the basis
 * in force is what keeps those two from being read as the same measurement — they rank types
 * alike, but their volumes differ by the sampling ratio.
 */
function samplingNote(basis: AllocationSamplingBasis | null): string {
  if (basis === 'allocationSampling') {
    return (
      'Deep capture is armed, so the runtime reports one event per sampled allocation — the allocated object’s own ' +
      'size — instead of a tick per 100 KB. Shares between types are unbiased, but the volumes are far smaller ' +
      'than in a session without a capture, so read this list against itself rather than against those numbers.'
    );
  }

  return (
    'The runtime samples roughly one allocation tick per 100 KB allocated, so these are scaled estimates. Types ' +
    'that allocate rarely may not appear at all.'
  );
}

/**
 * Answers "which class is growing?".
 *
 * The crucial distinction this panel makes explicit is allocated versus retained: allocation
 * ticks tell you what is being *created*, which is the right question for churn but the wrong
 * one for a leak. So the table is presented next to the heap trend, and the suspect banner
 * only escalates when a type's rate rises *while* the heap grows.
 */
export function TypesPanel({ store }: Props) {
  const [sort, setSort] = useState<SortKey>('rate');
  const [filter, setFilter] = useState('');

  const records = useMemo(() => {
    const all = [...store.types.values()];
    const comparator = (a: TypeRecord, b: TypeRecord) => {
      switch (sort) {
        case 'total':
          return b.totalBytes - a.totalBytes;
        case 'acceleration':
          return b.currentRate - b.previousRate - (a.currentRate - a.previousRate);
        case 'size':
          return b.averageObjectBytes - a.averageObjectBytes;
        case 'samples':
          return b.tickCount - a.tickCount;
        default:
          return b.currentRate - a.currentRate;
      }
    };
    return all.sort(comparator);
    // `store` is a stable reference, so it alone would freeze this list at whatever it held on
    // the first render — a session attached to while this tab was open showed no types at all
    // until some other control recomputed it. `store.version` is what changes, so it is what
    // the list has to depend on.
  }, [store, store.version, sort]);

  const suspects = useMemo(() => rankSuspects(store, 5), [store, store.version]);

  const totalRate = records.reduce((sum, record) => sum + Math.max(0, record.currentRate), 0) || 1;

  const filtered = filter.trim()
    ? records.filter((record) => record.typeName.toLowerCase().includes(filter.trim().toLowerCase()))
    : records;

  const top = suspects[0];

  if (records.length === 0) {
    return (
      <div className="panel">
        <div className="notice notice-info">
          No allocation samples yet. The allocations probe reports once per interval after the runtime raises its
          first sampled allocation — allocate something in the target process and this will fill in.
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      {top && (
        <section className="suspect-banner">
          <div className="suspect-lead">
            <span className="eyebrow">Top suspect</span>
            <span className="suspect-name">{top.record.typeName}</span>
            <span className="suspect-meta">
              {formatPercent(top.share * 100)} of sampled allocations · {formatBytesPerSecond(top.record.currentRate)}
              {top.accelerating && <span className="chip chip-warning">rate rising</span>}
              {top.record.averageObjectBytes >= 85 * 1024 && <span className="chip chip-warning">LOH-sized</span>}
            </span>
          </div>
          <p className="suspect-advice">
            Allocated {formatBytes(top.record.totalBytes)} since attaching, averaging{' '}
            {formatBytes(top.record.averageObjectBytes)} per object. Pair this with the heap trend: if Gen 2 or the LOH
            is climbing at the same time, this type is very likely what is being retained.
          </p>
        </section>
      )}

      <section className="block-head block-head-sticky">
        <div>
          <h2>Allocations by type</h2>
          <p className="caveat">{samplingNote(store.allocationSamplingBasis)}</p>
        </div>
        <div className="table-controls">
          <input
            className="input input-sm"
            placeholder="Filter types"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            spellCheck={false}
          />
          <select className="input input-sm" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
            {SORTS.map((option) => (
              <option key={option.key} value={option.key} title={option.hint}>
                Sort: {option.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <table className="data-table">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Type</th>
            <th className="num">Rate</th>
            <th className="share-col">Share</th>
            <th>Trend (last {store.historyPoints} samples)</th>
            <th className="num">Δ vs prev</th>
            <th className="num">Total</th>
            <th className="num">Avg obj</th>
            <th className="num">Samples</th>
          </tr>
        </thead>
        <tbody>
          {filtered.slice(0, 300).map((record, index) => {
            const share = Math.max(0, record.currentRate) / totalRate;
            const delta = record.currentRate - record.previousRate;
            const isSuspect = suspects.some((entry) => entry.record.typeName === record.typeName);

            return (
              <tr key={record.typeName} className={isSuspect ? 'row-suspect' : undefined}>
                <td className="num dim">{index + 1}</td>
                <td className="type-name" title={record.typeName}>
                  {record.typeName}
                </td>
                <td className="num">{formatBytesPerSecond(record.currentRate)}</td>
                <td className="share-col">
                  <span className="share-bar">
                    <span className="share-fill" style={{ width: `${Math.min(100, share * 100)}%` }} />
                  </span>
                  <span className="share-text">{formatPercent(share * 100, 1)}</span>
                </td>
                <td>
                  <Sparkline
                    points={record.rate}
                    color={delta > 0 ? palette.warning : palette.gen0}
                  />
                </td>
                <td className={`num ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'dim'}`}>
                  {delta === 0 ? '—' : `${delta > 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}/s`}
                </td>
                <td className="num">{formatBytes(record.totalBytes)}</td>
                <td className="num">{formatBytes(record.averageObjectBytes)}</td>
                <td className="num dim">{record.tickCount.toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {filtered.length > 300 && (
        <p className="empty-note">Showing the top 300 of {filtered.length} types. Filter to narrow the list.</p>
      )}
    </div>
  );
}
