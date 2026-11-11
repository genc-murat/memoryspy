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
// A musl build is not self-contained with respect to the C++ runtime: the .NET apphost and
// `libcoreclr.so` link against `libstdc++.so.6` and `libgcc_s.so.1`, and a bare Alpine image has
// neither. Those two libraries are published in a `libs/` directory beside the musl executable
// and staged with `LD_LIBRARY_PATH` by the app. Extracting them needs Docker, so publishing a
// musl variant needs a daemon even on a machine that can cross-publish the binary itself.
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
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED = ["linux-arm64", "linux-x64"];
const LIBCS = ["glibc", "musl"];

/// The image whose C++ runtime a musl collector runs against. It is the same runtime .NET
/// requires on Alpine, so the libraries stay version-aligned with the runtime pack the collector
/// is published with instead of drifting with whatever `alpine:latest` is at publish time.
const MUSL_RUNTIME_IMAGE = "mcr.microsoft.com/dotnet/runtime-deps:10.0-alpine";
const MUSL_RUNTIME_LIBRARIES = ["libstdc++.so.6", "libgcc_s.so.1"];

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`could not run the Docker CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    throw new Error(
      `docker ${args.join(" ")} failed${detail ? `: ${detail}` : " with no explanation"}`,
    );
  }
  return result.stdout ?? "";
}

/// Copies the C++ runtime the musl apphost needs out of the .NET Alpine runtime image.
///
/// `docker cp` preserves a symlink rather than its target, and `libstdc++.so.6` is a symlink in
/// the image. Resolving it first keeps the bundle from containing a dangling link that only
/// fails later, inside a user's container.
function publishMuslRuntime(outputRid, libsDirectory) {
  const platform = outputRid.includes("arm64") ? "linux/arm64" : "linux/amd64";
  const container = `memoryspy-collector-libs-${process.pid}-${Date.now()}`;
  mkdirSync(libsDirectory, { recursive: true });
  // The first run pulls the image, which can take a while on a slow connection. Say what is
  // happening instead of looking hung between the dotnet publish and the final message.
  console.log(`Extracting the musl C++ runtime from ${MUSL_RUNTIME_IMAGE} (${platform})...`);

  try {
    const libstdcxx = docker([
      "run",
      "--rm",
      "--platform",
      platform,
      "--entrypoint",
      "sh",
      MUSL_RUNTIME_IMAGE,
      "-c",
      "readlink -f /usr/lib/libstdc++.so.6",
    ]).trim();
    if (!libstdcxx) {
      throw new Error(`${MUSL_RUNTIME_IMAGE} did not report a libstdc++.so.6 path`);
    }

    docker(["create", "--name", container, "--platform", platform, MUSL_RUNTIME_IMAGE]);
    docker(["cp", `${container}:${libstdcxx}`, join(libsDirectory, "libstdc++.so.6")]);
    docker(["cp", `${container}:/usr/lib/libgcc_s.so.1`, join(libsDirectory, "libgcc_s.so.1")]);
  } finally {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  }

  for (const name of MUSL_RUNTIME_LIBRARIES) {
    const path = join(libsDirectory, name);
    if (!statSync(path).isFile() || statSync(path).size === 0) {
      throw new Error(`the extracted runtime library ${name} is missing or empty`);
    }
  }
}

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
if (!produced) {
  console.error(`The publish reported success but produced no executable in ${outputDir}.`);
  process.exit(1);
}

// On macOS publishing can leave mode 0644 even though the PE header is an ELF apphost.
// docker cp preserves this mode, and containers therefore reject an otherwise runnable file.
chmodSync(executable, 0o755);

if (libc === "musl") {
  const libsDirectory = join(outputDir, "libs");
  try {
    publishMuslRuntime(outputRid, libsDirectory);
  } catch (error) {
    // A musl executable without its libraries is the failure this script exists to prevent:
    // it stages and copies fine, then dies with "Error loading shared library libstdc++.so.6"
    // in every bare Alpine image. Remove the half-published output instead of leaving it to be
    // bundled.
    rmSync(outputDir, { recursive: true, force: true });
    console.error(
      `Could not publish the musl C++ runtime beside the collector: ${error.message}\n` +
        "Publishing a musl collector needs a Docker daemon; the runtime is extracted from " +
        `${MUSL_RUNTIME_IMAGE}.`,
    );
    process.exit(1);
  }
  console.log(`Bundled musl C++ runtime: ${libsDirectory}`);
}

console.log(`Container collector published for ${outputRid}: ${executable}`);
process.exit(0);
