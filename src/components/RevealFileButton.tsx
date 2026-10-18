import { useEffect, useState } from 'react';

import { api } from '../lib/ipc';

/** The file manager each platform ships, named the way its users know it. */
const REVEAL_LABEL =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
    ? 'Show in Finder'
    : typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent)
      ? 'Show in Explorer'
      : 'Show in folder';

interface Props {
  path: string;
  /** Extra classes for callers whose row has its own spacing or emphasis. */
  className?: string;
  /**
   * Lets the caller own the failure note instead of printing it under the button.
   *
   * Called with `null` after a successful reveal, so a stale "moved or deleted" does not
   * outlive the file it described.
   */
  onError?: (message: string | null) => void;
}

/**
 * Takes the user from an artifact's path to the file itself.
 *
 * The host does the work: a webview cannot launch Finder or Explorer, and only the host can
 * answer "that file is gone" in wording the UI can show. That answer is deliberately rendered
 * next to the path the user clicked rather than in a general error slot — a moved capture says
 * nothing about the process list or the recordings library.
 */
export function RevealFileButton({ path, className, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new artifact makes an old message about another file, so it is cleared with the path.
  useEffect(() => setError(null), [path]);

  const reveal = async () => {
    setBusy(true);
    try {
      await api.revealInFolder(path);
      setError(null);
      onError?.(null);
    } catch (revealError) {
      const message = revealError instanceof Error ? revealError.message : String(revealError);
      if (onError) onError(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`btn btn-ghost btn-sm reveal-button${className ? ` ${className}` : ''}`}
        onClick={() => void reveal()}
        disabled={busy}
        title={path}
      >
        {busy ? 'Opening…' : REVEAL_LABEL}
      </button>
      {error && <p className="rail-note rail-note-warn reveal-error">{error}</p>}
    </>
  );
}
