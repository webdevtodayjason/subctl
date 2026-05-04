# Service / dashboard

The `subctl` dashboard is a Bun-served HTTP+WS app at `http://localhost:8787`. It can run as a launchd service so it's always available — useful as a browser new-tab page.

This document covers install, lifecycle, port configuration, logs, and security.

---

## Install the launchd service

```
$ subctl service enable
```

That command:

1. Writes `~/Library/LaunchAgents/com.subctl.dashboard.plist`.
2. Loads it with `launchctl bootstrap gui/$(id -u)`.
3. Starts the dashboard immediately.

After this, the service starts at every login and stays up.

---

## Lifecycle commands

| Command                   | What it does                                                |
|---------------------------|-------------------------------------------------------------|
| `subctl service enable`   | Install the plist *and* start it. Persists across reboots.  |
| `subctl service disable`  | Unload the plist *and* remove it. Will not start at login.  |
| `subctl service start`    | Start the service now. Does not change install state.       |
| `subctl service stop`     | Stop the service now. Plist remains installed; will start at next login. |
| `subctl service status`   | Print: installed? running? PID? last exit code?             |
| `subctl service restart`  | Stop, then start.                                           |
| `subctl service tail`     | Tail the log file.                                          |

The distinction that matters: **enable/disable** affects whether launchd manages the service across logins; **start/stop** affects only the current run. You can `disable` (it won't auto-start anymore) but leave it `start`ed for the rest of the day.

---

## Setting the dashboard as your new-tab page

### Chrome

Settings → On startup → Open a specific page or set of pages → Add `http://localhost:8787`. For new-tab behavior specifically, install any "custom new tab" extension and point it at the same URL — Chrome locks down the new-tab page itself.

### Brave

Settings → New Tab Page → Dashboard → Customize → set "Custom URL" to `http://localhost:8787`. (Brave exposes this directly without an extension.)

### Arc

Settings → General → New Tabs Open With → "Custom URL" → `http://localhost:8787`.

### Safari

Safari → Settings → General → New tabs open with → Homepage. Then set Homepage to `http://localhost:8787`.

---

## Port configuration

Default port is `8787`. Override in `~/.config/subctl/accounts.conf`:

```
[service]
port = 9090
```

`subctl service restart` picks up the change. The plist re-renders from config on every `enable`.

If port 8787 is already in use on your machine, `subctl service start` will exit non-zero and log the conflict. Pick a different port and try again.

---

## Logs

| Stream    | Path                                              |
|-----------|---------------------------------------------------|
| stdout    | `~/Library/Logs/subctl/dashboard.out.log`         |
| stderr    | `~/Library/Logs/subctl/dashboard.err.log`         |
| launchd   | `~/Library/Logs/subctl/launchd.log`               |

Quick tail:

```
$ subctl service tail
```

Or directly:

```
$ tail -f ~/Library/Logs/subctl/dashboard.err.log
```

Logs rotate at 10MB with 3 historical files kept. Configurable under `[service]` in `accounts.conf`.

---

## Security

The dashboard binds to `127.0.0.1:8787`, **not** `0.0.0.0`. That means:

- Only processes on your local machine can connect.
- Other devices on your network — including phones, other workstations, and anything on a VPN — **cannot** reach the dashboard.
- No authentication is needed because no untrusted party can make a TCP connection to the port in the first place.

This is the same model as `localhost`-only dev servers (`vite`, `next dev`, `bun --hot`). It is intentional and is the right tradeoff for a personal-use dashboard. If you ever want to expose the dashboard externally, do it through a reverse proxy with auth — `subctl` itself will refuse to bind to anything other than loopback.

The dashboard is **read-only** with respect to your accounts and credentials. It cannot trigger an auth flow, cannot rotate keys, cannot edit `accounts.conf`. The only writes it performs are to its own state cache under `~/.config/subctl/state/`.
