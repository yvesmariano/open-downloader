import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, parseAttributes, sequenceIv, outputExtension, referencedUrls } from '../src/lib/hls.js';

const BASE = 'https://cdn.example.com/video/master.m3u8';

test('parseAttributes lida com valores entre aspas contendo vírgulas', () => {
  assert.deepEqual(parseAttributes('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720'), {
    BANDWIDTH: '1280000',
    CODECS: 'avc1.4d401f,mp4a.40.2',
    RESOLUTION: '1280x720',
  });
});

test('master playlist: variantes ordenadas e áudio separado resolvido', () => {
  const p = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"',
      'https://other.example.com/high.m3u8',
    ].join('\n'),
    BASE,
  );
  assert.equal(p.type, 'master');
  assert.equal(p.variants.length, 2);
  assert.equal(p.variants[0].resolution, '1920x1080');
  assert.equal(p.variants[0].url, 'https://other.example.com/high.m3u8');
  assert.equal(p.variants[0].audio.url, 'https://cdn.example.com/video/audio/en.m3u8');
  assert.equal(p.variants[1].url, 'https://cdn.example.com/video/low/index.m3u8');
  assert.equal(p.variants[1].audio, null);
  assert.deepEqual(referencedUrls(p), [
    'https://other.example.com/high.m3u8',
    'https://cdn.example.com/video/audio/en.m3u8',
    'https://cdn.example.com/video/low/index.m3u8',
  ]);
});

test('media playlist: segmentos, AES-128 com IV derivado da sequência e ENDLIST', () => {
  const p = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:7',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:4,',
      'seg7.ts',
      '#EXTINF:4,',
      'seg8.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="key2.bin",IV=0x000102030405060708090a0b0c0d0e0f',
      '#EXTINF:4,',
      'seg9.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'),
    BASE,
  );
  assert.equal(p.type, 'media');
  assert.equal(p.live, false);
  assert.equal(p.unsupported, null);
  assert.equal(p.segments.length, 3);
  assert.equal(p.segments[0].key.uri, 'https://cdn.example.com/video/key.bin');
  assert.deepEqual(p.segments[0].key.iv, sequenceIv(7));
  assert.equal(p.segments[1].key.iv[15], 8);
  assert.deepEqual([...p.segments[2].key.iv], [...Array(16).keys()]);
  assert.equal(outputExtension(p), 'ts');
});

test('SAMPLE-AES é marcado como não suportado', () => {
  const p = parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:4,\na.ts', BASE);
  assert.match(p.unsupported, /SAMPLE-AES/);
});

test('fMP4 com EXT-X-MAP e BYTERANGE implícito', () => {
  const p = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-BYTERANGE:1000@0',
      '#EXTINF:4,',
      'video.mp4',
      '#EXT-X-BYTERANGE:500',
      '#EXTINF:4,',
      'video.mp4',
    ].join('\n'),
    BASE,
  );
  assert.equal(p.live, true);
  assert.deepEqual(p.segments[0].range, { start: 0, end: 999 });
  assert.deepEqual(p.segments[1].range, { start: 1000, end: 1499 });
  assert.equal(p.segments[0].map.url, 'https://cdn.example.com/video/init.mp4');
  assert.equal(outputExtension(p), 'mp4');
  assert.deepEqual(new Set(referencedUrls(p)), new Set([
    'https://cdn.example.com/video/video.mp4',
    'https://cdn.example.com/video/init.mp4',
  ]));
});

test('rejeita conteúdo que não é HLS', () => {
  assert.throws(() => parsePlaylist('<html></html>', BASE));
});
