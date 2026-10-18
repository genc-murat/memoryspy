/**
 * The parts of the rail that should survive a restart: which containers are open, which target
 * the last session was attached to, and how far the rail was scrolled.
 *
 * Kept in the webview's localStorage rather than the host settings file on purpose. It describes
 * what the rail looked like, not how the app behaves, and writing the settings file on every
 * expand/collapse would make an inspectable config churn for a purely visual choice. Reads are
 * validated because an old or hand-edited value must not break the rail — the worst outcome here
 * is starting with everything collapsed.
 */

const KEY = 'memoryspy.rail.v1';

/**
 * Longest offset accepted from storage. A rail that long is not realistic, and a hand-edited
 * number should not leave it scrolled far past its content.
 */
const MAX_SCROLL_TOP = 1_000_000;

/** The target a session was last attached to, with the container it lived in (if any). */
export interface LastTarget {
  pid: number;
  name: string;
  /** `null` for a process on this machine; the container name otherwise. */
  container: string | null;
  atUnixMs: number;
}

export interface RailState {
  expandedContainers: string[];
  lastTarget: LastTarget | null;
  /** How far the rail was scrolled, so it opens on the section that was in use. */
  scrollTop: number;
}

const EMPTY: RailState = { expandedContainers: [], lastTarget: null, scrollTop: 0 };

function readLastTarget(value: unknown): LastTarget | null {
  if (!value || typeof value !== 'object') return null;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.pid !== 'number' || !Number.isInteger(candidate.pid) || candidate.pid <= 0) {
    return null;
  }
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') return null;

  return {
    pid: candidate.pid,
    name: candidate.name,
    container:
      typeof candidate.container === 'string' && candidate.container.trim() !== ''
        ? candidate.container
        : null,
    atUnixMs: typeof candidate.atUnixMs === 'number' ? candidate.atUnixMs : 0,
  };
}

export function loadRailState(): RailState {
  if (typeof window === 'undefined') return EMPTY;

  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY;

    const record = parsed as Record<string, unknown>;
    const expanded = Array.isArray(record.expandedContainers)
      ? record.expandedContainers.filter(
          (name): name is string => typeof name === 'string' && name.trim() !== '',
        )
      : [];

    return {
      expandedContainers: [...new Set(expanded)],
      lastTarget: readLastTarget(record.lastTarget),
      scrollTop:
        typeof record.scrollTop === 'number' && Number.isFinite(record.scrollTop)
          ? Math.min(Math.max(record.scrollTop, 0), MAX_SCROLL_TOP)
          : 0,
    };
  } catch {
    // A corrupt value is not worth reporting: the rail simply starts collapsed.
    return EMPTY;
  }
}

function saveRailState(state: RailState) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (quota, a locked-down webview). Losing the layout is not an
    // error the user needs to see.
  }
}

/** Updates one half of the state without dropping the other. */
export function patchRailState(patch: Partial<RailState>) {
  saveRailState({ ...loadRailState(), ...patch });
}
