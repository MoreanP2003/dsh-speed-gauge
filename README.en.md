[中文](README.md) | English

# dsh-speed-gauge

A generation-speed gauge for DSH. It lives in the header bar: click once to open, and watch how fast the current session is producing tokens.

**50 tok/s samples per second**: every streamed chunk is counted for finer, more accurate measurement, and a busy main thread does not stall the animation.

![Panel](https://raw.githubusercontent.com/MoreanP2003/dsh-speed-gauge/main/shots/promo.png)

## Features

- **Live speed**: 0–500 tok/s half-dial with a smoothly animated needle
- **30-second curve**: a continuously scrolling trend chart, so bursts and dips are visible
- **Average / peak**: both over the last 30 seconds; peak falls back once it leaves the window
- **Total output**: uses the provider's official `outputTokens` when available
- **Per-session**: switching session or sub-agent switches the numbers with it
- **Out of the way**: floats at the top of the conversation column and matches its width; the header button hides it any time
- **Follows the host theme**: light text on dark UI, dark text on light UI

## Install

### Plugin marketplace

**Not listed yet.** Once it is, you will be able to find `dsh-speed-gauge` in the DSH marketplace. For now use one of the options below.

### Option 1: GitHub Releases (recommended)

Download `dsh-speed-gauge-1.0.0.tgz` from [Releases](https://github.com/MoreanP2003/dsh-speed-gauge/releases), then:

```bash
dsh plugin --profile desktop add ./dsh-speed-gauge-1.0.0.tgz
```

### Option 2: Clone the repository

```bash
git clone https://github.com/MoreanP2003/dsh-speed-gauge.git
dsh plugin --profile desktop add ./dsh-speed-gauge
```

### Option 3: npm (one command)

```bash
dsh plugin --profile desktop add dsh-speed-gauge
dsh plugin --profile web add dsh-speed-gauge
```

Package page: https://www.npmjs.com/package/dsh-speed-gauge

### Desktop note

The desktop app ships its own CLI; a plain `dsh` command cannot manage the `desktop` profile:

```bash
"<install dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add <package or folder>
```

Reload the app (or restart it) after installing, and the header button shows up.

### Update / uninstall

```bash
dsh plugin --profile desktop add <package or folder>
dsh plugin --profile desktop remove dsh-speed-gauge
```

## Usage

After installing, a **Speed dial** button appears in the header bar. Click it to open the panel, click again to close it (the choice is remembered).

![Click here to open the panel](https://raw.githubusercontent.com/MoreanP2003/dsh-speed-gauge/main/shots/how-to-open.png)

The **Reset** button on the right clears the totals and peak for the current session.

| Light | Dark |
|---|---|
| ![Light](https://raw.githubusercontent.com/MoreanP2003/dsh-speed-gauge/main/shots/preview-light.png) | ![Dark](https://raw.githubusercontent.com/MoreanP2003/dsh-speed-gauge/main/shots/preview-dark.png) |

## How the numbers are computed

- Character counts come from `llm/stream` deltas: text, reasoning text, and tool-call arguments;
- Live speed = character rate ÷ characters-per-token, with the ratio calibrated online from official `usage.outputTokens`;
- Total output accumulates official usage when present, otherwise falls back to an estimate;
- Curve, average, and peak all use a 30-second window.

## Compatibility

- **DSH >= 0.2.1** (developed and verified on 0.2.1-rc.2), requiring the webServer service and the llm/stream hook
- Node.js >= 20
- Requires the DSH `webServer` service and the `llm/stream` hook
- React 18 is provided by the host and not bundled
- Rendering uses a Worker with OffscreenCanvas; if the page CSP blocks Blob workers it falls back to a one-line text readout
- All DOM class names are prefixed with `dsg-`, and the plugin only touches nodes it created, so it coexists with other plugins

### Web / remote access

Custom routes only accept loopback by default. For the web build or a reverse proxy, set this where DSH starts:

```bash
DSH_SPEED_GAUGE_ALLOW_REMOTE=1
```

### Debugging

Sample logging is off by default. Set `DSH_SPEED_GAUGE_LOG=1` to write it to the system temp directory.

## Development

```bash
node --test test/sampler.test.mjs test/host.test.mjs
```

| File | Purpose |
|---|---|
| `host.js` | Listens to `llm/stream`, serves SSE and snapshot routes |
| `sampler.js` | Sampling and statistics, pure logic, unit-tested |
| `client.js` | Header button and panel container |
| `panel-worker.js` | Panel rendering (Worker + OffscreenCanvas) |

## License

MIT
