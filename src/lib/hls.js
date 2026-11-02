// Parser mínimo de playlists HLS (RFC 8216): master e media playlists.

const SUPPORTED_KEY_METHODS = new Set(['NONE', 'AES-128']);

export function parseAttributes(input) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    attrs[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return attrs;
}

function parseByteRange(value, previousEnd) {
  const [length, offset] = value.split('@').map(Number);
  const start = Number.isFinite(offset) ? offset : previousEnd;
  return { start, end: start + length - 1 };
}

function parseIv(hex) {
  if (!hex) return null;
  const digits = hex.replace(/^0x/i, '').padStart(32, '0');
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) iv[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return iv;
}

/** IV padrão quando EXT-X-KEY não define IV: número de sequência em big-endian. */
export function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  let n = BigInt(sequence);
  for (let i = 15; i >= 0 && n > 0n; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

const resolve = (uri, base) => new URL(uri, base).href;

function parseMaster(lines, baseUrl) {
  const audioGroups = new Map();
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) {
        const group = audioGroups.get(a['GROUP-ID']) ?? [];
        group.push({ url: resolve(a.URI, baseUrl), name: a.NAME, language: a.LANGUAGE, isDefault: a.DEFAULT === 'YES' });
        audioGroups.set(a['GROUP-ID'], group);
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice(18));
      const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
      if (!uri) continue;
      variants.push({
        url: resolve(uri, baseUrl),
        bandwidth: Number(a.BANDWIDTH) || 0,
        resolution: a.RESOLUTION ?? null,
        codecs: a.CODECS ?? null,
        audioGroup: a.AUDIO ?? null,
      });
    }
  }
  for (const v of variants) {
    const group = v.audioGroup ? audioGroups.get(v.audioGroup) : null;
    // Rendição de áudio separada: o vídeo dessa variante vem sem som.
    v.audio = group ? (group.find((g) => g.isDefault) ?? group[0]) : null;
  }
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return { type: 'master', variants };
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let sequence = 0;
  let key = null;
  let map = null;
  let pendingRange = null;
  let lastRangeEnd = { url: null, end: -1 };
  let unsupported = null;
  let endList = false;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice(11));
      if (!SUPPORTED_KEY_METHODS.has(a.METHOD)) unsupported = `encryption ${a.METHOD}`;
      key = a.METHOD === 'AES-128' ? { uri: resolve(a.URI, baseUrl), iv: parseIv(a.IV) } : null;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      const url = resolve(a.URI, baseUrl);
      map = { url, range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(17);
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (line && !line.startsWith('#')) {
      const url = resolve(line, baseUrl);
      let range = null;
      if (pendingRange) {
        const previousEnd = lastRangeEnd.url === url ? lastRangeEnd.end + 1 : 0;
        range = parseByteRange(pendingRange, previousEnd);
        lastRangeEnd = { url, end: range.end };
        pendingRange = null;
      }
      segments.push({
        url,
        range,
        map,
        key: key ? { uri: key.uri, iv: key.iv ?? sequenceIv(sequence) } : null,
      });
      sequence++;
    }
  }
  return { type: 'media', segments, unsupported, live: !endList };
}

export function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('not an HLS playlist');
  return lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'))
    ? parseMaster(lines, baseUrl)
    : parseMedia(lines, baseUrl);
}

/** Extensão do arquivo final de acordo com o tipo de segmento. */
export function outputExtension(playlist) {
  const first = playlist.segments[0];
  if (!first) return 'ts';
  if (first.map) return 'mp4';
  const path = new URL(first.url).pathname.toLowerCase();
  if (path.endsWith('.aac')) return 'aac';
  if (/\.(m4s|mp4|m4a|cmfv|cmfa)$/.test(path)) return 'mp4';
  return 'ts';
}
