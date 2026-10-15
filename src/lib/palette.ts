/**
 * The palette, in one place so CSS and canvas charts cannot disagree.
 *
 * The colours are drawn from the runtime's own vocabulary: the heap generation ramp is the
 * ordering that matters (Gen 0 churns, Gen 2 accumulates, LOH is a different animal), so
 * the ramp moves from a cool, fast hue to a warm, heavy one.
 */

export const palette = {
  /** Generation ramp, ordered by how long objects survive in it. */
  gen0: '#57C7B8',
  gen1: '#6E9BE0',
  gen2: '#F2A93B',
  loh: '#DE6A54',
  poh: '#A98BDD',

  /** Semantic colours for findings and thresholds. */
  critical: '#E7654F',
  warning: '#E9A63A',
  info: '#5CB2D9',
  good: '#5FBF8F',

  /** Chart series for counters that are not heap generations. */
  workingSet: '#7FCFE0',
  committed: '#8A93A8',
  allocRate: '#C99BE0',
  gcPause: '#E0B060',
  cpu: '#9BD37F',
  neutral: '#8B9AA1',
} as const;

export const severityColor = (severity: string): string => {
  switch (severity) {
    case 'critical':
      return palette.critical;
    case 'warning':
      return palette.warning;
    case 'info':
      return palette.info;
    case 'good':
      return palette.good;
    default:
      return palette.neutral;
  }
};

/** Heap region colours, keyed by the field names used in `HeapSnapshotPoint`. */
export const heapColors: Record<string, string> = {
  gen0: palette.gen0,
  gen1: palette.gen1,
  gen2: palette.gen2,
  loh: palette.loh,
  poh: palette.poh,
};

export const heapLabels: Record<string, string> = {
  gen0: 'Gen 0',
  gen1: 'Gen 1',
  gen2: 'Gen 2',
  loh: 'LOH',
  poh: 'POH',
};
