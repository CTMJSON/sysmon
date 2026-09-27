# sysmon

A lightweight local system monitor. Type `system` in the terminal and the
dashboard opens in a new Chrome tab on `http://127.0.0.1:7717`.

No dependencies — plain Node + the native macOS tools (`vm_stat`, `df`,
`netstat`, `lsof`, `ps`, `arp`, `ping`, `ifconfig`, `sysctl`, `route`).

## Usage

```bash
system                 # start (or reuse) and open the dashboard
SYSMON_PORT=8080 system   # run on a different port
```

Stop it with:

```bash
lsof -ti :7717 | xargs kill
```

Logs go to `/tmp/sysmon.log`.

## What it shows

| Panel | Source |
|---|---|
| **CPU** — total %, per-core load, sparkline | `os.cpus()`, `os.loadavg()` |
| **Memory** — used/total, active/wired/compressed/inactive/free, swap, pressure | `vm_stat`, `sysctl vm.swapusage` |
| **Disk** — root volume usage, free space, read/write throughput | `df -k -l`, `iostat` |
| **Network throughput** — live ↓/↑ per second with sparkline | `netstat -ib` deltas |
| **Internet speed** — real download / upload in Mbps | `speed.cloudflare.com` via `curl` |
| **Latency** — avg / min–max / jitter / packet loss to 3 targets | `ping -c 5` |
| **Connection details** — IPv4/prefix, MAC, media, Wi-Fi SSID, LAN gateway, DNS, VPN tunnel count | `ifconfig`, `networksetup`, `scutil --dns`, `route` |
| **Network interfaces** — active/idle, addresses, cumulative totals | `ifconfig` + `netstat -ib` |
| **Connected devices** — every host on the LAN with IP, MAC, vendor | active ping sweep of the /24 + `arp` |
| **Listening ports** — TCP + bound UDP with owning process and PID | `netstat -anv -p tcp`, `lsof` |
| **Processes** — top CPU / top memory, RSS | `ps -axo ... -r` |
| **System** — host, model, chip, OS, uptime, boot time | `sysctl`, `os` |

Live panels refresh every 2s. The network sweep and port/process inventory
refresh every 20s (a /24 sweep is deliberately paced so it stays cheap).

## Notes on how the numbers are derived

- **Memory pressure** is judged by **swap engagement**, not raw RAM %, because
  macOS deliberately keeps RAM full via caching — a high % is normal, swapping
  is not. `normal` → `elevated` (>25% swap) → `critical` (>60%).
- **Connected devices** are found by pinging every address on your /24 in
  bounded parallelism, then reading the ARP cache. Devices that don't answer
  ping (many IoT and phones) will not appear. Delivery is best-effort.
- **Vendor names** come from a built-in MAC OUI table, so it covers common
  vendors only — unlisted hardware shows as "Unknown device".
- **Bandwidth totals** (↓/↑ Total) are the interface's cumulative counters since
  boot, not a rate.
- **VPN tunnels** (`utun*`) are excluded from the interface table to avoid
  listing your host 11 times, but their traffic is still counted in the
  throughput totals and surfaced as a tunnel count.
- **Ports** show listeners and bound UDP sockets. macOS reports kernel-owned
  sockets without a process name; those appear as `unknown` where no owner is
  visible.

## Layout

```
sysmon/
├── server.js        # collector + HTTP server (no deps)
├── system           # launcher: starts server, opens the tab
└── public/
    └── index.html   # dashboard (vanilla JS, no build step)
```

## API

Each endpoint returns JSON and is usable on its own:

```
GET /api/system      full snapshot (cpu, memory, disk, network)
GET /api/net         network detail
GET /api/ping        latency probe
GET /api/speed       speed test (~20s)
GET /api/ports       listening sockets
GET /api/processes   process list
GET /api/devices     LAN device sweep
GET /api/health      liveness
```

## Requirements

macOS with Node.js. Port `7717` must be free.