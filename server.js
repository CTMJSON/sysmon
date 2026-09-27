#!/usr/bin/env node
'use strict';

/**
 * sysmon — local system monitor server
 *
 * Collects memory, disk, CPU, network throughput, latency, and
 * connected-device / port / process inventory using native macOS tools
 * (no npm dependencies), and serves a live dashboard over localhost.
 */

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.SYSMON_PORT || 7717);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const startedAt = Date.now();

/* ------------------------------------------------------------------ */
/* shell helpers                                                       */
/* ------------------------------------------------------------------ */

function run(cmd, args = [], timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 12 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/* ------------------------------------------------------------------ */
/* memory                                                             */
/* ------------------------------------------------------------------ */

const PAGE_SIZE = 4096; // Apple Silicon & modern Intel

async function swapBytes() {
  const swap = await run('sysctl', ['-n', 'vm.swapusage']);
  const m = swap.match(/total = ([0-9.]+)M\s+used = ([0-9.]+)M\s+free = ([0-9.]+)M/);
  if (!m) return null;
  const M = 1024 * 1024;
  return { total: num(m[1]) * M, used: num(m[2]) * M, free: num(m[3]) * M };
}

async function collectMemory() {
  const out = await run('vm_stat');
  const grab = (label) => {
    const m = out.match(new RegExp(label + ':\\s+([0-9]+)'));
    return m ? num(m[1]) : 0;
  };

  const pageSizeMatch = out.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? num(pageSizeMatch[1]) : PAGE_SIZE;

  const free = grab('Pages free');
  const active = grab('Pages active');
  const inactive = grab('Pages inactive');
  const speculative = grab('Pages speculative');
  const wired = grab('Pages wired down');
  const compressed = grab('Pages occupied by compressor');
  const purgeable = grab('Pages purgeable');

  const total = os.totalmem();
  const pagesUsed = active + inactive + speculative + wired + compressed - purgeable;
  let used = Math.max(0, pagesUsed * pageSize);
  if (used > total) used = total;
  const freeBytes = Math.max(0, total - used);
  // macOS keeps memory busy by design; classify on swap engagement, not raw %
  const swapUsed = await swapBytes();
  const swapRatio = swapUsed && swapUsed.total ? swapUsed.used / swapUsed.total : 0;
  const pressure = swapRatio > 0.6 ? 'critical' : swapRatio > 0.25 ? 'elevated' : 'normal';

  // swap
  const swap = await run('sysctl', ['-n', 'vm.swapusage']);
  const swapMatch = swap.match(/total = ([0-9.]+)M\s+used = ([0-9.]+)M\s+free = ([0-9.]+)M/);
  const M = 1024 * 1024;

  return {
    total,
    used,
    free: freeBytes,
    percent: total ? +(used / total * 100).toFixed(1) : 0,
    pressure,
    breakdown: {
      active: active * pageSize,
      inactive: inactive * pageSize,
      wired: wired * pageSize,
      compressed: compressed * pageSize,
      free: free * pageSize,
      speculative: speculative * pageSize,
    },
    swap: swapMatch
      ? {
          total: num(swapMatch[1]) * M,
          used: num(swapMatch[2]) * M,
          free: num(swapMatch[3]) * M,
          percent: num(swapMatch[1]) ? +(num(swapMatch[2]) / num(swapMatch[1]) * 100).toFixed(1) : 0,
        }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* cpu                                                                */
/* ------------------------------------------------------------------ */

let lastCpu = os.cpus();
let lastCpuTime = null;

function collectCpu() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }

  let usage = 0;
  if (lastCpuTime) {
    const idleDelta = idle - lastCpuTime.idle;
    const totalDelta = total - lastCpuTime.total;
    usage = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;
  }
  lastCpu = cpus;
  lastCpuTime = { idle, total };

  const load = os.loadavg();
  return {
    model: (cpus[0] && cpus[0].model || 'CPU').replace(/\s+/g, ' ').trim(),
    cores: cpus.length,
    usage: +Math.max(0, Math.min(100, usage)).toFixed(1),
    load: { one: +load[0].toFixed(2), five: +load[1].toFixed(2), fifteen: +load[2].toFixed(2) },
    perCore: cpus.map((c) => {
      const t = c.times;
      const sum = t.user + t.nice + t.sys + t.idle + t.irq;
      return sum ? +(((sum - t.idle) / sum) * 100).toFixed(1) : 0;
    }),
  };
}

/* ------------------------------------------------------------------ */
/* system identity / uptime                                           */
/* ------------------------------------------------------------------ */

async function collectSystem() {
  const raw = await run('sysctl', ['-n', 'machdep.cpu.brand_string', 'hw.model', 'kern.osproductversion', 'kern.boottime']);
  const lines = raw.trim().split('\n');
  const cpuModel = lines[0] || '';
  const hwModel = lines[1] || '';
  const osVersion = lines[2] || '';
  const bootLine = lines[3] || '';
  const bootMatch = bootLine.match(/sec = (\d+)/);
  const bootEpoch = bootMatch ? num(bootMatch[1]) : Math.floor(Date.now() / 1000);

  return {
    hostname: os.hostname(),
    platform: `${os.type() === 'Darwin' ? 'macOS' : os.type()} ${osVersion}`.trim(),
    arch: os.arch(),
    model: hwModel,
    cpuModel,
    uptime: os.uptime(),
    bootTime: bootEpoch * 1000,
    node: process.version,
  };
}

/* ------------------------------------------------------------------ */
/* disk                                                               */
/* ------------------------------------------------------------------ */

async function collectDisk() {
  const out = await run('df', ['-k', '-l']);
  const rows = out.trim().split('\n').slice(1);

  const mounts = rows
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) return null;
      const size = num(parts[1]) * 1024;
      const used = num(parts[2]) * 1024;
      const avail = num(parts[3]) * 1024;
      const capacity = num(parts[4].replace('%', ''));
      const mount = parts.slice(8).join(' ');
      if (!size) return null;
      return {
        filesystem: parts[0],
        mount,
        size,
        used,
        avail,
        percent: capacity,
      };
    })
    .filter(Boolean);

  // prefer the root volume, else the largest
  const root = mounts.find((m) => m.mount === '/');
  const primary = root || mounts.slice().sort((a, b) => b.size - a.size)[0] || null;

  // I/O counters
  const io = await run('iostat', ['-d', '-c', '2', '-w', '1']);
  let readKBs = 0;
  let writeKBs = 0;
  const iLines = io.trim().split('\n').filter((l) => l.trim() && !/device|disk\d/.test(l.split(/\s+/)[0]));
  if (iLines.length >= 2) {
    const last = iLines[iLines.length - 1].trim().split(/\s+/);
    readKBs = num(last[1]);
    writeKBs = num(last[2]);
  }

  return {
    primary,
    mounts,
    io: { read: readKBs * 1024, write: writeKBs * 1024 },
  };
}

/* ------------------------------------------------------------------ */
/* network — interfaces, throughput, latency, public IP               */
/* ------------------------------------------------------------------ */

let lastNetSample = null;

async function readNetStat() {
  const out = await run('netstat', ['-ib']);
  const lines = out.trim().split('\n').slice(1);
  const map = {};
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const name = parts[0];
    // pick the highest ibytes/obytes row for this interface
    const ibytes = num(parts[parts.length - 5]);
    const obytes = num(parts[parts.length - 4]);
    if (!map[name] || ibytes + obytes > map[name].ibytes + map[name].obytes) {
      const linkMatch = line.match(/<Link#\d+>/);
      const speedMatch = line.match(/(\d+(?:\.\d+)?)\s*(Gbps|Mbps)/);
      map[name] = {
        name,
        ibytes,
        obytes,
        link: !!linkMatch,
        speed: speedMatch ? `${speedMatch[1]} ${speedMatch[2]}` : null,
      };
    }
  }
  return map;
}

async function collectNetwork() {
  const [stats, ifconfig, dns, routeOut] = await Promise.all([
    readNetStat(),
    run('ifconfig'),
    run('scutil', ['--dns']),
    run('route', ['-n', 'get', 'default']),
  ]);

  // parse ifconfig into blocks
  const blocks = ifconfig.split(/\n(?=\w)/);
  const interfaces = [];
  let tunnelRx = 0;
  let tunnelTx = 0;
  let tunnelCount = 0;

  for (const block of blocks) {
    const nameMatch = block.match(/^(\w+):/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const st = stats[name];
    const active = !!st && st.link && (st.ibytes > 0 || st.obytes > 0);
    const isLoopback = /^lo\d/.test(name);
    if (isLoopback) continue;
    if (/^(gif|stf|awdl|llw|utun|bridge|ap|anpi|vmenet)/.test(name) && !active) continue;

    const addrMatch = block.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    const netmask = block.match(/netmask (0x[0-9a-f]+)/i);
    const macMatch = block.match(/ether ([0-9a-f:]{11,17})/i);
    const mediaMatch = block.match(/media: (.+)/);
    const v6 = block.match(/inet6 ([0-9a-f:]+)/i);

    // VPN/PPP tunnels each expose a duplicate address for the same host;
    // count their traffic but keep them out of the per-interface table.
    const isTunnel = /^(utun|ipsec|gpd|ppp)/.test(name);

    // derive prefix length from hex netmask
    let cidr = '';
    if (addrMatch && netmask) {
      const bits = netmask[1].slice(2).split('').reduce((acc, ch) => {
        const n = parseInt(ch, 16);
        return acc + ((n & 8) ? 1 : 0) + ((n & 4) ? 1 : 0) + ((n & 2) ? 1 : 0) + ((n & 1) ? 1 : 0);
      }, 0);
      cidr = `${addrMatch[1]}/${bits}`;
    }

    const io = windowThroughput(name, st);
    if (isTunnel) {
      tunnelRx += io.rx;
      tunnelTx += io.tx;
      tunnelCount++;
      continue;
    }

    // skip interfaces with no address and no traffic — they're dormant
    // radios/tunnels that would otherwise clutter the inventory
    if (!addrMatch && !active && !(st && (st.ibytes > 0 || st.obytes > 0))) continue;

    interfaces.push({
      name,
      active,
      address: addrMatch ? addrMatch[1] : null,
      cidr,
      ipv6: v6 ? v6[1] : null,
      mac: macMatch ? padMac(macMatch[1]) : null,
      media: mediaMatch ? mediaMatch[1].replace(/\(.*\)/, '').trim() : null,
      linkSpeed: st && st.speed ? st.speed : null,
      rx: io.rx,
      tx: io.tx,
      rxTotal: st ? st.ibytes : 0,
      txTotal: st ? st.obytes : 0,
    });
  }

  interfaces.sort((a, b) => (b.active - a.active) || (b.rx + b.tx) - (a.rx + a.tx));

  const loFilter = interfaces.filter((i) => i.name !== 'lo0');
  const primaryIface =
    loFilter.find((i) => i.active && i.address && /^en\d/.test(i.name)) ||
    loFilter.find((i) => i.active && i.address && !/^(utun|ipsec)/.test(i.name)) ||
    loFilter.find((i) => i.active) ||
    null;

  // gateway + dns (routeOut already resolved above)
  const gwMatch = routeOut.match(/gateway: ([\d.]+)/);
  const dnsServers = [...new Set([...dns.matchAll(/nameserver\[\d+\] : ([\d.a-f:]+)/g)].map((m) => m[1]))];

  // wifi ssid
  let ssid = null;
  if (primaryIface && /^en/.test(primaryIface.name)) {
    const wifi = await run('networksetup', ['-getairportnetwork', primaryIface.name], 4000);
    const m = wifi.match(/Current Wi-Fi Network: (.+)/);
    if (m) ssid = m[1].trim();
  }

  return {
    interfaces,
    primary: primaryIface,
    ssid,
    gateway: gwMatch ? gwMatch[1] : null,
    dns: dnsServers,
    tunnels: { count: tunnelCount, rx: tunnelRx, tx: tunnelTx },
    totalRx: loFilter.reduce((a, i) => a + i.rx, 0) + tunnelRx,
    totalTx: loFilter.reduce((a, i) => a + i.tx, 0) + tunnelTx,
  };
}

function windowThroughput(name, st) {
  if (!st) return { rx: 0, tx: 0 };
  const now = Date.now();
  if (!lastNetSample) {
    lastNetSample = { at: now, data: {} };
  }
  const prev = lastNetSample.data[name];
  const dt = (now - lastNetSample.at) / 1000;
  let rx = 0;
  let tx = 0;
  if (prev && dt > 0.05) {
    rx = Math.max(0, (st.ibytes - prev.ibytes) / dt);
    tx = Math.max(0, (st.obytes - prev.obytes) / dt);
  }
  lastNetSample.data[name] = { ibytes: st.ibytes, obytes: st.obytes, at: now };
  return { rx, tx };
}

/* ------------------------------------------------------------------ */
/* latency / internet speed probe                                     */
/* ------------------------------------------------------------------ */

const pingCache = { at: 0, data: null };
const speedCache = { at: 0, data: null };

async function measurePing() {
  const targets = [
    { name: 'Cloudflare', host: '1.1.1.1' },
    { name: 'Google DNS', host: '8.8.8.8' },
    { name: 'Google', host: 'google.com' },
  ];
  const results = await Promise.all(
    targets.map(async (t) => {
      const out = await run('ping', ['-c', '5', '-t', '4', t.host], 6000);
      const times = [...out.matchAll(/time=([\d.]+) ms/g)].map((m) => num(m[1]));
      const lossMatch = out.match(/([\d.]+)% packet loss/);
      return {
        name: t.name,
        host: t.host,
        avg: times.length ? +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : null,
        min: times.length ? Math.min(...times) : null,
        max: times.length ? Math.max(...times) : null,
        jitter: times.length > 1 ? +(Math.max(...times) - Math.min(...times)).toFixed(1) : null,
        loss: lossMatch ? num(lossMatch[1]) : times.length ? 0 : 100,
      };
    })
  );

  const reachable = results.filter((r) => r.avg != null);
  const best = reachable.sort((a, b) => a.avg - b.avg)[0] || null;

  return {
    at: Date.now(),
    online: reachable.length > 0,
    targets: results,
    best: best ? { name: best.name, avg: best.avg } : null,
  };
}

async function measureSpeed() {
  // DOWNLOAD — time a fixed-size payload
  const dlUrl = 'https://speed.cloudflare.com/__down?bytes=10000000';
  const t0 = Date.now();
  const dl = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{speed_download}', '--max-time', '20', dlUrl], 24000);
  const dlSeconds = (Date.now() - t0) / 1000;
  const downBps = num(dl.trim());

  // UPLOAD — needs a real body; a temp file avoids shell/stdin buffering
  let upBps = 0;
  const tmp = path.join(os.tmpdir(), `sysmon-speed-${process.pid}.bin`);
  try {
    const sizeMb = 5;
    const buf = Buffer.alloc(1024 * 1024, 0x61);
    const parts = [];
    for (let i = 0; i < sizeMb; i++) parts.push(buf);
    fs.writeFileSync(tmp, Buffer.concat(parts));
    const up = await run(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{speed_upload}', '--max-time', '25', '-X', 'POST', '--data-binary', `@${tmp}`, 'https://speed.cloudflare.com/__up'],
      30000
    );
    upBps = num(up.trim());
  } catch (e) {
    upBps = 0;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }

  const mbps = (bps) => +(bps / 1e6 * 8).toFixed(1);

  return {
    at: Date.now(),
    download: mbps(downBps),
    upload: mbps(upBps),
    downloadBps: downBps,
    uploadBps: upBps,
    duration: +dlSeconds.toFixed(1),
    source: 'speed.cloudflare.com',
  };
}

/* ------------------------------------------------------------------ */
/* ports                                                              */
/* ------------------------------------------------------------------ */

async function collectPorts() {
  const ports = [];
  const seen = new Set();

  // TCP listeners via netstat (reliable on macOS, includes PID + process)
  const tcp = await run('netstat', ['-anv', '-p', 'tcp'], 8000);
  for (const line of tcp.split('\n')) {
    if (!/\bLISTEN\b/.test(line)) continue;
    const m = line.match(/([\d.]+|\([^)]*\)|\*)\.(\d+)\s+\S+\s+LISTEN/);
    if (!m) continue;
    const rest = line.trim().split(/\s+/);
    const procField = rest[rest.length - 1];
    const pm = procField.match(/^(.+?):(\d+)$/);
    const address = m[1];
    const port = num(m[2], -1);
    if (port < 0) continue;
    const command = pm ? pm[1] : 'unknown';
    const pid = pm ? num(pm[2]) : 0;
    const key = `tcp-${port}-${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({ port, pid, command, address, protocol: 'TCP' });
  }

  // Supervisor-mode listening sockets (PID 0 / unnamed) — common for system services
  const lsofTcp = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], 8000);
  for (const line of lsofTcp.trim().split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const nameField = parts.slice(8).join(' ');
    const m = nameField.match(/:([\d]+)(?:\s*\(LISTEN\))?$/);
    if (!m) continue;
    const port = num(m[1], -1);
    const pid = num(parts[1]);
    if (port < 0) continue;
    const key = `tcp-${port}-${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({
      port,
      pid,
      command: parts[0],
      user: parts[2],
      address: nameField.replace(/:([\d]+)(?:\s*\(LISTEN\))?$/, ''),
      protocol: 'TCP',
    });
  }

  // netstat reports listening sockets twice (kernel + owner view); when the
  // owner is known, drop the banner-less PID 0 duplicate for that port.
  const ownedPorts = new Set(ports.filter((p) => p.pid > 0).map((p) => p.port));
  for (let i = ports.length - 1; i >= 0; i--) {
    if (ports[i].pid === 0 && ownedPorts.has(ports[i].port)) ports.splice(i, 1);
  }

  // Bound UDP sockets (best-effort; skip unassigned wildcard sockets)
  const udpOut = await run('lsof', ['-nP', '-iUDP'], 6000);
  for (const line of udpOut.trim().split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const nameField = parts.slice(8).join(' ');
    const m = nameField.match(/:([\d]+)(?:\s*->.*)?$/);
    if (!m || m[1] === '*' || m[1] === '0') continue;
    const key = `udp-${num(m[1])}-${parts[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({
      port: num(m[1]),
      pid: num(parts[1]),
      command: parts[0],
      user: parts[2],
      address: nameField.replace(/:([\d]+)(?:\s*->.*)?$/, ''),
      protocol: 'UDP',
    });
  }

  ports.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));

  const byProcess = {};
  for (const p of ports) {
    byProcess[p.command] = byProcess[p.command] || { command: p.command, count: 0, ports: [] };
    byProcess[p.command].count++;
    byProcess[p.command].ports.push(p.port);
  }

  return {
    count: ports.length,
    tcpCount: ports.filter((p) => p.protocol === 'TCP').length,
    udpCount: ports.filter((p) => p.protocol === 'UDP').length,
    ports,
    byProcess: Object.values(byProcess).sort((a, b) => b.count - a.count),
  };
}

/* ------------------------------------------------------------------ */
/* processes                                                          */
/* ------------------------------------------------------------------ */

async function collectProcesses() {
  const out = await run('ps', ['-axo', 'pid,ppid,user,%cpu,%mem,rss,etime,command', '-r'], 6000);
  const lines = out.trim().split('\n').slice(1);
  const procs = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const pid = num(parts[0]);
    const ppid = num(parts[1]);
    const user = parts[2];
    const cpu = num(parts[3]);
    const mem = num(parts[4]);
    const rss = num(parts[5]) * 1024;
    const etime = parts[6];
    const command = parts.slice(7).join(' ');
    procs.push({ pid, ppid, user, cpu, mem, rss, etime, command });
  }

  const topCpu = procs.slice(0, 12);
  const topMem = procs.slice().sort((a, b) => b.rss - a.rss).slice(0, 12);

  const level = (p) => {
    const short = p.command.split(/[\/\s]/).filter(Boolean)[0] || '';
    if (p.pid === 0 || p.pid === 1) return 'kernel';
    if (p.ppid === 1) return 'daemon';
    if (/^(login|bash|zsh|sh|Terminal|iTerm)/.test(short)) return 'session';
    return 'user';
  };

  return {
    total: procs.length,
    topCpu,
    topMem,
    tree: procs.map((p) => ({ ...p, level: level(p) })).sort((a, b) => a.pid - b.pid),
  };
}

/* ------------------------------------------------------------------ */
/* connected devices (LAN discovery)                                  */
/* ------------------------------------------------------------------ */

function parseArp(out, map) {
  for (const line of out.split('\n')) {
    // e.g.  ? (192.168.1.1) at 3c:7c:3f:11:22:33 on en0 ifscope [ethernet]
    const m = line.match(/\(([\d.]+)\) at ([0-9a-f:]{11,17})(?:.*?on (\w+))?/i);
    if (!m) continue;
    if (/incomplete/i.test(m[2])) continue;
    const ip = m[1];

    // skip broadcast / multicast / link-local noise — they aren't real hosts
    const first = num(ip.split('.')[0]);
    if (first >= 224) continue;                       // multicast + broadcast
    if (/^169\.254\./.test(ip)) continue;            // link-local
    const mac = padMac(m[2].toLowerCase());
    if (mac === 'ff:ff:ff:ff:ff:ff') continue;        // broadcast
    if (mac === '00:00:00:00:00:00') continue;
    if (/^01:00:5e/.test(mac) || /^33:33/.test(mac)) continue; // multicast MACs

    const iface = m[3] || '';
    // only keep the LAN interface to avoid VPN/Docker bridge duplicates
    if (map.has(ip)) continue;
    map.set(ip, {
      ip,
      mac,
      name: '',
      vendor: vendorFor(mac),
      iface,
      source: 'arp',
    });
  }
}

async function collectDevices(sweep = true) {
  const ifaceInfo = (await collectNetwork()).primary;

  // Prefer a real LAN gateway: ask which router sits on the primary interface.
  // (A VPN such as utun10 often owns the default route, so `route get default`
  //  alone would miss the actual home/office router.)
  const lanBase = ifaceInfo && ifaceInfo.address ? ifaceInfo.address.split('.').slice(0, 3).join('.') : null;
  let gatewayIp = null;
  if (lanBase) {
    // probe the conventional gateway candidate first, then trust the ARP hit
    const candidates = [`${lanBase}.1`, `${lanBase}.254`];
    for (const c of candidates) {
      await run('ping', ['-c', '1', '-W', '300', c], 1200);
    }
    const arpNow = await run('arp', ['-an'], 5000);
    for (const c of candidates) {
      if (new RegExp(`\\(${c.replace(/\./g, '\\.')}\\) at [0-9a-f:]`, 'i').test(arpNow)) {
        gatewayIp = c;
        break;
      }
    }
  }
  if (!gatewayIp && global.__gatewayIp && lanBase && global.__gatewayIp.startsWith(lanBase + '.')) {
    gatewayIp = global.__gatewayIp;
  }

  const devices = new Map();

  // 1. seed from the current ARP cache
  parseArp(await run('arp', ['-an'], 5000), devices);

  // 2. active ping sweep of the primary /24 to refresh the table
  if (sweep && ifaceInfo && ifaceInfo.cidr && ifaceInfo.cidr.includes('/')) {
    const prefix = num(ifaceInfo.cidr.split('/')[1]);
    if (prefix >= 24 && lanBase) {
      const targets = [];
      for (let i = 1; i <= 254; i++) targets.push(`${lanBase}.${i}`);
      await pingSweep(targets);
      parseArp(await run('arp', ['-an'], 5000), devices);
      for (const d of devices.values()) if (d.source === 'arp') d.source = 'sweep';
    }
  }

  const list = [...devices.values()].map((d) => {
    const isSelf = !!ifaceInfo && d.ip === ifaceInfo.address;
    const isGateway = !!gatewayIp && d.ip === gatewayIp;
    return {
      ...d,
      isSelf,
      isGateway,
      name: isGateway ? 'Router / Gateway' : isSelf ? 'This Mac' : d.vendor || 'Unknown device',
    };
  });

  list.sort((a, b) => (b.isGateway - a.isGateway) || (b.isSelf - a.isSelf) || ipSort(a.ip, b.ip));

  return {
    count: list.length,
    devices: list,
    gateway: gatewayIp,
    subnet: ifaceInfo ? ifaceInfo.cidr : null,
    self: ifaceInfo ? ifaceInfo.address : null,
    online: list.length,
  };
}

// ping sweep with bounded parallelism
async function pingSweep(targets, concurrency = 48) {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < targets.length) {
      const host = targets[idx++];
      await run('ping', ['-c', '1', '-W', '200', host], 1200);
    }
  });
  await Promise.all(workers);
}

function ipSort(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function padMac(mac) {
  if (!mac) return null;
  return mac
    .split(':')
    .map((h) => h.padStart(2, '0'))
    .join(':');
}

function vendorFor(mac) {
  const prefix = padMac(mac).toUpperCase().slice(0, 8);
  const table = {
    '00:1C:B3': 'Apple', '3C:22:FB': 'Apple', 'F0:18:98': 'Apple', 'A4:83:E7': 'Apple',
    'DC:A6:32': 'Raspberry Pi', 'B8:27:EB': 'Raspberry Pi', 'E4:5F:01': 'Raspberry Pi',
    '00:17:88': 'Philips Hue', '44:65:0D': 'Amazon', 'FC:65:DE': 'Amazon', '68:37:E9': 'Amazon',
    '00:1A:79': 'Roku', 'B0:A7:37': 'Roku', 'AC:3A:7A': 'Roku',
    '00:0C:29': 'VMware', '52:54:00': 'QEMU/KVM', '00:15:5D': 'Hyper-V',
    '70:EE:50': 'Netatmo', '18:B4:30': 'Nest', '64:16:66': 'Nest',
    '00:24:E4': 'Withings', 'F4:F5:D8': 'Google', '1C:F2:9A': 'Google',
    '00:23:76': 'Hikvision', '44:19:B6': 'Hikvision',
    'D8:BB:C1': 'Samsung', '8C:77:12': 'Samsung', 'CC:6E:A4': 'Samsung',
    '64:16:7F': 'Samsung', 'F8:04:2E': 'Xiaomi',
    '50:02:91': 'Espressif', '24:0A:C4': 'Espressif', '30:AE:A4': 'Espressif',
    'CC:50:E3': 'Espressif', '84:CC:A8': 'Espressif',
    'B8:27:EB ': 'Raspberry Pi',
  };
  return table[prefix] || '';
}

/* ------------------------------------------------------------------ */
/* power & battery (pmset + ioreg)                                     */
/* ------------------------------------------------------------------ */

let energyCache = { at: 0, data: null };

function parsePowerSource(out) {
  const src = out.match(/Now drawing from '([^']+)'/);
  const source = src ? (src[1].toLowerCase().includes('ac') ? 'AC' : 'Battery') : null;
  const pct = out.match(/(\d+)%/);
  const state = out.match(/;\s*(\w+);/);
  const rem = out.match(/(\d+):(\d+)\s+remaining/);
  return {
    source,
    percent: pct ? num(pct[1]) : null,
    state: state ? state[1].toLowerCase() : null,
    remainingMinutes: rem ? num(rem[1]) * 60 + num(rem[2]) : null,
  };
}

function parseThermal(out) {
  const pick = (label) => {
    const line = out.split('\n').find((l) => l.includes(label));
    if (!line) return null;
    if (line.includes('No ') && line.includes(' recorded')) return 'none';
    const m = line.match(/:?\s*([A-Za-z_][^]*)$/);
    return m ? m[1].trim() : 'unknown';
  };
  return {
    thermal: pick('thermal warning level'),
    performance: pick('performance warning level'),
    cpuPower: pick('CPU power status'),
  };
}

function parseSmartBattery(out) {
  const kv = {};
  for (const m of out.matchAll(/^[ \t]*"(\w+)"\s*=\s*([^\n]+)/gm)) {
    const v = m[2].trim();
    if (v === 'Yes') kv[m[1]] = true;
    else if (v === 'No') kv[m[1]] = false;
    else if (!isNaN(Number(v)) && !/^[<{]/.test(v)) kv[m[1]] = Number(v);
    else kv[m[1]] = v;
  }
  return kv;
}

async function collectEnergy() {
  const now = Date.now();
  if (energyCache.data && now - energyCache.at < 30000) return energyCache.data;
  // never prompt for a password — only use powermetrics when passwordless
  // sudo already works, otherwise degrade to "unavailable" with a reason.
  const probe = await run('sh', ['-c', 'sudo -n true 2>/dev/null && echo SUDO_OK'], 3000);
  if (!probe.includes('SUDO_OK')) {
    energyCache = { at: now, data: { available: false, reason: 'requires passwordless sudo' } };
    return energyCache.data;
  }
  const out = await run(
    'sudo',
    ['-n', 'powermetrics', '-n', '1', '-i', '100', '--samplers', 'cpu_power,gpu_power,thermal', '-f', 'text'],
    8000
  );
  const data = {
    available: true,
    cpu: (out.match(/CPU Power:\s*([\d.]+)\s*mW/) || [])[1] != null ? num(out.match(/CPU Power:\s*([\d.]+)\s*mW/)[1]) : null,
    gpu: (out.match(/GPU Power:\s*([\d.]+)\s*mW/) || [])[1] != null ? num(out.match(/GPU Power:\s*([\d.]+)\s*mW/)[1]) : null,
    cpuTempC: (out.match(/CPU die temperature:\s*([\d.]+)/) || [])[1] != null ? num(out.match(/CPU die temperature:\s*([\d.]+)/)[1]) : null,
    gpuTempC: (out.match(/GPU die temperature:\s*([\d.]+)/) || [])[1] != null ? num(out.match(/GPU die temperature:\s*([\d.]+)/)[1]) : null,
  };
  energyCache = { at: now, data };
  return data;
}

async function collectPower() {
  const [battOut, thermOut, ioregOut] = await Promise.all([
    run('pmset', ['-g', 'batt'], 4000),
    run('pmset', ['-g', 'therm'], 4000),
    run('ioreg', ['-rn', 'AppleSmartBattery'], 4000),
  ]);

  const b = parsePowerSource(battOut);
  const therm = parseThermal(thermOut);
  const kv = ioregOut.trim() ? parseSmartBattery(ioregOut) : null;

  const battery = kv
    ? {
        present: true,
        percent: kv.CurrentCapacity != null ? kv.CurrentCapacity : b.percent,
        designCapacityMah: kv.DesignCapacity != null ? kv.DesignCapacity : null,
        maxCapacityMah: kv.NominalChargeCapacity != null ? kv.NominalChargeCapacity : kv.MaxCapacity != null ? kv.MaxCapacity : null,
        // NominalChargeCapacity is the current full-charge capacity in mAh;
        // MaxCapacity is percent-scale and must not be used for health.
        healthPercent: kv.DesignCapacity && kv.NominalChargeCapacity != null
          ? +((kv.NominalChargeCapacity / kv.DesignCapacity) * 100).toFixed(1)
          : null,
        cycleCount: kv.CycleCount != null ? kv.CycleCount : null,
        // ioreg reports deci-Kelvin; convert to °C
        temperatureC: kv.Temperature != null ? +((kv.Temperature - 2731.5) / 10).toFixed(1) : null,
        voltageMv: kv.Voltage != null ? kv.Voltage : null,
        amperageMa: kv.Amperage != null ? Number(BigInt.asIntN(64, BigInt(kv.Amperage))) : null,
        isCharging: !!kv.IsCharging,
        externalConnected: !!kv.ExternalConnected,
        fullyCharged: !!kv.FullyCharged,
        // ioreg TimeRemaining is in minutes on current macOS
        timeRemaining: kv.TimeRemaining != null ? kv.TimeRemaining : b.remainingMinutes,
      }
    : null;

  return {
    available: true,
    at: Date.now(),
    source: b.source,
    battery,
    thermal: therm,
    energy: await collectEnergy(),
  };
}

/* ------------------------------------------------------------------ */
/* disk health / S.M.A.R.T. (diskutil)                                 */
/* ------------------------------------------------------------------ */

let diskCache = { at: 0, data: null };

async function collectDiskHealth() {
  const now = Date.now();
  if (diskCache.data && now - diskCache.at < 15000) return diskCache.data;

  const list = await run('diskutil', ['list'], 6000);
  const physical = [];
  for (const line of list.split('\n')) {
    const m = line.match(/^\/dev\/(disk\d+)\s+\((internal|external), physical\):/);
    if (m) physical.push({ id: m[1], kind: m[2] });
  }

  const disks = [];
  for (const d of physical) {
    const info = await run('diskutil', ['info', d.id], 6000);
    const grab = (re) => {
      const m = info.match(re);
      return m ? m[1].trim() : null;
    };
    const sizeMatch = info.match(/Disk Size:\s*([\d.]+)\s*(\w+)/);
    disks.push({
      id: d.id,
      kind: d.kind,
      name: grab(/Device \/ Media Name:\s*(.+)/),
      protocol: grab(/Protocol:\s*(.+)/),
      smart: grab(/SMART Status:\s*(.+)/),
      size: sizeMatch ? { value: num(sizeMatch[1]), unit: sizeMatch[2] } : null,
    });
  }

  const data = {
    available: true,
    at: Date.now(),
    disks,
    failing: disks.filter((x) => /fail/i.test(x.smart || '')).length,
  };
  diskCache = { at: Date.now(), data };
  return data;
}

/* ------------------------------------------------------------------ */
/* open file descriptors (sysctl)                                      */
/* ------------------------------------------------------------------ */

async function collectFds() {
  const out = await run('sysctl', ['-n', 'kern.num_files', 'kern.maxfiles', 'kern.maxfilesperproc'], 3000);
  const [open, max, maxPerProc] = out.trim().split('\n').map((s) => num(s));
  return {
    open,
    max,
    maxPerProc,
    percent: max ? +((open / max) * 100).toFixed(1) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* network reliability — packet-level errors (netstat -s)              */
/* ------------------------------------------------------------------ */

let lastNetErr = null;

function countersToObj(out, map) {
  const res = {};
  for (const [key, re] of Object.entries(map)) {
    const m = out.match(re);
    res[key] = m ? num(m[1]) : 0;
  }
  return res;
}

async function collectNetErrors() {
  const [tcp, udp] = await Promise.all([
    run('netstat', ['-s', '-p', 'tcp'], 6000),
    run('netstat', ['-s', '-p', 'udp'], 6000),
  ]);
  const t = countersToObj(tcp, {
    retransmitTimeouts: /^[ \t]*(\d+)[ \t]+retransmit timeout/m,
    retransmittedSegments: /^[ \t]*(\d+)[ \t]+segment retransmitted(?! in)/m,
    outOfOrder: /^[ \t]*(\d+)[ \t]+out-of-order packet/m,
    badChecksum: /^[ \t]*(\d+)[ \t]+discarded for bad checksum/m,
    listenOverflow: /^[ \t]*(\d+)[ \t]+listen queue overflow/m,
    badConnectionAttempts: /^[ \t]*(\d+)[ \t]+bad connection attempt/m,
  });
  const u = countersToObj(udp, {
    received: /^[ \t]*(\d+)[ \t]+datagrams received/m,
    sent: /^[ \t]*(\d+)[ \t]+datagrams output/m,
    badChecksum: /^[ \t]*(\d+)[ \t]+with bad checksum/m,
    noSocket: /^[ \t]*(\d+)[ \t]+dropped due to no socket/m,
    fullBuffers: /^[ \t]*(\d+)[ \t]+dropped due to full socket buffers/m,
  });

  const totals = { tcp: t, udp: u };
  let delta = null;
  if (lastNetErr) {
    const dd = (cur, prev) => Math.max(0, cur - prev);
    delta = {
      retransmitTimeouts: dd(t.retransmitTimeouts, lastNetErr.totals.tcp.retransmitTimeouts),
      retransmittedSegments: dd(t.retransmittedSegments, lastNetErr.totals.tcp.retransmittedSegments),
      outOfOrder: dd(t.outOfOrder, lastNetErr.totals.tcp.outOfOrder),
      tcpBadChecksum: dd(t.badChecksum, lastNetErr.totals.tcp.badChecksum),
      udpBadChecksum: dd(u.badChecksum, lastNetErr.totals.udp.badChecksum),
      noSocket: dd(u.noSocket, lastNetErr.totals.udp.noSocket),
      fullBuffers: dd(u.fullBuffers, lastNetErr.totals.udp.fullBuffers),
      listenOverflow: dd(t.listenOverflow, lastNetErr.totals.tcp.listenOverflow),
    };
  }
  lastNetErr = { totals };
  return { available: true, at: Date.now(), totals, delta };
}

/* ------------------------------------------------------------------ */
/* per-app network usage (nettop)                                      */
/* ------------------------------------------------------------------ */

let lastAppNet = null;

async function collectAppNet() {
  const out = await run('nettop', ['-P', '-L', '1', '-J', 'bytes_in,bytes_out,interface,state'], 8000);
  const now = Date.now();
  const prevData = lastAppNet ? lastAppNet.data : {};
  const data = {};
  const apps = [];

  for (const line of out.split('\n')) {
    if (!line.trim() || line.startsWith(',')) continue;
    const cols = line.split(',');
    if (cols.length < 5) continue;
    const name = cols[0].trim();
    if (!name || !name.includes('.')) continue;
    const [proc, pid] = name.split(/\.(?=\d+$)/);
    const ib = num(cols[3]);
    const ob = num(cols[4]);
    if (!proc || (ib === 0 && ob === 0)) continue;
    const prev = prevData[name];
    const dt = prev ? (now - prev.at) / 1000 : 0;
    let rx = 0;
    let tx = 0;
    if (prev && dt > 0.05) {
      rx = Math.max(0, (ib - prev.ibytes) / dt);
      tx = Math.max(0, (ob - prev.obytes) / dt);
    }
    data[name] = { ibytes: ib, obytes: ob, at: now };
    apps.push({ name: proc, pid: num(pid), rx, tx, rxTotal: ib, txTotal: ob });
  }

  lastAppNet = { at: now, data };
  const list = apps.sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx)).slice(0, 10);
  return {
    available: true,
    at: now,
    totalRx: list.reduce((a, b) => a + b.rx, 0),
    totalTx: list.reduce((a, b) => a + b.tx, 0),
    apps: list,
  };
}

/* ------------------------------------------------------------------ */
/* local service discovery (dns-sd / Bonjour)                          */
/* ------------------------------------------------------------------ */

let serviceCache = { at: 0, data: null, building: false };
const SERVICES_TTL = 90000; // full mDNS sweep is expensive; cache it

const SERVICE_FRIENDLY = {
  '_airplay': 'AirPlay', '_raop': 'AirPlay Receiver', '_companion-link': 'HomeKit',
  '_http': 'Web Server', '_googlecast': 'Chromecast', '_spotify-connect': 'Spotify',
  '_ssh': 'SSH', '_smb': 'File Sharing (SMB)', '_afpovertcp': 'File Sharing (AFP)',
  '_printer': 'AirPrint Printer', '_scanner': 'Scanner', '_rfb': 'Screen Sharing',
  '_homekit': 'HomeKit Accessory', '_ipps': 'Printer (IPP)', '_ipp': 'Printer (IPP)',
  '_sleep-proxy': 'Wake on Demand', '_airport': 'AirPort', '_dns-sd': 'Bonjour',
  '_openclaw-gw': 'OpenClaw Gateway', '_asquic': 'Audio/Video (QUIC)',
};

// run fn over items with bounded concurrency, preserving order
async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// dns-sd streams forever; run() kills it at the timeout and keeps the partial
// stdout we collected — replies for cached services arrive within ~100ms, so
// the kill timeout is the real per-call cost, not the data.
async function dnsBrowseType(type) {
  const out = await run('dns-sd', ['-B', type, 'local'], 1400);
  const instances = [];
  const seen = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/Add\s+.*?\.\s+(_[\w-]+)\.(_tcp|_udp)\.\s+(.+)$/);
    if (!m || `${m[1]}.${m[2]}` !== type) continue;
    const name = m[3].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    instances.push(name);
  }
  return instances;
}

async function dnsLookup(instance, type) {
  const out = await run('dns-sd', ['-L', instance, type, 'local'], 1200);
  const reach = out.match(/can be reached at (\S+?):(\d+)(?: \(interface (\d+)\))?/);
  if (!reach) return null;
  const txt = {};
  for (const tok of out.split(/\s+/)) {
    const kv = tok.match(/^([\w-]+)=(.+)$/);
    if (kv && kv[1].toLowerCase() !== 'txtvers') txt[kv[1].toLowerCase()] = kv[2];
  }
  return {
    host: reach[1].replace(/\.$/, ''),
    port: num(reach[2]),
    interface: reach[3] ? num(reach[3]) : null,
    txt,
  };
}

async function dnsResolve(host) {
  const out = await run('dns-sd', ['-G', 'v4v6', host], 1000);
  const ips = [];
  for (const line of out.split('\n')) {
    if (!/\bAdd\s/.test(line)) continue;   // lines start with a timestamp column
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const ip = parts[5];   // 0=ts 1=Add 2=flags 3=IF 4=host 5=address 6=TTL
    if (parts.includes('No')) continue;            // "No Such Record" (e.g. no AAAA)
    if (/^0+$/.test(ip) || /^([0:]+%?<.*>?)?$/.test(ip)) continue; // empty/zero v6
    if (ip.startsWith('127.')) continue;           // loopback
    const g = ip.replace(/%\S+$/, '').split(':');
    if (g.length === 8 && g.slice(0, 7).every((x) => /^0*$/.test(x)) && /^0*1$/.test(g[7])) continue; // ::1
    if (!ips.includes(ip)) ips.push(ip);
  }
  return ips;
}

async function sweepServices() {
  const t0 = Date.now();

  // 1) what service types are advertising?
  const out = await run('dns-sd', ['-B', '_services._dns-sd._udp', 'local'], 2200);
  const counts = {};
  for (const line of out.split('\n')) {
    // browse lines: "Add  <nr> <nr> .  <_tcp|_udp>.local.  <type>" — the actual
    // service type sits in the instance-name column; the transport is in the
    // service-type column. Match leniently across the numeric/flag fields.
    const m = line.match(/Add\s+[^.\n]*\.\s+(_tcp|_udp)\.local\.\s+(_[\w-]+)/);
    if (!m) continue;
    const type = `${m[2]}.${m[1]}`;
    counts[type] = (counts[type] || 0) + 1;
  }
  const types = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 12);

  // 2) which instances per type? (parallel, bounded)
  const typeResults = await mapConcurrent(types, 6, async (type) => ({
    type,
    instances: (await dnsBrowseType(type)).slice(0, 6),
  }));

  // 3) resolve host:port + TXT for each instance (parallel, bounded)
  const lookups = [];
  for (const r of typeResults) for (const name of r.instances) lookups.push({ type: r.type, name });
  const lookupResults = await mapConcurrent(lookups.slice(0, 30), 10, async ({ type, name }) => {
    const info = await dnsLookup(name, type);
    return { type, name, info };
  });

  const byType = new Map();
  for (const { type, name, info } of lookupResults) {
    if (!info) continue;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push({ name, ...info });
  }

  // 4) resolve distinct hostnames to IPs (parallel, bounded)
  const hosts = [...new Set([...byType.values()].flat().map((i) => i.host))].slice(0, 24);
  const hostIps = {};
  const hostRes = await mapConcurrent(hosts, 10, async (host) => ({ host, ips: await dnsResolve(host) }));
  for (const { host, ips } of hostRes) hostIps[host] = ips;

  const services = types
    .map((type) => {
      const base = type.split('.')[0];
      return {
        type,
        name: SERVICE_FRIENDLY[base] || base.replace(/^_/, ''),
        count: counts[type],
        instances: (byType.get(type) || []).map((i) => ({ ...i, ips: hostIps[i.host] || [] })),
      };
    })
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  return {
    available: out.includes('Browsing for') || services.length > 0,
    at: Date.now(),
    sweepMs: Date.now() - t0,
    hostname: os.hostname(),
    count: services.length,
    services,
  };
}

async function collectServices() {
  const now = Date.now();
  if (serviceCache.data && now - serviceCache.at < SERVICES_TTL) return serviceCache.data;
  if (serviceCache.building) return serviceCache.data || { available: true, building: true, count: 0, services: [] };
  serviceCache.building = true;
  try {
    serviceCache.data = await sweepServices();
    serviceCache.at = Date.now();
  } catch (e) {
    if (!serviceCache.data) serviceCache.data = { available: false, count: 0, services: [] };
    serviceCache.at = Date.now();
  } finally {
    serviceCache.building = false;
  }
  return serviceCache.data;
}

/* ------------------------------------------------------------------ */
/* snapshot aggregation                                               */
/* ------------------------------------------------------------------ */

let snapshotCache = { at: 0, data: null };
const SNAPSHOT_TTL = 900; // ms — prevents hammering the machine

async function buildSnapshot(force = false) {
  const now = Date.now();
  if (!force && snapshotCache.data && now - snapshotCache.at < SNAPSHOT_TTL) {
    return snapshotCache.data;
  }
  const [memory, disk, cpus, net, system] = await Promise.all([
    collectMemory(),
    collectDisk(),
    Promise.resolve(collectCpu()),
    collectNetwork(),
    collectSystem(),
  ]);
  global.__gatewayIp = net.gateway;

  const data = {
    at: now,
    generatedIn: 0,
    system,
    cpu: cpus,
    memory,
    disk,
    network: net,
    uptimeServer: now - startedAt,
  };
  snapshotCache = { at: now, data };
  return data;
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const routes = {
  '/api/system': async () => buildSnapshot(),
  '/api/snapshot': async () => buildSnapshot(true),
  '/api/net': collectNetwork,
  '/api/ping': async () => {
    if (pingCache.data && Date.now() - pingCache.at < 8000) return pingCache.data;
    const data = await measurePing();
    pingCache.at = Date.now();
    pingCache.data = data;
    return data;
  },
  '/api/speed': async () => {
    if (speedCache.data && Date.now() - speedCache.at < 30000) return speedCache.data;
    const data = await measureSpeed();
    speedCache.at = Date.now();
    speedCache.data = data;
    return data;
  },
  '/api/ports': collectPorts,
  '/api/processes': collectProcesses,
  '/api/devices': () => collectDevices(true),
  '/api/power': collectPower,
  '/api/smart': collectDiskHealth,
  '/api/fds': collectFds,
  '/api/neterr': collectNetErrors,
  '/api/appnet': collectAppNet,
  '/api/services': collectServices,
  '/api/health': async () => ({ ok: true, uptime: (Date.now() - startedAt) / 1000, pid: process.pid }),
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (routes[url.pathname]) {
    try {
      const data = await routes[url.pathname]();
      send(res, 200, JSON.stringify(data));
    } catch (err) {
      send(res, 500, JSON.stringify({ error: String(err && err.message || err) }));
    }
    return;
  }

  // static files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');

  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(filePath)] || 'application/octet-stream');
  });
});

server.listen(PORT, HOST, () => {
  const local = `http://${HOST}:${PORT}`;
  process.stdout.write(`\n  \x1b[36m⬤\x1b[0m sysmon running at \x1b[1m${local}\x1b[0m\n`);
  process.stdout.write(`  \x1b[90mpress Ctrl+C to stop\x1b[0m\n\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`\n  \x1b[31m✖\x1b[0m port ${PORT} is already in use.\n`);
    process.stderr.write(`  Is sysmon already running? Try: \x1b[1mlsof -i :${PORT}\x1b[0m\n\n`);
    process.exit(1);
  }
  throw err;
});

module.exports = { server };