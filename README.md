# sysmon

A lightweight local system monitor. Type `system` in the terminal and the
dashboard opens in a new Chrome tab on `http://127.0.0.1:7717`.

No dependencies — plain Node + the native macOS tools (`vm_stat`, `df`,
`netstat`, `lsof`, `ps`, `arp`, `ping`, `ifconfig`, `sysctl`, `route`,
`pmset`, `ioreg`, `diskutil`, `nettop`, `dns-sd`).

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
| **Power & Battery** — charge %, state, time remaining, health, cycle count, battery temp, thermal throttling | `pmset -g batt`, `pmset -g therm`, `ioreg -rn AppleSmartBattery` |
| **Open Files** — open descriptors vs kernel limit | `sysctl kern.num_files` |
| **Disk Health (S.M.A.R.T.)** — per-physical-disk self-test verdict | `diskutil list`, `diskutil info` |
| **Network Reliability** — retransmits, out-of-order, bad checksums, UDP drops | `netstat -s` |
| **Per-App Network** — top processes by live ↓/↑ rate | `nettop` |
| **Local Services (Bonjour)** — mDNS types + per-instance device, host:port, TXT (model/vendor/MAC), IP | `dns-sd -B/-L/-G` |

Live panels refresh every 2s. The network sweep, port/process inventory,
S.M.A.R.T., packet-error counters, per-app network, and Bonjour browse refresh
every 20s (a /24 sweep is deliberately paced so it stays cheap; nettop and
dns-sd each take a few seconds to sample, so they run slowly).

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
- **Battery health** is current full-charge capacity ÷ design capacity
  (`NominalChargeCapacity / DesignCapacity` from `ioreg`). Battery temperature
  is reported by the battery's own sensor (deci-Kelvin converted to °C). On a
  desktop with no battery the panel shows the power source only.
- **Disk Health** reports the S.M.A.R.T. self-test verdict from `diskutil`.
  `Verified` = healthy, `Failing` = back up now, `Not Supported` = the drive
  (typically external/USB) doesn't expose S.M.A.R.T. Attribute detail like
  reallocated-sector counts is **not** exposed by macOS; that would need
  `smartmontools` (brew) and is deliberately out of scope.
- **Open Files** is the system-wide descriptor count vs `kern.maxfiles`. Above
  90% is treated as critical — a leak in one app can exhaust the shared limit.
- **Per-App Network** rates are the delta between 20s samples of `nettop`
  cumulative counters. The first sample after the dashboard loads has no
  baseline, so it shows 0 until the next poll. Processes that exit between
  polls lose their totals.
- **Network Reliability** numbers are boot-cumulative from `netstat -s`; the
  "now" column is the delta since the last 20s sample.
- **Local Services** is a best-effort mDNS browse: devices on other subnets or
  with mDNS disabled won't appear. It lists service *types* (with counts) and
  drills each into individual instances via `dns-sd -B`/`-L`/`-G` — device
  name, host:port, key TXT fields (model, vendor, MAC, firmware), and resolved
  IPs. The full sweep spawns a bounded set of concurrent `dns-sd` processes
  (~8s) and is cached for 90s; the panel only re-scans on that cadence.
- **GPU / CPU power** (`powermetrics`) only appears when passwordless sudo is
  configured (`sudo -n true` succeeds) — otherwise the energy section reports
  `unavailable` instead of prompting. Nothing in sysmon ever prompts for a
  password.

## Layout

```
sysmon/
├── server.js        # collector + HTTP server (no deps)
├── system           # launcher: starts server, opens the tab
├── research/
│   └── candidate-tools.md   # surveyed tools, priorities, risks
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
GET /api/power       battery, thermal, GPU/CPU power
GET /api/smart       per-disk S.M.A.R.T. status
GET /api/fds         open file descriptors
GET /api/neterr      packet-error counters (TCP/UDP)
GET /api/appnet      per-process network rates
GET /api/services    Bonjour service types + instances (90s cache)
GET /api/health      liveness
```

## Requirements

macOS with Node.js. Port `7717` must be free.