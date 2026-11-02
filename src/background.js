import { classify, totalSize } from './lib/media.js';

// Estado em memória é a fonte da verdade; storage.session apenas sobrevive
// ao desligamento do service worker.
const media = new Map(); // tabId -> item[]
const jobs = {}; // jobId -> job
const downloadToJob = new Map(); // browser download id -> jobId

const ready = (async () => {
  const stored = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith('media:')) media.set(Number(key.slice(6)), value);
  }
  Object.assign(jobs, stored.jobs ?? {});
})();

const persistTab = (tabId) =>
  media.has(tabId)
    ? chrome.storage.session.set({ [`media:${tabId}`]: media.get(tabId) })
    : chrome.storage.session.remove(`media:${tabId}`);

const persistJobs = () => chrome.storage.session.set({ jobs });

function updateBadge(tabId) {
  const count = media.get(tabId)?.length ?? 0;
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
}

// ---------- Detecção ----------

chrome.webRequest.onResponseStarted.addListener(
  async (details) => {
    if (details.tabId < 0 || details.statusCode < 200 || details.statusCode > 299) return;
    const headers = new Headers();
    for (const { name, value } of details.responseHeaders ?? []) {
      if (value) headers.append(name, value);
    }
    const kind = classify(details.url, headers.get('content-type') ?? '');
    if (!kind) return;

    await ready;
    const items = media.get(details.tabId) ?? [];
    if (items.some((i) => i.url === details.url)) return;
    items.push({
      url: details.url,
      kind,
      contentType: headers.get('content-type'),
      size: kind === 'direct' ? totalSize(headers) : null,
      detectedAt: Date.now(),
    });
    media.set(details.tabId, items);
    await persistTab(details.tabId);
    updateBadge(details.tabId);
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other', 'main_frame', 'sub_frame'] },
  ['responseHeaders'],
);

async function clearTab(tabId) {
  await ready;
  media.delete(tabId);
  await persistTab(tabId);
  updateBadge(tabId);
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && change.url) clearTab(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));

// ---------- Downloads HLS (executados no documento offscreen) ----------

let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('src/offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: 'src/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Fetch HLS segments and assemble them into a single file.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

let nextRuleId = 1;

// Alguns CDNs exigem o Referer/Origin da página. A regra vale para requisições
// da própria extensão; com downloads simultâneos de sites diferentes, a última vence.
async function addRefererRule(pageUrl) {
  if (!pageUrl || !/^https?:/.test(pageUrl)) return null;
  const id = nextRuleId++;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id,
        priority: id,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: pageUrl },
            { header: 'origin', operation: 'set', value: new URL(pageUrl).origin },
          ],
        },
        condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
      },
    ],
  });
  return id;
}

async function removeRule(id) {
  if (id) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}

async function startHlsJob({ playlistUrl, filename, pageUrl }) {
  await ready;
  const id = crypto.randomUUID();
  jobs[id] = { id, filename, playlistUrl, status: 'running', done: 0, total: 0, error: null, ruleId: null };
  await persistJobs();
  jobs[id].ruleId = await addRefererRule(pageUrl);
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', job: { id, playlistUrl } });
}

async function finishJob(id, status, error = null) {
  const job = jobs[id];
  if (!job) return;
  job.status = status;
  job.error = error;
  await removeRule(job.ruleId);
  job.ruleId = null;
  await persistJobs();
}

async function saveJob(id, blobUrl, extension) {
  const job = jobs[id];
  if (!job || job.status !== 'running') return;
  job.status = 'saving';
  await persistJobs();
  try {
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename: `${job.filename}.${extension}` });
    downloadToJob.set(downloadId, id);
  } catch (e) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', id }).catch(() => {});
    await finishJob(id, 'error', String(e?.message ?? e));
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const id = downloadToJob.get(delta.id);
  const state = delta.state?.current;
  if (!id || (state !== 'complete' && state !== 'interrupted')) return;
  downloadToJob.delete(delta.id);
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', id }).catch(() => {});
  await ready;
  await finishJob(id, state === 'complete' ? 'done' : 'error', state === 'interrupted' ? 'interrupted' : null);
});

// ---------- Mensagens ----------

const handlers = {
  'download-direct': ({ url, filename }) => chrome.downloads.download({ url, filename }),
  'download-hls': (msg) => startHlsJob(msg),
  cancel: async ({ id }) => {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', id }).catch(() => {});
    await finishJob(id, 'cancelled');
  },
  'clear-job': async ({ id }) => {
    delete jobs[id];
    await persistJobs();
  },
  'job-progress': async ({ id, done, total }) => {
    await ready;
    if (jobs[id]?.status !== 'running') return;
    Object.assign(jobs[id], { done, total });
    await persistJobs();
  },
  'job-ready': ({ id, blobUrl, extension }) => ready.then(() => saveJob(id, blobUrl, extension)),
  'job-error': ({ id, error }) => ready.then(() => finishJob(id, 'error', error)),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg))
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true;
});
