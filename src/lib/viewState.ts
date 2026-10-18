/**
 * The part of the main view that should survive a restart: the tab that was open, and how far
 * each tab had been scrolled.
 *
 * Kept in the webview's localStorage beside the rail layout, for the same reason: it describes
 * how the workspace looked, not how the app behaves, so writing the host settings file on every
 * scroll would make an inspectable config churn. Reads are validated because an old or
 * hand-edited value must not stop the window from opening — the worst outcome here is the
 * default tab at the top.
 */

const KEY = 'memoryspy.view.v1';

/**
 * Longest offset accepted from storage.
 *
 * A tab can legitimately be tall, but a hand-edited or corrupted number should not leave the
 * window scrolled a million pixels past its content.
 */
const MAX_SCROLL_TOP = 1_000_000;

export interface ViewState {
  /** The open tab, by panel id. */
  panel: string;
  /**
   * Scroll offset per panel id, so a tab is returned to where it was rather than to another
   * tab's offset — every tab shares one scroll container.
   */
  scrollTops: Record<string, number>;
}

const EMPTY: ViewState = { panel: 'overview', scrollTops: {} };

function readScrollTops(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};

  const result: Record<string, number> = {};
  for (const [panel, top] of Object.entries(value as Record<string, unknown>)) {
    if (panel.trim() === '') continue;
    if (typeof top !== 'number' || !Number.isFinite(top) || top < 0) continue;
    result[panel] = Math.min(top, MAX_SCROLL_TOP);
  }
  return result;
}

export function loadViewState(): ViewState {
  if (typeof window === 'undefined') return EMPTY;

  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY;

    const record = parsed as Record<string, unknown>;
    return {
      panel:
        typeof record.panel === 'string' && record.panel.trim() !== ''
          ? record.panel
          : EMPTY.panel,
      scrollTops: readScrollTops(record.scrollTops),
    };
  } catch {
    // A corrupt value is not worth reporting: the window simply opens on the default tab.
    return EMPTY;
  }
}

function saveViewState(state: ViewState) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (quota, a locked-down webview). Losing the position is not an
    // error the user needs to see.
  }
}

/** Updates part of the state without dropping the other half. */
export function patchViewState(patch: Partial<ViewState>) {
  saveViewState({ ...loadViewState(), ...patch });
}
