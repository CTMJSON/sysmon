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