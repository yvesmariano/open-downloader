import { parsePlaylist, outputExtension } from './lib/hls.js';

const CONCURRENCY = 6;
const RETRIES = 3;

const controllers = new Map(); // jobId -> AbortController
const blobUrls = new Map(); // jobId -> object URL

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

async function fetchBytes(url, range, signal) {
  const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers, signal, credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (signal.aborted) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

function keyLoader(signal) {
  const cache = new Map();
  return (uri) => {
    if (!cache.has(uri)) {
      cache.set(
        uri,
        fetchBytes(uri, null, signal).then((raw) =>
          crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']),
        ),
      );
    }
    return cache.get(uri);
  };
}

async function runJob({ id, playlistUrl }) {
  const controller = new AbortController();
  controllers.set(id, controller);
  const { signal } = controller;

  try {
    const res = await fetch(playlistUrl, { signal, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for playlist`);
    let playlist = parsePlaylist(await res.text(), res.url);
    if (playlist.type === 'master') {
      // O popup normalmente já envia a variante escolhida; aqui cai na de maior qualidade.
      const best = playlist.variants[0];
      const r = await fetch(best.url, { signal, credentials: 'include' });
      playlist = parsePlaylist(await r.text(), r.url);
    }
    if (playlist.unsupported) throw new Error(`Unsupported stream (${playlist.unsupported})`);
    if (!playlist.segments.length) throw new Error('Empty playlist');

    const { segments } = playlist;
    const loadKey = keyLoader(signal);
    const parts = new Array(segments.length);
    let done = 0;
    let next = 0;

    const worker = async () => {
      while (next < segments.length) {
        const i = next++;
        const seg = segments[i];
        let data = await fetchBytes(seg.url, seg.range, signal);
        if (seg.key) {
          const key = await loadKey(seg.key.uri);
          data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: seg.key.iv }, key, data));
        }
        parts[i] = data;
        done++;
        send({ type: 'job-progress', id, done, total: segments.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segments.length) }, worker));

    // Segmentos fMP4: o init (EXT-X-MAP) entra antes do primeiro segmento que o usa.
    const chunks = [];
    let currentMap = null;
    for (let i = 0; i < segments.length; i++) {
      const map = segments[i].map;
      if (map && map.url + JSON.stringify(map.range) !== currentMap) {
        currentMap = map.url + JSON.stringify(map.range);
        chunks.push(await fetchBytes(map.url, map.range, signal));
      }
      chunks.push(parts[i]);
    }

    const extension = outputExtension(playlist);
    const type = extension === 'mp4' ? 'video/mp4' : extension === 'aac' ? 'audio/aac' : 'video/mp2t';
    const blobUrl = URL.createObjectURL(new Blob(chunks, { type }));
    blobUrls.set(id, blobUrl);
    send({ type: 'job-ready', id, blobUrl, extension });
  } catch (e) {
    if (!signal.aborted) send({ type: 'job-error', id, error: String(e?.message ?? e) });
  } finally {
    controllers.delete(id);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  sendResponse({ ok: true });
  if (msg.type === 'start') runJob(msg.job);
  else if (msg.type === 'cancel') controllers.get(msg.id)?.abort();
  else if (msg.type === 'revoke') {
    const url = blobUrls.get(msg.id);
    if (url) URL.revokeObjectURL(url);
    blobUrls.delete(msg.id);
  }
});
