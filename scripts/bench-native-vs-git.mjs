// Real native-workspace vs Git checkout measurement on an explicitly configured
// deployment. Does NOT run against a synthetic source-control server.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const configPath = process.argv[2];
if (!configPath) throw Error('Usage: node scripts/bench-native-vs-git.mjs configuration.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const token = process.env.DEVHUB_TOKEN;
const client = process.env.DEVHUB_CLI;
const device = process.env.DEVHUB_BENCH_NET_DEVICE;
if (!token || !client || !device || !/^[a-zA-Z0-9_.:-]+$/.test(device))
  throw Error('DEVHUB_TOKEN, DEVHUB_CLI and dedicated DEVHUB_BENCH_NET_DEVICE are required');
if (!config.native?.server || !config.native?.repository ||
    !config.native?.ref || !config.git?.url || !config.git?.ref ||
    !Array.isArray(config.scenarios) || !config.scenarios.length)
  throw Error('Configuration must describe both backends and scenario selectors');
const passes = Math.min(20, Math.max(1, Number(config.repetitions || 3)));
const runDir = await mkdtemp(join(tmpdir(), 'devhub-native-git-bench-'));
const timeBinary = '/usr/bin/time';
await stat(timeBinary);
const net = async () => {
  const dir = '/sys/class/net/' + device + '/statistics/';
  return {
    rx: Number((await readFile(dir + 'rx_bytes', 'utf8')).trim()),
    tx: Number((await readFile(dir + 'tx_bytes', 'utf8')).trim()),
  };
};
const exec = async (program, args, { cwd, stdin, label } = {}) => {
  const file = join(runDir, 'usage-' + Math.random().toString(16).slice(2));
  const before = await net(), begin = performance.now();
  let errors = '';
  await new Promise((done, reject) => {
    const subprocess = spawn(timeBinary, ['-f', '%U %S %M', '-o', file, program, ...args], {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'],
    });
    subprocess.stderr.on('data', data => { errors += data.toString().slice(-10000); });
    subprocess.once('error', reject);
    subprocess.once('exit', code => code === 0 ? done() : reject(Error((label || program) + ': ' + errors)));
    if (stdin) subprocess.stdin.end(stdin);
  });
  const elapsedMs = performance.now() - begin, after = await net();
  const [user, system, rss] = (await readFile(file, 'utf8')).trim().split(/\s+/).map(Number);
  await rm(file, { force: true });
  return {
    elapsedMs: +elapsedMs.toFixed(2), userCpuSec: user, systemCpuSec: system,
    peakRssKiB: rss, receivedInterfaceBytes: after.rx - before.rx,
    sentInterfaceBytes: after.tx - before.tx,
  };
};
const files = async root => {
  const paths = new Map(), stack = [['', root]];
  while (stack.length) {
    const [relative, path] = stack.pop();
    for (const dirent of await readdir(path, { withFileTypes: true })) {
      if (dirent.name === '.devhub' || dirent.name === '.git') continue;
      const name = relative ? relative + '/' + dirent.name : dirent.name;
      const target = join(path, dirent.name);
      const info = await lstat(target);
      if (info.isDirectory()) stack.push([name, target]);
      else if (info.isSymbolicLink()) paths.set(name, { kind: 'symlink', target: await readlink(target) });
      else if (info.isFile()) {
        const hash = createHash('sha256');
        for await (const piece of createReadStream(target)) hash.update(piece);
        paths.set(name, { kind: 'file', bytes: info.size, sha256: hash.digest('hex') });
      } else throw Error('Unsupported object in workspace: ' + name);
    }
  }
  return paths;
};
const validate = async (nativeDir, gitDir, expected) => {
  const native = await files(nativeDir), git = await files(gitDir);
  if (native.size !== git.size || (expected != null && git.size !== expected))
    throw Error('File-count mismatch: native=' + native.size + ', git=' + git.size + ', expected=' + expected);
  let totalBytes = 0;
  for (const [name, value] of native) {
    if (JSON.stringify(value) !== JSON.stringify(git.get(name)))
      throw Error('Native/Git contents or modes differ at ' + name);
    totalBytes += value.bytes || 0;
  }
  return { selectedPaths: native.size, verifiedContentBytes: totalBytes };
};
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] || null;
const aggregate = list => {
  const latencies = list.map(x => x.elapsedMs).sort((a, b) => a - b);
  const sum = key => list.reduce((n, x) => n + x[key], 0);
  return {
    samples: list.length,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) },
    totalNetworkReceivedBytes: sum('receivedInterfaceBytes'),
    totalNetworkSentBytes: sum('sentInterfaceBytes'),
    totalUserCpuSec: +sum('userCpuSec').toFixed(2),
    totalSystemCpuSec: +sum('systemCpuSec').toFixed(2),
    maximumRssKiB: Math.max(...list.map(x => x.peakRssKiB)),
    individualSamples: list,
  };
};
const results = [];
try {
  for (const scenario of config.scenarios) {
    if (!Array.isArray(scenario.selectors) || !scenario.selectors.length || scenario.selectors.length > 128 ||
        !scenario.selectors.every(s => /^(f|d):[^\\\n\r:]+$/.test(s) && !s.includes('..')))
      throw Error('Scenario requires 1–128 safe sparse selectors');
    const nativeCold = [], gitCold = [], nativeWarm = [], gitWarm = [];
    let verified;
    for (let iteration = 0; iteration < passes; iteration++) {
      const folder = join(runDir, scenario.name.replace(/[^a-z0-9_-]/gi, '_') + '-' + iteration);
      const ndir = join(folder, 'native'), gdir = join(folder, 'git');
      await import('node:fs/promises').then(fs => fs.mkdir(ndir, { recursive: true }));
      await exec(resolve(client), ['init', '--server', config.native.server, '--repository',
        config.native.repository, '--ref', config.native.ref], { cwd: ndir });
      const selectArgs = ['select'];
      for (const s of scenario.selectors) selectArgs.push(s.startsWith('f:') ? '--file' : '--dir', s.slice(2));
      await exec(resolve(client), selectArgs, { cwd: ndir });
      nativeCold.push(await exec(resolve(client), ['sync', '--materialize'], { cwd: ndir, label: 'native cold sync' }));
      gitCold.push(await exec('git', ['clone', '--filter=blob:none', '--no-checkout', '--single-branch',
        '--branch', config.git.ref, config.git.url, gdir], { label: 'Git filtered clone' }));
      const gitPatterns = scenario.selectors.map(s => s.startsWith('f:') ?
        '/' + s.slice(2) : '/' + s.slice(2).replace(/\/$/, '') + '/**').join('\n') + '\n';
      await exec('git', ['-C', gdir, 'sparse-checkout', 'set', '--no-cone', '--stdin'], { stdin: gitPatterns });
      const checkout = await exec('git', ['-C', gdir, 'checkout', '--force'], { label: 'Git sparse checkout' });
      const clone = gitCold[gitCold.length - 1];
      clone.elapsedMs += checkout.elapsedMs;
      clone.receivedInterfaceBytes += checkout.receivedInterfaceBytes;
      clone.sentInterfaceBytes += checkout.sentInterfaceBytes;
      clone.userCpuSec += checkout.userCpuSec;
      clone.systemCpuSec += checkout.systemCpuSec;
      clone.peakRssKiB = Math.max(clone.peakRssKiB, checkout.peakRssKiB);
      verified = await validate(ndir, gdir, scenario.expectedPaths);
      nativeWarm.push(await exec(resolve(client), ['sync', '--materialize'], { cwd: ndir }));
      gitWarm.push(await exec('git', ['-C', gdir, 'checkout', '--force'], { label: 'warm Git checkout' }));
      await rm(folder, { recursive: true, force: true });
    }
    results.push({ scenario: scenario.name, ...verified, nativeCold: aggregate(nativeCold),
      gitCold: aggregate(gitCold), nativeWarm: aggregate(nativeWarm), gitWarm: aggregate(gitWarm) });
  }
  console.log(JSON.stringify({
    benchmark: 'real-native-vs-git-sparse-checkout', generatedAt: new Date().toISOString(),
    platform: process.platform, repetitions: passes,
    networkDevice: device,
    note: 'Interface bytes require a dedicated isolated runner; CPU/RSS are process-tree approximations from GNU time.',
    results,
  }, null, 2));
} finally {
  await rm(runDir, { recursive: true, force: true });
}
