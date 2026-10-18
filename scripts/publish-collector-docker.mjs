// Publishes the collector as a single Linux executable for use *inside* a container.
//
// A container has its own mount and PID namespaces, so the collector that ships with the app
// (`collector/`, published for the host) cannot see a container's diagnostic sockets. The way
// MemorySpy supports containers is to run the collector inside the same container as the target,
// copied in with `docker cp` and started with `docker exec`. That needs a Linux build of the
// collector, which is what this script produces.
//
// Two deliberate choices:
//
// * **Single file.** `docker cp` copies one artifact instead of a directory tree, and the copy
//   happens once per content identity in each container.
// * **Self-contained.** The image may have no `dotnet` at all — a runtime-deps or apphost-only
//   image is common for services — so the collector carries the runtime with it.
//
// The runtime identifier is not guessed from the host: a container can be emulated (an amd64
// image on an arm64 machine), and a binary of the wrong architecture fails with "exec format
// error" only after it is copied. Pass the RID explicitly, or let the app tell you which one it
// needs (`npm run collector:docker` builds the host's own architecture for glibc, the common
// Docker Desktop case). Alpine images need the matching `musl` variant.
//
// Usage:
//   node scripts/publish-collector-docker.mjs            # host arch (linux-arm64/linux-x64)
//   node scripts/publish-collector-docker.mjs linux-x64             # glibc target
//   node scripts/publish-collector-docker.mjs linux-x64 musl         # Alpine/musl target
//   node scripts/publish-collector-docker.mjs linux-arm64 glibc     # explicit default libc
//
// Published glibc and musl apphosts are validated by running the resulting executable in
// representative Debian/Alpine containers when the Docker integration tests are available.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED = ["linux-arm64", "linux-x64"];
const LIBCS = ["glibc", "musl"];

const hostRid = { arm64: "linux-arm64", x64: "linux-x64" }[process.arch];
const requested = process.argv[2] ?? hostRid;
const libc = process.argv[3] ?? "glibc";

if (!requested || !SUPPORTED.includes(requested)) {
  console.error(
    `Unsupported target '${requested ?? process.arch}'. Use one of: ${SUPPORTED.join(", ")}.`,
  );
  process.exit(1);
}

if (!LIBCS.includes(libc)) {
  console.error(`Unsupported libc '${libc}'. Use one of: ${LIBCS.join(", ")}.`);
  process.exit(1);
}

const outputRid = libc === "musl" ? requested.replace("linux-", "linux-musl-") : requested;
const publishRid = outputRid;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(repoRoot, "src-tauri", "resources", "collector-docker", outputRid);

// Same reasoning as the host publish: `dotnet publish` merges into an existing directory, so a
// stale layout would survive a failed build and be copied into containers as if it were fresh.
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const result = spawnSync(
  "dotnet",
  [
    "publish",
    resolve(repoRoot, "collector"),
    "-c",
    "Release",
    "-r",
    publishRid,
    "--self-contained",
    "true",
    "-p:PublishSingleFile=true",
    // The runtime is packed inside the executable and extracted on first start; without this the
    // native runtime libraries stay beside the binary and the single file is not runnable alone.
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    // The PDB is of no use inside a container: the app resolves *the target's* symbols, not the
    // collector's, and a 45 KB symbol file per container is a copy that buys nothing.
    "-p:DebugType=none",
    "-o",
    outputDir,
  ],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// A publish that produced no executable is not a success, whatever the exit code said.
const executable = join(outputDir, "MemorySpy.Collector");
const produced = readdirSync(outputDir).includes("MemorySpy.Collector");
if (produced) {
  // On macOS publishing can leave mode 0644 even though the PE header is an ELF apphost.
  // docker cp preserves this mode, and containers therefore reject an otherwise runnable file.
  chmodSync(executable, 0o755);
}
console.log(
  produced
    ? `Container collector published for ${outputRid}: ${join(outputDir, "MemorySpy.Collector")}`
    : `The publish reported success but produced no executable in ${outputDir}.`,
);
process.exit(produced ? 0 : 1);
