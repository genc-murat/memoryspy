import type { Point } from '../lib/store';

interface Props {
  points: Point[];
  color: string;
  width?: number;
  height?: number;
}

/**
 * A 90x20 inline SVG sparkline used in table rows.
 *
 * SVG rather than canvas here: these are small, there are many of them, and they need to
 * line up pixel-perfectly with the text baseline in a table cell.
 */
export function Sparkline({ points, color, width = 92, height = 20 }: Props) {
  if (points.length < 2) {
    return <span className="sparkline-empty" style={{ width, height }} />;
  }

  const values = points.map((point) => point.v);
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const range = max - min || 1;

  const step = width / (points.length - 1);
  const path = points
    .map((point, index) => {
      const x = index * step;
      const y = height - ((point.v - min) / range) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const areaPath = `${path} L${width},${height} L0,${height} Z`;
  const id = `spark-${color.replace('#', '')}`;

  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${id})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
