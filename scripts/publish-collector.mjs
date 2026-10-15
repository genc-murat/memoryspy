// Publishes the collector self-contained into the Tauri bundle resources.
//
// Self-contained means the .NET runtime travels inside the publish output, so the installed
// app can attach to processes on a machine that has no `dotnet` at all — which is the whole
// point of shipping the collector inside an installer. The runtime identifier follows the
// machine running this script, so the same entry point serves the Windows release CI
// (win-x64) and a macOS dev machine (osx-arm64/osx-x64) without either hardcoding a RID the
// other platform cannot use.
//
// The output directory is cleaned first: `dotnet publish` merges into an existing directory,
// and a stale framework-dependent DLL beside a fresh self-contained layout is exactly the
// kind of mixture that costs an afternoon.
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(repoRoot, "src-tauri", "resources", "collector");

const ridByPlatform = {
  darwin: { arm64: "osx-arm64", x64: "osx-x64" },
  win32: { arm64: "win-arm64", x64: "win-x64" },
  linux: { arm64: "linux-arm64", x64: "linux-x64" },
};

const rid = ridByPlatform[process.platform]?.[process.arch];
if (!rid) {
  console.error(`No runtime identifier for ${process.platform}/${process.arch}.`);
  process.exit(1);
}

// Clean the previous publish out, but keep README.md: the directory doubles as a tracked
// repo path (its README documents the staging layout) and `dotnet publish` merges into an
// existing directory anyway, so only the publish artifacts themselves need to go.
const keep = new Set(["README.md"]);
for (const entry of readdirSync(outputDir)) {
  if (!keep.has(entry))
    rmSync(join(outputDir, entry), { recursive: true, force: true });
}

const result = spawnSync(
  "dotnet",
  [
    "publish",
    resolve(repoRoot, "collector"),
    "-c",
    "Release",
    "-r",
    rid,
    "--self-contained",
    "true",
    "-o",
    outputDir,
  ],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
