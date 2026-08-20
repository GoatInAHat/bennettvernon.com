# bennettvernon.com

My personal site. The background is a fullscreen particle physics simulation —
WebGPU with a CPU fallback — running a vendored fork of
[`@cazala/party`](https://github.com/cazala/party), extended with
pinned-particle typography and forces anchored to the page content.
[`vendor/party/README.md`](vendor/party/README.md) lists everything that
diverges from upstream, and the rotating demo presets are adapted from the
upstream playground (MIT).

```bash
npm install
npm run dev
```

Pushes to `main` deploy to [bennettvernon.com](https://bennettvernon.com) via
GitHub Pages.
