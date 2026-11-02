// Classificação de respostas HTTP observadas e utilitários de nome de arquivo.

const DIRECT_EXTENSIONS = new Set([
  'mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv',
  'mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'flac',
]);

// Segmentos de streaming: nunca são mídias completas por si só.
const SEGMENT_EXTENSIONS = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'aac', 'vtt', 'webvtt']);

// Hosts cujo conteúdo é fragmentado (MSE) e só geraria ruído na lista.
const IGNORED_HOST_SUFFIXES = ['googlevideo.com', 'youtube.com'];

export function extensionOf(url) {
  try {
    const last = new URL(url).pathname.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}

function isIgnoredHost(url) {
  try {
    const host = new URL(url).hostname;
    return IGNORED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return true;
  }
}

/**
 * Decide se uma resposta é uma mídia que vale listar.
 * Retorna 'hls', 'direct' ou null.
 */
export function classify(url, contentType = '') {
  if (!/^https?:/i.test(url) || isIgnoredHost(url)) return null;
  const type = contentType.split(';')[0].trim().toLowerCase();
  const ext = extensionOf(url);

  if (/mpegurl/.test(type) || ext === 'm3u8') return 'hls';
  if (SEGMENT_EXTENSIONS.has(ext) || type === 'video/mp2t' || type === 'video/iso.segment') return null;
  if (ext === 'mpd' || /dash\+xml/.test(type)) return null;
  if (type.startsWith('video/') || type.startsWith('audio/')) return 'direct';
  if (DIRECT_EXTENSIONS.has(ext) && (type === '' || type === 'application/octet-stream')) return 'direct';
  return null;
}

/** Tamanho total a partir de Content-Range (respostas 206) ou Content-Length. */
export function totalSize(headers) {
  const range = headers.get('content-range');
  if (range) {
    const total = Number(range.split('/')[1]);
    if (Number.isFinite(total)) return total;
  }
  const length = Number(headers.get('content-length'));
  return Number.isFinite(length) && length > 0 ? length : null;
}

export function sanitizeFilename(name, fallback = 'video') {
  const clean = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  return clean || fallback;
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
