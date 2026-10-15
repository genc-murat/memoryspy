import { formatBytes, formatBytesPerSecond, formatCounter } from '../lib/format';
import { CATEGORY_ORDER, type CounterSeries } from '../lib/store';

/**
 * Formats a change between the start and the end of the visible window using the counter's
 * own unit. A byte gauge that rose 30 MB reads as "+30.0 MB", not "+30 MB/s" — the rate is a
 * different measurement and presenting it here would invite misreading the card.
 */
function formatDelta(unit: string, magnitude: number): string {
  switch (unit) {
    case 'bytes':
      return formatBytes(magnitude);
    case 'bytes-per-second':
      return formatBytesPerSecond(magnitude);
    case 'percent':
      return `${magnitude.toFixed(2)} pp`;
    case 'ms':
      return `${magnitude.toFixed(1)} ms`;
    default:
      return magnitude >= 10 ? magnitude.toFixed(0) : magnitude.toFixed(1);
  }
}

interface Props {
  counters: CounterSeries[];
  showAll: boolean;
  selected: string | null;
  onSelect: (name: string) => void;
}

function trendOf(series: CounterSeries): number | null {
  const points = series.points;
  if (points.length < 6) return null;

  // Compare the mean of the last third against the mean of the first third. A slope fit
  // would be more precise, but for a small readout the difference of means is far less
  // sensitive to one outlier sample.
  const third = Math.max(2, Math.floor(points.length / 3));
  const head = points.slice(0, third);
  const tail = points.slice(-third);
  const mean = (values: typeof points) => values.reduce((sum, point) => sum + point.v, 0) / values.length;

  return mean(tail) - mean(head);
}

function statusOf(series: CounterSeries, value: number): 'ok' | 'warn' | 'critical' {
  const { warnAbove, criticalAbove } = series.meta;
  if (criticalAbove != null && value >= criticalAbove) return 'critical';
  if (warnAbove != null && value >= warnAbove) return 'warn';
  return 'ok';
}

export function CounterGrid({ counters, showAll, selected, onSelect }: Props) {
  const visible = counters.filter((series) => showAll || series.meta.category !== 'Other');
  const grouped = new Map<string, CounterSeries[]>();

  for (const series of visible) {
    const list = grouped.get(series.meta.category) ?? [];
    list.push(series);
    grouped.set(series.meta.category, list);
  }

  const orderedCategories = [
    ...CATEGORY_ORDER.filter((category) => grouped.has(category)),
    ...[...grouped.keys()].filter((category) => !CATEGORY_ORDER.includes(category as (typeof CATEGORY_ORDER)[number])),
  ];

  if (visible.length === 0) {
    return <p className="empty-note">No counters received yet. Attach to a process to start collecting.</p>;
  }

  return (
    <div className="counter-grid-wrap">
      {orderedCategories.map((category) => (
        <section className="counter-group" key={category}>
          <h3 className="counter-group-title">{category}</h3>
          <div className="counter-grid">
            {(grouped.get(category) ?? []).map((series) => {
              const value = series.points[series.points.length - 1]?.v ?? 0;
              const delta = trendOf(series);
              const status = statusOf(series, value);

              return (
                <button
                  type="button"
                  key={series.meta.name}
                  className={`counter-card counter-${status}${selected === series.meta.name ? ' is-selected' : ''}${
                    series.meta.isMemory ? ' is-memory' : ''
                  }`}
                  onClick={() => onSelect(series.meta.name)}
                  title={series.meta.description ?? undefined}
                >
                  <span className="counter-category">{series.meta.displayName}</span>
                  <span className="counter-value">{formatCounter(series.meta)}</span>
                  <span className="counter-foot">
                    <span className="counter-key">{series.meta.name}</span>
                    {delta !== null && Math.abs(delta) > 0 && (
                      <span className={`counter-delta ${delta > 0 ? 'up' : 'down'}`}>
                        {delta > 0 ? '▲' : '▼'} {formatDelta(series.meta.unit, Math.abs(delta))}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
