# Candidate monitoring tools — research shortlist

Research date: 2026-09-27 · Host: macOS 26.5.2 (Darwin 25.5.0), Apple Silicon (arm64)

Goal: enrich sysmon with **free, open-source, no-signup** data sources that are
consistent with its existing philosophy — **no npm dependencies, native macOS
binaries, graceful degradation** when a tool is missing or needs privileges.

Every candidate below was probed on the reference Mac. Actual availability,
license, install method, parsing cost, privilege requirements, and polling
overhead are recorded — not guessed.

## Ranking rules

- **Priority tier**: `must-have` (fills a real dashboard gap, zero risk) vs
  `nice-to-have` (valuable but gated on install/sudo/fragility).
- **Risk**: `sudo` (needs root), `install` (needs brew/pip), `fragile`
  (macOS-version dependent), `slow` (sub-500ms poll).
- **Cadence**: cheap tools → 2s refresh; anything taking >500ms → 20s.

---

## 1. Battery & power — `pmset -g batt` + `pmset -g therm` — **MUST-HAVE**

- **License**: part of macOS (Apple, closed but pre-installed, freely usable).
- **Install**: none — `/usr/bin/pmset`.
- **Output**: plain text, one line. `pmset -g batt` → `Now drawing from
  'Battery Power' / -InternalBattery-0 … 40%; discharging; 4:22 remaining`.
  `pmset -g therm` → `Note: No thermal warning level has been recorded`.
- **Parsing cost**: trivial (one regex per line).
- **Privileges**: none.
- **Overhead**: ~5–15ms per call. Safe to poll every 2s.
- **Rationale**: The dashboard currently has **no battery or thermal panel at
  all** — a glaring gap on a laptop. Charging state, percentage, time remaining,
  and the system thermal warning level (which tells you the CPU is being
  throttled) are the single highest-value additions. Zero risk, zero cost.
- **Caveat**: on a desktop Mac with no battery, `pmset -g batt` still reports
  the power source ("AC Power"); the battery line is simply absent. Must be
  handled gracefully (show power source only). `-g therm` only reports a level
  once a warning is recorded — "none recorded" is the normal case.

## 2. Battery detail & health — `ioreg -rn AppleSmartBattery` — **MUST-HAVE**

- **License**: part of macOS.
- **Install**: none — `/usr/sbin/ioreg`.
- **Output**: IOKit registry plist-style text. Usable keys: `CurrentCapacity`,
  `MaxCapacity`, `DesignCapacity` (mAh), `CycleCount`, `Temperature`
  (**deci-Kelvin**, ≈28 °C on the probe), `Voltage` (mV), `Amperage`,
  `IsCharging`, `ExternalConnected`, `FullyCharged`, `TimeRemaining`.
- **Parsing cost**: low (grab ~8 keys with regex).
- **Privileges**: none.
- **Overhead**: ~10–20ms. Safe at 2s.
- **Rationale**: `pmset` gives you the *what* (40%, discharging); `ioreg` gives
  the *health* — cycle count, design-capacity retained (`MaxCapacity /
  DesignCapacity`), and battery temperature. Battery temp is one of the few
  thermal signals available **without sudo** on Apple Silicon (this class of
  machine exposes no public CPU-die thermal via `ioreg`; that needs
  `powermetrics`). Pairs naturally with #1 into one "Power & Battery" panel.
- **Caveat**: key set varies slightly between Intel and Apple Silicon, so the
  parser must fall back gracefully when a key is absent (e.g., desktop Macs
  have no `AppleSmartBattery` entry at all).

## 3. Disk health / S.M.A.R.T. — `diskutil` — **MUST-HAVE**

- **License**: part of macOS.
- **Install**: none — `/usr/sbin/diskutil`.
- **Output**: `diskutil list` marks physical disks as `(internal, physical)` /
  `(external, physical)`; `diskutil info diskN` reports `SMART Status:
  Verified | Failing | Not Supported`, plus name, size, protocol.
- **Parsing cost**: two small parses; `diskutil info` per disk ~100–300ms.
- **Privileges**: none (S.M.A.R.T. status via diskutil is readable by any user).
- **Overhead**: with 1–3 physical disks this is ~300–900ms → **20s cadence**.
- **Rationale**: The dashboard's Disk panel only shows *capacity* (`df`). It
  tells you nothing about the drive actually failing. S.M.A.R.T. status is the
  canonical early-warning signal and is available for free without
  `smartctl`. `Verified` vs `Failing` is the perfect normal/critical example
  for the status-colour scheme.
- **Caveat**: external disks often report `SMART Status: Not Supported`.
  Apple Silicon internal NVMe reports `Verified`. Treat "Failing" as critical,
  everything else as informational. S.M.A.R.T. attribute detail (reallocated
  sectors, etc.) is **not** exposed by diskutil — that is the one reason to
  consider `smartmontools` (#8).

## 4. Open file descriptors — `sysctl kern.num_files` — **MUST-HAVE**

- **License**: part of macOS.
- **Install**: none — `/usr/sbin/sysctl`.
- **Output**: three numbers (`num_files`, `maxfiles`, `maxfilesperproc`). On the
  probe: 7134 open of 184320 max.
- **Parsing cost**: trivial.
- **Privileges**: none.
- **Overhead**: ~2–5ms. Safe at 2s.
- **Rationale**: A leaky app that accumulates file handles is a classic
  "everything is weird and I don't know why" failure. FD count vs the system
  ceiling is a real pressure gauge (like CPU/memory but currently missing),
  costs nothing, and gives the dashboard a fourth core resource panel. Close to
  zero risk; a process that exhausts `maxfiles` makes apps start failing with
  "too many open files".
- **Caveat**: none — this is about as stable as a sysctl gets. `maxfiles` can
  be raised per-session with `ulimit`, so report both current max and the
  kernel ceiling.

## 5. Network reliability — `netstat -s` — **MUST-HAVE**

- **License**: part of macOS.
- **Install**: none — `/usr/sbin/netstat`.
- **Output**: hierarchical counters under `tcp:` and `udp:`. Useful TCP lines:
  `retransmit timeout`, `out-of-order packet`, `discarded for bad checksum`,
  `listen queue overflow`, `bad connection attempt`. Useful UDP lines:
  `datagrams received`, `with bad checksum`, `dropped due to no socket`,
  `dropped due to full socket buffers`, `datagrams output`.
- **Parsing cost**: low (indented counter lines).
- **Privileges**: none.
- **Overhead**: ~10–30ms. Safe at 2s (or 20s; totals change slowly).
- **Rationale**: Throughput (↓/↑ rate) and latency are already covered, but
  *correctness* is not. Packet loss, retransmits, out-of-order packets, and
  checksum failures explain "slow but latency looks fine" — a Wi-Fi link with
  high retransmit but low latency is broken differently than one that's just
  far away. UDP "dropped due to no socket" is also a useful security/debug
  signal (garbage or scans hitting closed ports).
- **Caveat**: counters are boot-cumulative. The dashboard should present them
  as **deltas per sample window** plus lifetime totals. Counter formatting is
  hierarchical and macOS-version-dependent in wording, so parse by regex on
  stable substrings and treat a miss as 0.

## 6. Per-app network usage — `nettop` — **MUST-HAVE**

- **License**: part of macOS.
- **Install**: none — `/usr/bin/nettop`.
- **Output**: CSV (`-J` to pick columns): `<name>.<pid>,interface,state,bytes_in,bytes_out,`.
  Probed on the reference Mac and confirmed working without sudo.
- **Parsing cost**: moderate (many rows; must keep a previous cumulative
  snapshot to compute per-second rates, same pattern as `windowThroughput`).
- **Privileges**: none.
- **Overhead**: each run takes ~1–2s (one sample window) → **20s cadence**.
- **Rationale**: "What is eating my bandwidth?" is unanswerable today — the
  dashboard shows aggregate throughput only. A top-N table of processes by
  ↓/↑ bytes closes the loop and reuses the existing per-process table styling.
  `nettop` is native, unlike `iftop`/`nload` (install + sudo) and `lsof`
  (connection-granular, no byte totals).
- **Caveat**: cumulative counters are per process *name*; a process that exits
  loses its totals, so deltas between polls are the honest number. First poll
  after boot has no baseline (show 0 rather than garbage). `nettop` needs a
  terminal-ish environment but runs fine under `execFile`.

## 7. Local service discovery (Bonjour/mDNS) — `dns-sd` — **NICE-TO-HAVE**

- **License**: part of macOS.
- **Install**: none — `/usr/bin/dns-sd`.
- **Output**: `dns-sd -B _services._dns-sd._udp local` streams
  `Add`/`Rmv` lines listing advertised service types (`_airplay._tcp`,
  `_googlecast._tcp`, `_spotify-connect._tcp`, …). Probed and confirmed live.
- **Parsing cost**: low (one regex per Add line), but the tool **does not
  exit** — it must be killed after a bounded browse window (~3s).
- **Privileges**: none.
- **Overhead**: ~3–3.5s per run → **20s cadence**, and only on demand if we
  want to be conservative.
- **Rationale**: A "what's advertising on my network right now" panel is fun and
  genuinely useful (stray Chromecast, unknown AirPlay receiver → potential
  security signal). Pairs conceptually with the existing Connected Devices
  panel. Requires careful subprocess lifecycle management (kill after N
  seconds) — the main engineering cost.
- **Caveat**: best-effort; devices on other subnets or with mDNS disabled won't
  appear. Service *types* are discovered, not instances, without deeper
  `dns-sd -L` lookups (which multiply runtime). Keep it to type+count.

## 8. S.M.A.R.T. attribute detail — `smartctl` (smartmontools) — **NICE-TO-HAVE / INSTALL**

- **License**: GPLv2 (open source).
- **Install**: `brew install smartmontools` — **not present** on the reference
  Mac.
- **Output**: per-attribute health table (reallocated sectors, power-on hours,
  temperature) with overall health verdict.
- **Parsing cost**: low-to-moderate.
- **Privileges**: none needed for SMART reads on APFS/NVMe via smartctl
  (`-d apfs` / `-d nvme`).
- **Overhead**: ~200–500ms → 20s.
- **Rationale**: Only worth it once `diskutil`'s headline status exists (#3).
  smartctl is the *detail* layer (exact reallocated-sector counts, wear). Adds
  a brew dependency, which the project has so far avoided. **Defer** until a
  user explicitly wants deeper disk telemetry; keep the code path designed so
  this drops in later.

## 9. GPU / CPU energy & die thermals — `powermetrics` — **NICE-TO-HAVE / SUDO**

- **License**: part of macOS.
- **Install**: none — `/usr/bin/powermetrics` (confirmed present).
- **Output**: rich samplers: `cpu_power` (`CPU Power: 123 mW`), `gpu_power`
  (`GPU Power: 45 mW`), `thermal` (die temperatures on Apple Silicon).
- **Parsing cost**: low (regex on `<label> Power: <n> mW` / `die temperature`).
- **Privileges**: **root only** — `powermetrics must be invoked as the
  superuser`. The reference Mac has no passwordless sudo, so it's unavailable
  here without setup.
- **Overhead**: a 1-sample run is ~100ms + sudo overhead; must be cached
  (~30s TTL), never polled hot.
- **Rationale**: GPU utilization and CPU/GPU power are a real gap (no GPU
  panel exists). But requiring passwordless `sudo` breaks the "zero setup"
  promise. **Implement behind a runtime capability probe** (`sudo -n true`):
  if the user has passwordless sudo, show the panel; otherwise render
  "unavailable — requires passwordless sudo" and move on. Never prompt, never
  hang. This is the canonical "graceful degradation" candidate.
- **Caveat**: needs `sudo -n` so it can't block on a password prompt; on macOS
  <13 the thermal sampler names differ. Verify each boot, degrade silently.

## 10. Wi-Fi diagnostics — `wdutil` / `airport` — **SKIP / DEFER**

- **License**: part of macOS.
- **Install**: none, but `airport` was removed from modern macOS; `wdutil`
  requires **sudo** (`sudo wdutil info`), confirmed on the probe.
- **Output**: channel, RSSI, tx rate, country.
- **Parsing cost**: low.
- **Privileges**: sudo for `wdutil`.
- **Overhead**: low.
- **Rationale**: Wi-Fi signal/channel is nice, but it's behind sudo, the legacy
  `airport` binary is gone (fragile), and `networksetup -getairportnetwork`
  already yields the SSID. RSSI can be inferred from `system_profiler
  SPAirPortDataType` (no sudo, but slow ~2–4s). **Deferred** — revisit only if
  wireless signal strength becomes a headline ask.

## 11. Process tree / fd per-process — `lsof` / `top` — **SKIP**

Already effectively covered by the existing `ps`/`lsof` collectors. Not a gap.

## 12. DNS query logging — **SKIP**

macOS has no native, non-privileged DNS query logger. `log show
--predicate 'process == "mDNSResponder"'` is slow, log-database dependent
(fragile), and noisy. Not worth the cost today.

---

## Recommended build order (must-haves → nice-to-haves)

| Priority | Source | Panel | Cadence | Risk |
|---|---|---|---|---|
| 1 | `pmset -g batt` + `pmset -g therm` | Power & Battery (charge state) | 2s | none |
| 2 | `ioreg -rn AppleSmartBattery` | Power & Battery (health/temp) | 2s | none |
| 3 | `diskutil list` + `diskutil info` | Disk Health (S.M.A.R.T.) | 20s | none |
| 4 | `sysctl kern.num_files/maxfiles` | Open File Descriptors | 2s | none |
| 5 | `netstat -s` | Network Reliability (errors) | 20s | none |
| 6 | `nettop -P -L 1 -J bytes_in,bytes_out` | Per-App Network | 20s | none |
| 7 | `dns-sd -B _services._dns-sd._udp` | Local Services (Bonjour) | 20s | none |
| 8 | `sudo -n powermetrics` (probed) | GPU / CPU energy + die temp | 30s cache | **sudo** |
| 9 | `smartctl` (smartmontools, brew) | S.M.A.R.T. detail | 20s | **install** |
| 10 | `wdutil` / `system_profiler` | Wi-Fi RSSI / channel | 20s | **sudo / slow** |

All seven must-haves are native, sudo-free, and install-free — they extend
sysmon without violating its no-dependency, native-tools contract.