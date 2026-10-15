import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Point } from '../lib/store';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: Point[];
  /** Draw as a filled area under the line. Only sensible for a single series. */
  fill?: boolean;
  /** Hide from the hover readout but keep it drawn. */
  muted?: boolean;
}

interface Props {
  series: ChartSeries[];
  height?: number;
  /** Formats a value for the axis and the hover readout. */
  format: (value: number) => string;
  /** Force the y axis to start at zero, which is almost always right for memory. */
  zeroBased?: boolean;
  /**
   * Which number system the ticks should be round in. Byte charts are formatted in binary units
   * (KiB/MiB/GiB), so they need `binary`; anything measured in milliseconds, counts or percent
   * wants the decimal ladder.
   */
  stepBase?: StepBase;
  emptyMessage?: string;
}

interface HoverState {
  x: number;
  /** Index into the longest series. */
  index: number;
  values: { series: ChartSeries; value: number | null }[];
  at: number;
}

interface Domain {
  min: number;
  max: number;
  step: number;
}

/** The number system the tick step should be round in. See {@link niceStep}. */
export type StepBase = 'decimal' | 'binary';

/**
 * A step that is round in the units the axis actually prints.
 *
 * `decimal` gives 1, 2, 2.5 or 5 times a power of ten. `binary` gives 1, 2, 4 or 8 times a power
 * of two, because a byte axis is labelled in KiB/MiB/GiB: a decimal step of 50 000 000 bytes is
 * drawn as `47.7M`, so a perfectly even ladder reads as arbitrary digits. Matching the step to the
 * units is what makes the labels recognisable.
 */
function niceStep(rawStep: number, base: StepBase): number {
  const safe = rawStep > 0 ? rawStep : 1;

  if (base === 'binary') {
    const power = 2 ** Math.floor(Math.log2(safe));
    for (const multiple of [1, 2, 4, 8]) {
      const candidate = multiple * power;
      if (candidate >= safe) return candidate;
    }
    return 16 * power;
  }

  const magnitude = 10 ** Math.floor(Math.log10(safe));
  const normalized = safe / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
}

/**
 * A tick ladder of round numbers.
 *
 * A chart is read by comparing the newest point against a labelled gridline, so the labels have to
 * be numbers a reader recognises — 1, 2, 2.5 or 5 times a power of ten. Dividing the data range
 * into equal parts instead yields labels like `208M / 415M / 623M`, which have to be read digit by
 * digit, and it lets a floor that is not zero through. That is exactly how a byte axis ended up
 * labelled `−76 B`: a noisy Gen 0 counter dipping a few bytes below zero dragged the floor with it.
 *
 * So a zero-based chart — which is what every memory series in this app is — pins the floor at
 * exactly zero, and the top is rounded up to the next step so the newest point never touches the
 * frame. A chart that genuinely straddles zero (`zeroBased: false`) keeps a floor below zero and
 * rounds it down to a step instead.
 */
function niceDomain(min: number, max: number, targetTicks: number, zeroBased: boolean, stepBase: StepBase): Domain {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.25 };
  if (max <= min) max = min + 1;

  const step = niceStep((max - min) / targetTicks, stepBase);

  const floor = zeroBased ? 0 : Math.floor(min / step) * step;
  let ceiling = Math.ceil(max / step) * step;
  if (ceiling <= max) ceiling += step;

  return { min: floor, max: ceiling, step };
}

/**
 * A canvas time series chart.
 *
 * Canvas rather than SVG because the app repaints several of these at ~8 fps while the
 * target process is under load; hundreds of DOM nodes per chart would be the first thing to
 * stutter. The component owns its own drawing and only re-renders on a data version bump.
 */
export function TimeSeriesChart({
  series,
  height = 220,
  format,
  zeroBased = true,
  stepBase = 'decimal',
  emptyMessage,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [size, setSize] = useState({ width: 640, height });

  // Track the wrapper's size so the canvas stays crisp on window resize and panel splits.
  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;

    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: Math.max(160, rect.width), height });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [height]);

  const drawnSeries = series.filter((s) => s.points.length > 1);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const { width, height: h } = size;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);

    const padding = { top: 12, right: 68, bottom: 22, left: 8 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = h - padding.top - padding.bottom;

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    if (drawnSeries.length === 0) {
      ctx.fillStyle = 'rgba(139, 154, 161, 0.85)';
      ctx.textAlign = 'center';
      ctx.fillText(emptyMessage ?? 'Waiting for samples…', width / 2, h / 2);
      return;
    }

    // ---- Domain ---------------------------------------------------------------------
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const s of drawnSeries) {
      for (const point of s.points) {
        if (point.t < minX) minX = point.t;
        if (point.t > maxX) maxX = point.t;
        if (point.v < minY) minY = point.v;
        if (point.v > maxY) maxY = point.v;
      }
    }

    // A flat series, or a single sample, would divide by zero on the y scale.
    if (maxY === minY) maxY = minY + 1;

    const domain = niceDomain(minY, maxY, 4, zeroBased, stepBase);
    const spanX = Math.max(1, maxX - minX);

    const scaleX = (t: number) => padding.left + ((t - minX) / spanX) * plotWidth;
    const scaleY = (v: number) => padding.top + plotHeight - ((v - domain.min) / (domain.max - domain.min)) * plotHeight;

    // ---- Grid and axis labels -------------------------------------------------------
    const ticks = Math.max(1, Math.round((domain.max - domain.min) / domain.step));
    ctx.textAlign = 'right';
    for (let i = 0; i <= ticks; i += 1) {
      const value = domain.min + i * domain.step;
      const y = scaleY(value);

      ctx.strokeStyle = 'rgba(120, 140, 150, 0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, Math.round(y) + 0.5);
      ctx.lineTo(padding.left + plotWidth, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = 'rgba(139, 154, 161, 0.9)';
      ctx.fillText(format(value), width - 6, y);
    }

    // ---- Series ---------------------------------------------------------------------
    for (const s of drawnSeries) {
      const points = s.points;

      if (s.fill) {
        const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotHeight);
        gradient.addColorStop(0, `${s.color}44`);
        gradient.addColorStop(1, `${s.color}05`);

        ctx.beginPath();
        ctx.moveTo(scaleX(points[0].t), scaleY(domain.min));
        for (const point of points) ctx.lineTo(scaleX(point.t), scaleY(point.v));
        ctx.lineTo(scaleX(points[points.length - 1].t), scaleY(domain.min));
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.7;
      ctx.lineJoin = 'round';
      for (let i = 0; i < points.length; i += 1) {
        const x = scaleX(points[i].t);
        const y = scaleY(points[i].v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // A dot on the newest point anchors the eye at "now".
      const last = points[points.length - 1];
      ctx.beginPath();
      ctx.arc(scaleX(last.t), scaleY(last.v), 2.6, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    }

    // ---- Hover crosshair -------------------------------------------------------------
    if (hover) {
      const x = Math.max(padding.left, Math.min(padding.left + plotWidth, hover.x));
      ctx.strokeStyle = 'rgba(230, 237, 240, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, padding.top);
      ctx.lineTo(Math.round(x) + 0.5, padding.top + plotHeight);
      ctx.stroke();

      for (const entry of hover.values) {
        if (entry.value === null) continue;
        const y = scaleY(entry.value);
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = entry.series.color;
        ctx.fill();
        ctx.strokeStyle = '#0E1214';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }
  }, [size, series, format, zeroBased, stepBase, hover, emptyMessage, drawnSeries]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handlePointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || drawnSeries.length === 0) return;

      const rect = canvas.getBoundingClientRect();
      const padding = { right: 68, left: 8 };
      const plotWidth = rect.width - padding.left - padding.right;
      const x = Math.max(padding.left, Math.min(padding.left + plotWidth, event.clientX - rect.left));

      // Pick the series with the most points as the reference timeline, then read the value
      // of every series at the nearest timestamp.
      const reference = drawnSeries.reduce((best, s) => (s.points.length > best.points.length ? s : best), drawnSeries[0]);
      let minX = Infinity;
      let maxX = -Infinity;
      for (const s of drawnSeries) {
        for (const point of s.points) {
          if (point.t < minX) minX = point.t;
          if (point.t > maxX) maxX = point.t;
        }
      }
      const spanX = Math.max(1, maxX - minX);
      const targetTime = minX + ((x - padding.left) / plotWidth) * spanX;

      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < reference.points.length; i += 1) {
        const distance = Math.abs(reference.points[i].t - targetTime);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }

      const at = reference.points[bestIndex].t;
      const values = drawnSeries.map((s) => {
        let nearest: Point | null = null;
        let nearestDistance = Infinity;
        for (const point of s.points) {
          const distance = Math.abs(point.t - at);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = point;
          }
        }
        return { series: s, value: nearest ? nearest.v : null };
      });

      setHover({ x, index: bestIndex, values, at });
    },
    [drawnSeries],
  );

  return (
    <div className="chart" ref={wrapperRef}>
      <canvas ref={canvasRef} className="chart-canvas" />
      <div
        className="chart-hit"
        onPointerMove={handlePointer}
        onPointerLeave={() => setHover(null)}
        role="presentation"
      />
      {hover && (
        <div
          className="chart-tooltip"
          style={{ left: Math.min(Math.max(hover.x + 12, 8), Math.max(8, size.width - 190)) }}
        >
          <div className="chart-tooltip-time">{new Date(hover.at).toLocaleTimeString()}</div>
          {hover.values.map((entry) => (
            <div className="chart-tooltip-row" key={entry.series.key}>
              <span className="chart-tooltip-swatch" style={{ background: entry.series.color }} />
              <span className="chart-tooltip-label">{entry.series.label}</span>
              <span className="chart-tooltip-value">{entry.value === null ? '—' : format(entry.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
