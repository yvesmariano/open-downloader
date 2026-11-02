import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, resourceKey, totalSize, sanitizeFilename, formatBytes } from '../src/lib/media.js';

test('classify reconhece HLS, mídia direta e ignora segmentos', () => {
  assert.equal(classify('https://a.com/x/master.m3u8'), 'hls');
  assert.equal(classify('https://a.com/play', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(classify('https://a.com/v.mp4', 'video/mp4'), 'direct');
  assert.equal(classify('https://a.com/v.webm', 'application/octet-stream'), 'direct');
  assert.equal(classify('https://a.com/song', 'audio/mpeg'), 'direct');
  assert.equal(classify('https://a.com/seg1.ts', 'video/mp2t'), null);
  assert.equal(classify('https://a.com/chunk.m4s', 'video/mp4'), null);
  assert.equal(classify('https://a.com/manifest.mpd', 'application/dash+xml'), null);
  assert.equal(classify('https://a.com/page', 'text/html'), null);
  assert.equal(classify('https://rr1.googlevideo.com/videoplayback', 'video/mp4'), null);
  assert.equal(classify('blob:https://a.com/123', 'video/mp4'), null);
});

test('mídia direta só conta quando carregada pelo elemento de mídia ou aberta como página', () => {
  assert.equal(classify('https://a.com/v.mp4', 'video/mp4', 'media'), 'direct');
  assert.equal(classify('https://a.com/v.mp4', 'video/mp4', 'main_frame'), 'direct');
  // Fragmentos buscados por players MSE (hls.js, dash.js…) via fetch/XHR.
  assert.equal(classify('https://a.com/seg-12.mp4', 'video/mp4', 'xmlhttprequest'), null);
  assert.equal(classify('https://a.com/frag?n=3', 'video/mp4', 'other'), null);
  // Playlists HLS continuam detectadas via XHR.
  assert.equal(classify('https://a.com/index.m3u8', '', 'xmlhttprequest'), 'hls');
});

test('resourceKey ignora query string', () => {
  assert.equal(resourceKey('https://a.com/seg1.mp4?token=abc'), 'https://a.com/seg1.mp4');
});

test('totalSize prefere o total do Content-Range', () => {
  assert.equal(totalSize(new Headers({ 'content-range': 'bytes 0-99/5000', 'content-length': '100' })), 5000);
  assert.equal(totalSize(new Headers({ 'content-length': '1234' })), 1234);
  assert.equal(totalSize(new Headers()), null);
});

test('sanitizeFilename remove caracteres inválidos', () => {
  assert.equal(sanitizeFilename('Meu: vídeo / "teste"?'), 'Meu vídeo teste');
  assert.equal(sanitizeFilename('...'), 'video');
  assert.equal(sanitizeFilename(undefined), 'video');
  assert.equal(sanitizeFilename('a'.repeat(300)).length, 120);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});
