import { useState } from 'react';

import { formatBytes, formatDuration, formatTimecode } from '../lib/format';
import type { PlaybackStatusEvent } from '../lib/types';

/** Offered speeds. 240x turns a four hour session into a minute. */
const SPEEDS = [0.25, 0.5, 1, 2, 8, 32, 240];

const STATE_LABEL: Record<PlaybackStatusEvent['state'], string> = {
  loading: 'Opening',
  playing: 'Replay',
  paused: 'Paused',
  stopped: 'Stopped',
  finished: 'End of recording',
  failed: 'Replay failed',
};

interface Props {
  playback: PlaybackStatusEvent;
  error: string | null;
  onPause: () => void;
  onResume: () => void;
  onSpeedChange: (speed: number) => void;
  onSeek: (positionMs: number) => void;
  onStop: () => void;
  onRestart: () => void;
  onClose: () => void;
}

/**
 * The replay transport.
 *
 * It is deliberately not part of the tab strip: a replay is a *mode* of the whole app, and
 * every panel below is showing recorded data. Making that unmistakable matters more than it
 * might seem — a user who mistakes a replay for a live process will draw the wrong
 * conclusion about a service that is currently fine.
 */
export function PlaybackBar({
  playback,
  error,
  onPause,
  onResume,
  onSpeedChange,
  onSeek,
  onStop,
  onRestart,
  onClose,
}: Props) {
  const { recording, state } = playback;
  const running = state === 'playing' || state === 'loading';
  const ended = state === 'finished' || state === 'stopped' || state === 'failed';

  // Scrubbing is committed on release rather than on every change: each seek restarts the
  // replay, and doing that per pointer move would thrash the host and the charts.
  const [scrub, setScrub] = useState<number | null>(null);
  const position = scrub ?? playback.positionMs;

  const speeds = SPEEDS.includes(playback.speed)
    ? SPEEDS
    : [...SPEEDS, playback.speed].sort((a, b) => a - b);

  const commitScrub = () => {
    if (scrub === null) return;
    onSeek(scrub);
    setScrub(null);
  };

  return (
    <div className={`playback-bar playback-${state}`}>
      <div className="playback-identity">
        <span className="playback-badge">
          <span className="playback-dot" />
          {STATE_LABEL[state]}
        </span>

        <span className="playback-file" title={recording.path}>
          {recording.fileName}
        </span>

        <span className="playback-meta">
          {recording.targetName ?? 'unknown process'}
          {recording.targetPid ? ` · pid ${recording.targetPid}` : ''}
          {` · ${formatDuration(recording.durationMs)} captured · ${formatBytes(recording.sizeBytes)} · ${recording.messageCount.toLocaleString()} messages`}
        </span>

        {!recording.complete && (
          <span className="tag tag-warn" title="No footer was written: the recording was interrupted, and its tail may be missing.">
            incomplete
          </span>
        )}
        {recording.startedMidSession && (
          <span className="tag" title="Recording began after attaching, so the start of the session is not in this file.">
            starts mid-session
          </span>
        )}
        {recording.skippedLines > 0 && (
          <span className="tag" title="Lines that could not be parsed were skipped.">
            {recording.skippedLines} skipped lines
          </span>
        )}
      </div>

      <div className="playback-transport">
        <button
          type="button"
          className="btn btn-sm"
          onClick={running ? onPause : onResume}
          disabled={ended}
        >
          {running ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onRestart}>
          Restart
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onStop} disabled={ended}>
          Stop
        </button>

        <input
          className="playback-scrub"
          type="range"
          min={0}
          max={Math.max(1, playback.durationMs)}
          step={100}
          value={Math.min(position, Math.max(1, playback.durationMs))}
          aria-label="Replay position"
          onChange={(event) => setScrub(Number(event.target.value))}
          onPointerUp={commitScrub}
          onKeyUp={commitScrub}
          onBlur={commitScrub}
          disabled={playback.durationMs <= 0}
        />

        <span className="playback-time">
          {formatTimecode(position)} / {formatTimecode(playback.durationMs)}
        </span>

        <label className="playback-speed">
          <span className="field-label">Speed</span>
          <select
            className="input input-sm"
            value={String(playback.speed)}
            onChange={(event) => onSpeedChange(Number(event.target.value))}
          >
            {speeds.map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>

        <span className="playback-emitted" title="Envelopes delivered from the recording so far">
          {playback.emitted.toLocaleString()} events
        </span>

        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          Close replay
        </button>
      </div>

      {error && <div className="inline-error inline-error-wide">{error}</div>}
    </div>
  );
}
