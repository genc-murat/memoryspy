import { useCallback, useEffect, useState } from 'react';

import { formatBytes } from '../lib/format';
import { api } from '../lib/ipc';
import type { ContainerStaging, DockerCollectorVariant, DockerStatus } from '../lib/types';

interface Props {
  docker: DockerStatus | null;
  onRefresh: () => Promise<void>;
}

/** The publisher takes the glibc RID plus a libc name, even when the output is the musl build. */
function republishCommand(rid: string): string {
  return `npm run collector:docker -- ${rid.replace('-musl', '')} musl`;
}

/** The variant being repaired. The host does the work; this names the row to put a busy state on. */
interface RepairState {
  rid: string;
}

function publishedCell(variant: DockerCollectorVariant) {
  return variant.published ? (
    <span className="chip chip-good">published</span>
  ) : (
    <span className="chip chip-quiet">not published</span>
  );
}

function runtimeCell(variant: DockerCollectorVariant) {
  if (!variant.published) {
    return <span className="dim">—</span>;
  }
  if (variant.libc === 'glibc') {
    return <span className="dim">provided by the image</span>;
  }
  return variant.runtimeMissing ? (
    <span className="chip chip-warning">missing</span>
  ) : (
    <span className="chip chip-good">bundled</span>
  );
}

/**
 * Environment diagnostics for container targets.
 *
 * Every other view explains a running session; this one explains why there may not be one. It
 * separates the three failures that otherwise all look like "containers do not work": Docker is
 * not reachable, no Linux collector has been published, or a musl build was published without the
 * C++ runtime a bare Alpine image does not provide.
 */
export function ContainerSupportPanel({ docker, onRefresh }: Props) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState<RepairState | null>(null);
  const [repaired, setRepaired] = useState<string[]>([]);
  const [repairError, setRepairError] = useState<{ rid: string; message: string } | null>(null);
  const [staging, setStaging] = useState<ContainerStaging[] | null>(null);
  const [stagingBusy, setStagingBusy] = useState(false);
  const [stagingError, setStagingError] = useState<string | null>(null);
  const [pruning, setPruning] = useState<string | null>(null);
  const [pruneError, setPruneError] = useState<{ container: string; message: string } | null>(null);
  const [pruned, setPruned] = useState<{ container: string; bytes: number } | null>(null);

  const dockerUsable = docker?.available === true;

  const loadStaging = useCallback(async () => {
    setStagingBusy(true);
    setStagingError(null);
    try {
      setStaging(await api.dockerStaging());
    } catch (error) {
      setStagingError(error instanceof Error ? error.message : String(error));
    } finally {
      setStagingBusy(false);
    }
  }, []);

  // Measured when the view opens rather than at startup: one `docker exec` per running
  // container is fine here and too much to pay for on every app launch.
  useEffect(() => {
    if (dockerUsable) void loadStaging();
  }, [dockerUsable, loadStaging]);

  const prune = async (container: string) => {
    setPruneError(null);
    setPruning(container);
    try {
      const before = staging?.find((row) => row.container === container);
      const after = await api.pruneDockerStaging(container);
      setStaging((current) =>
        current?.map((row) => (row.container === container ? after : row)) ?? null,
      );
      if (after.error) {
        // The removal succeeded but the container stopped answering before the re-measure; the
        // new usage is unknown, so claiming a number would be a guess.
        setPruneError({ container, message: after.error });
      } else {
        setPruned({
          container,
          bytes: Math.max(0, (before?.totalBytes ?? 0) - after.totalBytes),
        });
      }
    } catch (error) {
      setPruneError({
        container,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPruning(null);
    }
  };

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await onRefresh();
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };

  const repair = async (rid: string) => {
    setRepairError(null);
    setRepairing({ rid });
    try {
      const variant = await api.repairCollectorVariant(rid);
      setRepaired((current) => (current.includes(rid) ? current : [...current, rid]));
      // The repaired row is what the host reports; the whole table is re-read so the rail's
      // warning goes away in the same frame rather than waiting for the next refresh.
      if (!variant.runtimeMissing) await onRefresh();
    } catch (error) {
      setRepairError({ rid, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRepairing(null);
    }
  };

  const collectors = docker?.collectors ?? [];
  const overrideActive = docker?.stagedRids.includes('override') ?? false;
  const published = collectors.filter((variant) => variant.published);
  const missingRuntime = collectors.filter((variant) => variant.runtimeMissing);

  return (
    <div className="panel">
      <div className="block-head">
        <div>
          <h2>Container support</h2>
          <p className="dim">
            Attaching inside a container copies a matching Linux build of the collector into it and
            runs it with <code>docker exec</code>. This view reports whether Docker can be reached
            and which builds are ready to copy.
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void check()} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      {checkError && <div className="inline-error">{checkError}</div>}

      <section className="chart-block">
        <header className="block-head">
          <h2>Docker</h2>
        </header>

        {docker === null && (
          <div className="notice notice-info">
            <strong>Docker has not been checked yet.</strong>
            <span>Re-check to ask the host whether the CLI and daemon are available.</span>
          </div>
        )}

        {docker?.available && (
          <div className="notice notice-good">
            <strong>Docker is reachable</strong>
            <span>
              {docker.version ? `Server ${docker.version}.` : 'The daemon answered but reported no version.'}{' '}
              The rail lists running containers when they exist.
            </span>
          </div>
        )}

        {docker && !docker.available && (
          <div className={`notice ${docker.problem === 'cliMissing' ? 'notice-info' : 'notice-warning'}`}>
            <strong>
              {docker.problem === 'cliMissing'
                ? 'Docker CLI not found'
                : docker.problem === 'daemonUnreachable'
                  ? 'Docker daemon unreachable'
                  : 'Docker is not available'}
            </strong>
            <span>
              {docker.problem === 'cliMissing'
                ? 'Container targets are unavailable on this machine. Install Docker and CLI access to enable them.'
                : docker.problem === 'daemonUnreachable'
                  ? 'Docker is installed, but its daemon is not answering. Start Docker (or Docker Desktop), then re-check.'
                  : 'The host could not use Docker. The message below is the CLI’s own explanation.'}
            </span>
            {docker.error && <code className="notice-detail">{docker.error}</code>}
          </div>
        )}
      </section>

      <section className="chart-block">
        <header className="block-head">
          <div>
            <h2>Collector builds</h2>
            <p>
              A container is given the build that matches its libc. The app reads the image’s
              loader first, tries the matching build, and keeps the other one as a fallback.
            </p>
          </div>
          {docker && !overrideActive && collectors.length > 0 && (
            <span className="dim">
              {published.length} of {collectors.length} published
            </span>
          )}
        </header>

        {overrideActive && (
          <div className="notice notice-info">
            <strong>A custom collector is configured.</strong>
            <span>
              <code>MEMORYSPY_DOCKER_COLLECTOR</code> replaces per-variant selection, so publication
              checks are skipped.
            </span>
          </div>
        )}

        {!overrideActive && docker && collectors.length === 0 && (
          <div className="notice notice-info">
            <strong>The host did not report collector variants.</strong>
            <span>Update the app so its host and UI agree on the diagnostics format.</span>
          </div>
        )}

        {!overrideActive && published.length === 0 && collectors.length > 0 && (
          <div className="notice notice-warning">
            <strong>No Linux collector has been published.</strong>
            <span>
              Containers cannot be inspected until one is. Publish the host architecture first with{' '}
              <code>npm run collector:docker</code>.
            </span>
          </div>
        )}

        {missingRuntime.length > 0 && (
          <div className="notice notice-warning">
            <strong>
              The musl C++ runtime is missing for{' '}
              {missingRuntime.map((variant) => variant.rid).join(', ')}.
            </strong>
            <span>
              A bare Alpine image cannot start that build: the .NET apphost links against{' '}
              <code>libstdc++.so.6</code> and <code>libgcc_s.so.1</code>. Repairing copies both
              libraries beside the binary, extracted from{' '}
              <code>mcr.microsoft.com/dotnet/runtime-deps:10.0-alpine</code>. (.NET Alpine images
              install the runtime themselves and are unaffected.)
            </span>
            <div className="repair-actions">
              {missingRuntime.map((variant) => {
                const busy = repairing?.rid === variant.rid;
                return (
                  <button
                    type="button"
                    key={variant.rid}
                    className="btn btn-primary btn-sm"
                    onClick={() => void repair(variant.rid)}
                    disabled={repairing !== null || !dockerUsable}
                  >
                    {busy ? 'Repairing…' : `Repair ${variant.rid}`}
                  </button>
                );
              })}
            </div>
            {!dockerUsable && (
              <span>
                The repair needs Docker: the runtime is pulled from an image, so start the daemon
                first.
              </span>
            )}
            {repairError && (
              <div className="inline-error">
                <strong>Repairing {repairError.rid} failed.</strong> {repairError.message}{' '}
                <code className="tag-mono">
                  {republishCommand(repairError.rid)}
                </code>{' '}
                republishes it from a checkout instead.
              </div>
            )}
          </div>
        )}

        {repaired.length > 0 && (
          <div className="notice notice-good">
            <strong>Runtime repaired.</strong>
            <span>
              {repaired.join(', ')} now carries its C++ runtime, so bare Alpine images can be
              inspected. Containers that already staged the unrepairable build pick up the new one
              on their next listing.
            </span>
          </div>
        )}

        {!overrideActive && collectors.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Runtime identifier</th>
                <th>libc</th>
                <th>Binary</th>
                <th>musl runtime</th>
              </tr>
            </thead>
            <tbody>
              {collectors.map((variant) => (
                <tr key={variant.rid} className={variant.runtimeMissing ? 'row-suspect' : undefined}>
                  <td>
                    <code>{variant.rid}</code>
                  </td>
                  <td>
                    <span className="chip chip-quiet">{variant.libc}</span>
                  </td>
                  <td>{publishedCell(variant)}</td>
                  <td>{runtimeCell(variant)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!overrideActive && collectors.length > 0 && (
          <p className="caveat">
            glibc builds target Debian and Ubuntu-style images; musl builds target Alpine. Publishing
            a musl build needs a Docker daemon because the runtime is extracted from the .NET Alpine
            runtime image.
          </p>
        )}
      </section>

      <section className="chart-block">
        <header className="block-head">
          <div>
            <h2>Staged builds in containers</h2>
            <p>
              Every attach copies a matching Linux collector into the container’s <code>/tmp</code>.
              The path is content-addressed, so a rebuild leaves the previous copy behind: one
              executable plus, for musl, its runtime directory. Pruning keeps the newest build —
              the one the next attach reuses — and frees the rest.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void loadStaging()}
            disabled={!dockerUsable || stagingBusy}
          >
            {stagingBusy ? 'Measuring…' : 'Refresh usage'}
          </button>
        </header>

        {!dockerUsable && (
          <div className="notice notice-info">
            <strong>Usage needs a running daemon.</strong>
            <span>
              Measuring staged builds asks each container to list its own <code>/tmp</code>, so it
              is only possible while Docker is reachable.
            </span>
          </div>
        )}

        {dockerUsable && stagingError && <div className="inline-error">{stagingError}</div>}

        {dockerUsable && staging === null && stagingBusy && (
          <p className="dim">Measuring staged builds in every running container…</p>
        )}

        {dockerUsable && staging !== null && staging.length === 0 && !stagingBusy && (
          <p className="dim">No running containers, so nothing is staged.</p>
        )}

        {pruned && pruned.bytes > 0 && (
          <div className="notice notice-good">
            <strong>Freed {formatBytes(pruned.bytes, 0)} in {pruned.container}.</strong>
            <span>
              The newest build was kept. A session that was already running keeps its mapped files;
              the next attach copies the current build if the kept one is out of date.
            </span>
          </div>
        )}

        {pruneError && (
          <div className="inline-error">
            <strong>Pruning {pruneError.container} failed.</strong> {pruneError.message}
          </div>
        )}

        {dockerUsable && staging !== null && staging.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Container</th>
                <th className="num">Builds</th>
                <th className="num">On disk</th>
                <th className="num">Prunable</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {staging.map((row) => {
                const builds = new Set(row.copies.map((copy) => copy.identity)).size;
                const busy = pruning === row.container;
                return (
                  <tr key={row.container} className={row.error ? 'row-suspect' : undefined}>
                    <td>
                      <strong>{row.container}</strong>{' '}
                      <span className="dim">{row.image}</span>
                      {row.error && <div className="notice-detail">{row.error}</div>}
                    </td>
                    <td className="num">{row.error ? '—' : builds}</td>
                    <td className="num">{row.error ? '—' : formatBytes(row.totalBytes, 0)}</td>
                    <td className="num">
                      {row.error
                        ? '—'
                        : row.prunableBytes > 0
                          ? formatBytes(row.prunableBytes, 0)
                          : '—'}
                    </td>
                    <td>
                      {row.error ? (
                        <span className="dim">needs a shell</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void prune(row.container)}
                          disabled={row.prunableBytes === 0 || pruning !== null}
                        >
                          {busy
                            ? 'Pruning…'
                            : row.prunableBytes > 0
                              ? `Prune ${formatBytes(row.prunableBytes, 0)}`
                              : 'Nothing to prune'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {dockerUsable && staging !== null && staging.some((row) => !row.error) && (
          <p className="caveat">
            A rebuild costs about 90 MB per container until the next attach prunes it. The collector
            also cleans up after itself, but only copies older than a day and only when a new build
            is staged; this button is for getting the space back now. An image without a shell cannot
            be measured or pruned from here.
          </p>
        )}
      </section>
    </div>
  );
}
