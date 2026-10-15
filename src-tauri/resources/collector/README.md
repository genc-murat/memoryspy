# Bundled collector

`npm run collector:publish` writes the published `MemorySpy.Collector` build into this
directory so `tauri build` can bundle it as an app resource.

The published output is intentionally **not** committed — run the publish script before
building a bundle:

```bash
npm run collector:publish
npm run app:build
```

During development nothing here is needed: the host finds the collector at
`collector/bin/Debug/net10.0/MemorySpy.Collector.dll` automatically.
