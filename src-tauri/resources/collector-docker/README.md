# Bundled container collector

`npm run collector:docker` publishes the collector as a single, self-contained **Linux**
executable into this directory, one subdirectory per runtime identifier:

```
collector-docker/linux-arm64/MemorySpy.Collector       # glibc
collector-docker/linux-x64/MemorySpy.Collector         # glibc
collector-docker/linux-musl-arm64/MemorySpy.Collector  # musl (Alpine)
collector-docker/linux-musl-x64/MemorySpy.Collector    # musl (Alpine)
```

The app copies that file into a running container (`docker cp`) and starts it there with
`docker exec -i`, because a container's diagnostic sockets live in its own mount and PID
namespaces and cannot be reached from the host.

The app validates the image OS and architecture before staging. Linux glibc images use the
`linux-arm64` or `linux-x64` binary; Alpine/musl images use `linux-musl-arm64` or
`linux-musl-x64`. The host machine's architecture is irrelevant: an amd64 image on an arm64 host
needs an x64 collector. A Windows image is rejected rather than given a Linux executable.

The published output is intentionally **not** committed — run the script before building a
bundle that should support containers:

```bash
npm run collector:docker                           # host architecture, glibc
npm run collector:docker -- linux-x64               # explicit glibc target
npm run collector:docker -- linux-x64 musl          # Alpine x64
npm run collector:docker -- linux-arm64 musl        # Alpine arm64
npm run app:build
```
