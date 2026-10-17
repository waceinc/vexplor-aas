/**
 * Mock edge — a remote collector without a PLC, speaking `vexplor.edge/1` (docs/edge-contract.md).
 *
 *     node scripts/mock-edge.mjs --server https://aas.example.com --code 7KQ4-M2XD-9PRT --state ./edge-state
 *     node scripts/mock-edge.mjs --server … --state ./edge-state --batches 10 --interval 1000
 *
 * Registers with the code (first run only — the key and device id are kept in --state), fetches the read list and, once a
 * person has approved it, sends --batches batches of simulated values for every approved tag. Prints one JSON summary.
 * Exit codes: 0 sent, 2 not approved yet, 1 refused or failed.
 *
 * It is the reference client for both server sides (AAS Studio, VEXPLOR Logic Studio Cloud): no dependencies, Node 22.
 * Important: it follows the edge duties of the contract — every batch is written to the --state queue before it is sent
 *    and deleted only after a 2xx; 429/503/5xx/network errors resend the **same** batch (same bootId and seq) with
 *    backoff; 400/413/422 move it to refused/; 401/403 stop and keep the queue. A test drives it against a real server.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTRACT = 'vexplor.edge/1';
const SOFTWARE = { name: 'vexplor-mock-edge', version: '1.0.0' };

/** The seven signed lines (contract §2) */
export function signedText(method, pathAndQuery, timestamp, nonce, device, body) {
  const hash = createHash('sha256').update(body ?? '').digest('hex');
  return [CONTRACT, method, pathAndQuery, String(timestamp), nonce, device, hash].join('\n');
}

export function createMockEdge({ server, stateDir, fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // HTTPS only (contract §7) — plain http just for a server on this machine, as in tests
  const target = new URL(server);
  if (fetchImpl === fetch && target.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw new Error(`the server address must be https:// (got ${target.origin})`);
  }
  mkdirSync(join(stateDir, 'queue'), { recursive: true });
  mkdirSync(join(stateDir, 'refused'), { recursive: true });
  const identityFile = join(stateDir, 'identity.json');
  let identity = existsSync(identityFile) ? JSON.parse(readFileSync(identityFile, 'utf8')) : undefined;
  const bootId = randomUUID();
  let seq = 0;
  const startedAt = new Date(now()).toISOString();
  const stats = { sent: 0, accepted: 0, duplicates: 0, rejected: 0, retries: 0 };

  function keyPair() {
    if (identity?.privateKey) return identity;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
    identity = { privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: pub };
    writeFileSync(identityFile, JSON.stringify(identity, null, 2), { mode: 0o600 });
    return identity;
  }

  /** One signed request; the body is sent exactly as hashed */
  async function call(method, path, body, device = identity?.deviceId, extraHeaders = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Math.floor(now() / 1000);
    const nonce = randomBytes(16).toString('base64url');
    const signature = sign(null, Buffer.from(signedText(method, path, timestamp, nonce, device, text)), keyPair().privateKey).toString('base64url');
    const response = await fetchImpl(new URL(path, server), {
      method,
      headers: {
        'x-edge-device': device,
        'x-edge-timestamp': String(timestamp),
        'x-edge-nonce': nonce,
        'x-edge-signature': `ed25519=${signature}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: text }),
    });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, body: raw ? JSON.parse(raw) : undefined };
  }

  async function register(code, name = 'Mock edge') {
    if (identity?.deviceId) return identity;
    const { publicKey } = keyPair();
    const answer = await call('POST', '/edge/v1/register', { schema: 'vexplor.edge.register/1', code, publicKey, device: { name, software: SOFTWARE } }, 'register');
    if (answer.status !== 201) throw Object.assign(new Error(`register refused: ${answer.status} ${answer.body?.code}`), { answer });
    identity = { ...identity, deviceId: answer.body.deviceId, limits: answer.body.limits };
    writeFileSync(identityFile, JSON.stringify(identity, null, 2), { mode: 0o600 });
    return identity;
  }

  let cached;
  async function readList() {
    const answer = await call('GET', '/edge/v1/read-list', undefined, identity.deviceId, cached ? { 'if-none-match': `"${cached.revision}"` } : {});
    if (answer.status === 304) return cached;
    if (answer.status !== 200) throw Object.assign(new Error(`read list refused: ${answer.status} ${answer.body?.code}`), { answer });
    cached = answer.body;
    return cached;
  }

  /** Simulated value for a tag at a time — deterministic, shaped by the declared type */
  function simulate(tag, index, at) {
    const phase = (at / 10_000 + index) % (2 * Math.PI);
    if (tag.type === 'boolean') return Math.sin(phase) > 0;
    if (tag.type === 'integer') return Math.round(100 + 50 * Math.sin(phase));
    if (tag.type === 'string') return `state-${Math.floor(phase)}`;
    return Math.round((50 + 25 * Math.sin(phase)) * 1000) / 1000;
  }

  /** Queues a batch of one reading per approved tag */
  function enqueue(list, extraSamples = []) {
    const at = now();
    const iso = new Date(at).toISOString();
    const samples = list.interfaces.flatMap((iface) =>
      iface.tags.map((tag, index) => ({ tagId: tag.tagId, observedAt: iso, receivedAt: iso, value: simulate(tag, index, at), quality: 'Good' })),
    );
    seq += 1;
    // The status a real edge sends with every batch (contract §5) — every interface reported as connected
    const status = {
      startedAt,
      queuedBatches: readdirSync(join(stateDir, 'queue')).length,
      droppedBatches: 0,
      software: { name: 'mock-edge', version: '0.0.0' },
      interfaces: list.interfaces.map((iface) => ({ interfaceId: iface.interfaceId, connected: true, lastError: null })),
    };
    const batch = { schema: 'vexplor.edge.batch/1', bootId, seq, readListRevision: list.revision, createdAt: iso, samples: [...samples, ...extraSamples], status };
    writeFileSync(join(stateDir, 'queue', `${bootId}-${String(seq).padStart(8, '0')}.json`), JSON.stringify(batch));
    return batch;
  }

  /** Sends every queued batch in order, following the contract's error table. Returns 'ok' or the stop reason */
  async function flush({ maxAttempts = 6 } = {}) {
    for (const file of readdirSync(join(stateDir, 'queue')).sort()) {
      const path = join(stateDir, 'queue', file);
      const batch = JSON.parse(readFileSync(path, 'utf8'));
      for (let attempt = 0; ; attempt += 1) {
        let answer;
        try {
          answer = await call('POST', '/edge/v1/batches', batch);
        } catch {
          answer = { status: 0 };
        }
        if (answer.status >= 200 && answer.status < 300) {
          stats.sent += 1;
          stats.accepted += answer.body.accepted;
          stats.rejected += answer.body.rejected.length;
          if (answer.body.duplicate) stats.duplicates += 1;
          unlinkSync(path);
          break;
        }
        if ([400, 413, 422].includes(answer.status)) {
          renameSync(path, join(stateDir, 'refused', file));
          break;
        }
        if ([401, 403].includes(answer.status) && answer.body?.code !== 'ClockSkew') return answer.body?.code ?? 'Unauthorized';
        if (attempt + 1 >= maxAttempts) return 'GaveUp';
        stats.retries += 1;
        const retryAfter = Number(answer.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(300_000, 1000 * 2 ** attempt));
      }
    }
    return 'ok';
  }

  return { register, readList, enqueue, flush, stats, bootId, get identity() { return identity; } };
}

async function main(argv) {
  const arg = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : fallback;
  };
  const server = arg('server');
  const stateDir = arg('state', './mock-edge-state');
  if (!server) throw new Error('--server is required');
  const edge = createMockEdge({ server, stateDir });
  if (!edge.identity?.deviceId) {
    const code = arg('code');
    if (!code) throw new Error('--code is required for the first run');
    await edge.register(code, arg('name', 'Mock edge'));
  }
  const list = await edge.readList();
  if (list.state !== 'approved') {
    console.log(JSON.stringify({ deviceId: edge.identity.deviceId, state: list.state, message: 'approve the read list on the server, then run again' }));
    return 2;
  }
  const batches = Number(arg('batches', '3'));
  const interval = Number(arg('interval', String(list.interfaces[0]?.intervalMs ?? 1000)));
  for (let i = 0; i < batches; i += 1) {
    edge.enqueue(list);
    const result = await edge.flush();
    if (result !== 'ok') {
      console.log(JSON.stringify({ deviceId: edge.identity.deviceId, stopped: result, ...edge.stats }));
      return 1;
    }
    if (i + 1 < batches) await new Promise((r) => setTimeout(r, interval));
  }
  console.log(JSON.stringify({ deviceId: edge.identity.deviceId, readListRevision: list.revision, tags: list.interfaces.reduce((n, i) => n + i.tags.length, 0), ...edge.stats }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[FAIL] ${error.message}`);
      process.exit(1);
    },
  );
}
