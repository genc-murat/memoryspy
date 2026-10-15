import type { CanonicalUnit, CounterReading } from './types';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Formats a byte count with a fixed number of significant decimals per magnitude.
 *
 * Deliberately not using `toLocaleString` for the value itself: the UI shows these numbers
 * side by side in tabular columns, and locale-dependent grouping would make the columns
 * ragged for some users.
 */
export function formatBytes(bytes: number, decimals?: number): string {
  if (!Number.isFinite(bytes)) return '—';

  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);

  let index = 0;
  let value = abs;
  while (value >= 1024 && index < BYTE_UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }

  const digits = decimals ?? (index === 0 ? 0 : value >= 100 ? 1 : 2);
  return `${sign}${value.toFixed(digits)} ${BYTE_UNITS[index]}`;
}

/** Byte count without a unit suffix, for chart axis labels. */
export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)}T`;
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(abs >= 10 * 1024 ** 3 ? 0 : 1)}G`;
  if (abs >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(abs >= 100 * 1024 ** 2 ? 0 : 1)}M`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${Math.round(bytes)}B`;
}

/** A rate in bytes per second, which is the unit that makes leaks comparable. */
export function formatBytesPerSecond(value: number): string {
  return `${formatBytesCompact(value)}/s`;
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

export function formatCount(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

export function formatMilliseconds(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(value >= 10 ? 1 : 2)} ms`;
}

/** Human readable duration from milliseconds, e.g. "1h 04m" or "42s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${(seconds % 60).toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, '0')}m`;
}

/**
 * Timecode for a recording's own timeline, e.g. "04:12" or "1:02:45".
 *
 * Deliberately not a clock time: a replay's position is an offset into the recording, and
 * labelling it 14:32 would invite the reader to compare it with the wall clock.
 */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => value.toString().padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** How long ago something happened, e.g. "26h ago". */
export function formatAge(unixMs: number, now = Date.now()): string {
  const seconds = Math.floor((now - unixMs) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function formatClock(unixMs: number): string {
  return new Date(unixMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Formats any counter according to the canonical unit the collector assigned it. */
export function formatCounter(reading: Pick<CounterReading, 'value' | 'unit'>, decimals?: number): string {
  const unit: CanonicalUnit | string = reading.unit;
  switch (unit) {
    case 'bytes':
      return formatBytes(reading.value, decimals);
    case 'bytes-per-second':
      return formatBytesPerSecond(reading.value);
    case 'percent':
      return formatPercent(reading.value, decimals ?? 1);
    case 'ms':
      return formatMilliseconds(reading.value);
    case 'count':
      return formatCount(reading.value);
    default:
      return formatCount(reading.value);
  }
}

/** Short form used on chart axes and dense tables. */
export function formatCounterCompact(reading: Pick<CounterReading, 'value' | 'unit'>): string {
  switch (reading.unit) {
    case 'bytes':
      return formatBytesCompact(reading.value);
    case 'bytes-per-second':
      return formatBytesPerSecond(reading.value);
    case 'percent':
      return `${reading.value.toFixed(0)}%`;
    case 'ms':
      return `${reading.value.toFixed(0)}ms`;
    default:
      return formatCount(reading.value);
  }
}

/**
 * The last segment of a path recorded in a PDB: "OrderRepository.cs".
 *
 * Split on both separators because a PDB carries the path the compiler saw, which may be a
 * Windows path even when the analysis runs on macOS or Linux.
 */
export function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * A source location as "OrderRepository.cs:412", or null when no PDB supplied one.
 *
 * Null is the honest answer rather than a placeholder: a site without a PDB is named by its
 * method, and the caller decides how to show that it could not be located.
 */
export function formatSourceLocation(
  sourceFile: string | null | undefined,
  sourceLine: number | null | undefined,
): string | null {
  if (!sourceFile) return null;
  return sourceLine == null ? fileNameOf(sourceFile) : `${fileNameOf(sourceFile)}:${sourceLine}`;
}

/** Full source path and line, for a tooltip that can be pasted into an editor. */
export function formatSourcePath(
  sourceFile: string | null | undefined,
  sourceLine: number | null | undefined,
): string | null {
  if (!sourceFile) return null;
  return sourceLine == null ? sourceFile : `${sourceFile}:${sourceLine}`;
}

/**
 * A trend expressed as a signed rate. Kept separate from `formatBytesPerSecond` because
 * the sign carries the meaning here — "+412 MB/min" vs "-8 MB/min".
 */export function formatSignedRate(bytesPerSecond: number, unit: 'min' | 's' = 'min'): string {
  const scaled = unit === 'min' ? bytesPerSecond * 60 : bytesPerSecond;
  const sign = scaled > 0 ? '+' : scaled < 0 ? '−' : '';
  return `${sign}${formatBytesCompact(Math.abs(scaled))}/${unit}`;
}
