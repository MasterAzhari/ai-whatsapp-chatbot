import { test } from 'node:test';
import assert from 'node:assert/strict';
import { youtubeId, youtubePreview } from '../src/youtube-preview.js';

test('finds the video id in YouTube links only', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=ewMtc4b-FQE'), 'ewMtc4b-FQE');
  assert.equal(youtubeId('https://youtu.be/ewMtc4b-FQE?si=x'), 'ewMtc4b-FQE');
  assert.equal(youtubeId('https://m.youtube.com/watch?feature=share&v=ewMtc4b-FQE'), 'ewMtc4b-FQE');
  assert.equal(youtubeId('https://www.youtube.com/shorts/ewMtc4b-FQE'), 'ewMtc4b-FQE');
  assert.equal(youtubeId('https://example.com/watch?v=ewMtc4b-FQE'), null);
});

test('builds a card from oEmbed and the YouTube thumbnail, without reading the watch page', async () => {
  const asked: string[] = [];
  const f = (async (u: string) => {
    asked.push(u);
    return new Response(JSON.stringify({ title: 'Acson KOOL Series', author_name: 'Acson Malaysia' }), { status: 200 });
  }) as unknown as typeof fetch;
  const thumbs: string[] = [];
  const thumb = async (u: string) => { thumbs.push(u); return { jpegThumbnail: Buffer.from('jpg') }; };
  const info = await youtubePreview('https://www.youtube.com/watch?v=abcdefghijk', thumb, f);
  assert.equal(info?.title, 'Acson KOOL Series');
  assert.equal(info?.description, 'Acson Malaysia');
  assert.equal(info?.['matched-text'], 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.deepEqual(thumbs, ['https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg']);
  assert.match(asked[0]!, /^https:\/\/www\.youtube\.com\/oembed\?/);
  // Second send of the same video reuses the uploaded thumbnail.
  await youtubePreview('https://youtu.be/abcdefghijk', thumb, f);
  assert.equal(thumbs.length, 1);
});

test('still shows the thumbnail when oEmbed fails', async () => {
  const f = (async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
  const info = await youtubePreview('https://www.youtube.com/watch?v=zyxwvutsrqp', async () => ({ jpegThumbnail: Buffer.from('j') }), f);
  assert.equal(info?.title, 'YouTube');
  assert.ok(info?.jpegThumbnail);
});
