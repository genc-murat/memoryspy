import { formatBytes, formatPercent } from '../lib/format';
import { heapColors, heapLabels } from '../lib/palette';
import type { HeapSnapshotPoint } from '../lib/store';

interface Props {
  heap: HeapSnapshotPoint | undefined;
  /** Signed growth of the managed heap in bytes per minute. */
  growthPerMinute: number | null;
  /** 0..1 confidence of the growth fit. */
  confidence: number;
  history: HeapSnapshotPoint[];
}

const SEGMENTS = ['gen0', 'gen1', 'gen2', 'loh', 'poh'] as const;

/**
 * The signature instrument: a live stack of the managed heap that never leaves the screen.
 *
 * The reason it exists is that a leak is a *shape over time*, and shape is exactly what a
 * table of numbers hides. The vertical extent answers "how big", the segment boundaries
 * answer "which generation", and the needle on the left answers the question the tool was
 * built for: "how fast is it growing, right now".
 */
export function Spine({ heap, growthPerMinute, confidence, history }: Props) {
  const total = heap?.total ?? 0;
  const segments = SEGMENTS.map((key) => ({
    key,
    label: heapLabels[key],
    color: heapColors[key],
    bytes: heap ? heap[key] : 0,
  }));

  // The bounding "budget" is the largest heap seen in the retained window, so the bar
  // visibly grows and shrinks instead of always sitting at 100%.
  const peak = Math.max(total, ...history.map((point) => point.total), 1);

  const isGrowing = growthPerMinute !== null && growthPerMinute > 0.5 * 1024 * 1024;
  const severity = !isGrowing ? 'flat' : confidence < 0.45 ? 'unclear' : growthPerMinute! > 50 * 1024 * 1024 ? 'critical' : 'warning';

  return (
    <div className={`spine spine-${severity}`}>
      <div className="spine-head">
        <span className="eyebrow">Managed heap</span>
        <span className="spine-total">{heap ? formatBytes(total) : '—'}</span>
      </div>

      {/*
       * The bar is measured against the peak, not against 100%, so the scale is named here. An
       * unlabelled block of colour is a shape a reader can only guess the size of.
       */}
      <div className="spine-scale">
        <span className="spine-scale-peak">peak {heap ? formatBytes(peak) : '—'}</span>
        <span className="spine-scale-now">
          {heap && peak > 0 && total > 0 ? `${Math.round((total / peak) * 100)}% of peak` : '—'}
        </span>
      </div>

      <div className="spine-bar" role="img" aria-label="Managed heap composition by generation">
        {segments.map((segment) => {
          const heightPercent = peak > 0 ? (segment.bytes / peak) * 100 : 0;
          return (
            <div
              key={segment.key}
              className="spine-segment"
              style={{ height: `${Math.max(heightPercent, segment.bytes > 0 ? 0.6 : 0)}%`, background: segment.color }}
              title={`${segment.label}: ${formatBytes(segment.bytes)}`}
            />
          );
        })}
      </div>

      <div className="spine-growth">
        <span className="spine-growth-value">
          {growthPerMinute === null
            ? '—'
            : `${growthPerMinute > 0 ? '+' : '−'}${formatBytes(Math.abs(growthPerMinute))}/min`}
        </span>
        <span className="spine-growth-label">
          {growthPerMinute === null
            ? 'waiting for samples'
            : confidence < 0.45
              ? 'noisy — trending unclear'
              : isGrowing
                ? 'heap is growing'
                : 'heap is stable'}
        </span>
      </div>

      <ul className="spine-legend">
        {segments
          .slice()
          .reverse()
          .map((segment) => (
            <li key={segment.key}>
              <span className="legend-swatch" style={{ background: segment.color }} />
              <span className="legend-label">{segment.label}</span>
              {/* The share rides inside the value cell: a fourth grid column squeezed the label
                  ("Gen 2" broke across two lines), and the row has no width to spare. */}
              <span className="legend-value">
                {heap && total > 0 && segment.bytes > 0 && (
                  <span className="legend-share">{formatPercent((segment.bytes / total) * 100, 1)}</span>
                )}
                {heap ? formatBytes(segment.bytes) : '—'}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}
