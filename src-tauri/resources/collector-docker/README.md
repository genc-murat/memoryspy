# Bundled container collector

`npm run collector:docker` publishes the collector as a single, self-contained **Linux**
executable into this directory, one subdirectory per runtime identifier:

```
collector-docker/linux-arm64/MemorySpy.Collector       # glibc
collector-docker/linux-x64/MemorySpy.Collector         # glibc
collector-docker/linux-musl-arm64/MemorySpy.Collector  # musl (Alpine)
collector-docker/linux-musl-arm64/libs/libstdc++.so.6  # musl C++ runtime
collector-docker/linux-musl-arm64/libs/libgcc_s.so.1
collector-docker/linux-musl-x64/MemorySpy.Collector    # musl (Alpine)
collector-docker/linux-musl-x64/libs/libstdc++.so.6
collector-docker/linux-musl-x64/libs/libgcc_s.so.1
```

A musl .NET apphost and `libcoreclr.so` link against `libstdc++.so.6` and `libgcc_s.so.1`.
Bare Alpine images do not ship them (the official .NET Alpine images install `libstdc++`), so the
musl collector carries the pair in `libs/`. It is copied into the container only when the image
needs it, and the app runs the collector with `LD_LIBRARY_PATH` pointing at that directory.

Publishing a musl variant therefore needs a Docker daemon: the script extracts the libraries from
`mcr.microsoft.com/dotnet/runtime-deps:10.0-alpine`. glibc publishing does not.

The app copies that file into a running container (`docker cp`) and starts it there with
`docker exec -i`, because a container's diagnostic sockets live in its own mount and PID
namespaces and cannot be reached from the host.

Staged paths carry the collector's content identity, so a rebuild never aliases a copy an active
session is using. After a new copy is verified, the collector prunes copies older than a day —
both the executables and their `memoryspy-collector-libs-<rid>-<identity>` runtime directories.
The executable's prefix does not match the runtime directories, so cleanup is given both; without
that, every rebuild would leave ~2.8 MB behind for the life of the container. The pair the current
session runs with is excluded, and a busy directory is retried on the next attach.

A collector built before cleanup learned the second prefix (for example an older
`MEMORYSPY_DOCKER_COLLECTOR` override) rejects the extra argument. The host then retries with the
executable prefix alone instead of dropping cleanup entirely: superseded executables are still
pruned, and only the runtime directories that binary cannot understand are left for the manual
prune in Container Support. Staging never fails because cleanup did.

Container Support also reports how much space those copies take in every running container, and
**Prune** removes all but the newest build (the executable and its runtime directory are kept or
removed together). Measuring and pruning run `sh`/`du`/`rm` inside the container, so an image
without a shell reports "cannot measure" instead of silently showing zero. Sessions that are
already running keep their mapped files when their copy is unlinked.

The app validates the image OS and architecture before staging. Linux glibc images use the
`linux-arm64` or `linux-x64` binary; Alpine/musl images use `linux-musl-arm64` or
`linux-musl-x64`. The host machine's architecture is irrelevant: an amd64 image on an arm64 host
needs an x64 collector. A Windows image is rejected rather than given a Linux executable.

The published output is intentionally **not** committed — run the script before building a
bundle that should support containers:

```bash
npm run collector:docker                           # host architecture, glibc
npm run collector:docker -- linux-x64               # explicit glibc target
npm run collector:docker -- linux-x64 musl          # Alpine x64 (needs Docker)
npm run collector:docker -- linux-arm64 musl        # Alpine arm64 (needs Docker)
npm run app:build
```
