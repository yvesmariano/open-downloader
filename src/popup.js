import { extensionOf, formatBytes, sanitizeFilename } from './lib/media.js';
import { parsePlaylist } from './lib/hls.js';

const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

// O Chrome escolhe o _locales/ conforme o idioma do navegador (fallback: en).
document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const mediaKey = `media:${tab.id}`;
const baseName = sanitizeFilename(tab.title);
const playlists = new Map(); // url -> Promise<playlist>

const send = (msg) => chrome.runtime.sendMessage(msg);

const CONTENT_TYPE_EXTENSIONS = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
};

function directExtension(item) {
  const type = (item.contentType ?? '').split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[type] ?? (extensionOf(item.url) || 'mp4');
}

function shortName(url) {
  const u = new URL(url);
  return decodeURIComponent(u.pathname.split('/').pop() || u.hostname);
}

function variantLabel(v) {
  const height = v.resolution?.split('x')[1];
  const rate = v.bandwidth ? `${(v.bandwidth / 1e6).toFixed(1)} Mbps` : '';
  return [height && `${height}p`, rate].filter(Boolean).join(' · ') || shortName(v.url);
}

function loadPlaylist(url) {
  if (!playlists.has(url)) {
    playlists.set(
      url,
      fetch(url, { credentials: 'include' }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return parsePlaylist(await r.text(), r.url);
      }),
    );
  }
  return playlists.get(url);
}

async function setupHls(el, item) {
  const meta = el.querySelector('.meta');
  const select = el.querySelector('.variants');
  const button = el.querySelector('.download');
  button.disabled = true;
  try {
    const playlist = await loadPlaylist(item.url);
    let variants = null;
    if (playlist.type === 'master') {
      variants = playlist.variants;
      meta.hidden = true;
      select.hidden = false;
      variants.forEach((v, i) => select.add(new Option(variantLabel(v) + (v.audio ? ` · ${t('separateAudio')}` : ''), i)));
    } else if (playlist.unsupported) {
      meta.textContent = t('unsupported');
      return;
    } else {
      meta.textContent = [t('segments', [String(playlist.segments.length)]), playlist.live && t('live')]
        .filter(Boolean)
        .join(' · ');
    }
    button.disabled = false;
    button.onclick = async () => {
      button.disabled = true;
      const variant = variants?.[Number(select.value)];
      await send({ type: 'download-hls', playlistUrl: variant?.url ?? item.url, filename: baseName, pageUrl: tab.url });
      if (variant?.audio) {
        await send({ type: 'download-hls', playlistUrl: variant.audio.url, filename: `${baseName} (audio)`, pageUrl: tab.url });
      }
    };
  } catch (e) {
    meta.textContent = String(e.message ?? e);
  }
}

function renderMedia(items = []) {
  const list = document.getElementById('media-list');
  list.replaceChildren();
  document.getElementById('empty').hidden = items.length > 0;
  const template = document.getElementById('media-template');

  // Mais recentes primeiro.
  for (const item of [...items].reverse()) {
    const el = template.content.firstElementChild.cloneNode(true);
    el.querySelector('[data-i18n]').textContent = t('download');
    el.querySelector('.name').textContent = shortName(item.url);
    el.querySelector('.name').title = item.url;

    if (item.kind === 'hls') {
      el.querySelector('.tag').textContent = 'HLS';
      setupHls(el, item);
    } else {
      const ext = directExtension(item);
      el.querySelector('.tag').textContent = ext.toUpperCase();
      el.querySelector('.meta').textContent = formatBytes(item.size);
      el.querySelector('.download').onclick = () =>
        send({ type: 'download-direct', url: item.url, filename: `${baseName}.${ext}` });
    }
    list.append(el);
  }
}

function renderJobs(jobs = {}) {
  const all = Object.values(jobs);
  document.getElementById('jobs').hidden = all.length === 0;
  const list = document.getElementById('job-list');
  list.replaceChildren();
  const template = document.getElementById('job-template');

  for (const job of all) {
    const el = template.content.firstElementChild.cloneNode(true);
    const active = job.status === 'running' || job.status === 'saving';
    el.querySelector('.name').textContent = job.filename;
    const progress = el.querySelector('progress');
    progress.value = job.total ? job.done / job.total : job.status === 'done' ? 1 : 0;
    const status = el.querySelector('.status');
    status.textContent =
      job.status === 'running' && job.total
        ? `${job.done}/${job.total}`
        : t(`status_${job.status}`) + (job.error ? `: ${job.error}` : '');
    status.classList.toggle('error', job.status === 'error');
    const action = el.querySelector('.action');
    action.textContent = active ? t('cancel') : t('clear');
    action.onclick = () => send({ type: active ? 'cancel' : 'clear-job', id: job.id });
    list.append(el);
  }
}

const stored = await chrome.storage.session.get([mediaKey, 'jobs']);
renderMedia(stored[mediaKey]);
renderJobs(stored.jobs);

chrome.storage.session.onChanged.addListener((changes) => {
  if (mediaKey in changes) renderMedia(changes[mediaKey].newValue);
  if ('jobs' in changes) renderJobs(changes.jobs.newValue);
});
