import { prepareWAMessageMedia, type WAMediaUploadFunction, type WAUrlInfo } from 'baileys';

/**
 * Link preview cards for YouTube links. Baileys' own preview reads the watch page, which from a
 * server often times out (3 s) or is redirected to a consent page, so the card had no thumbnail.
 * YouTube's oEmbed endpoint and its thumbnail host answer quickly and need no cookies.
 */
const YT = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/)|youtu\.be\/)([\w-]{11})/i;

export function youtubeId(url: string): string | null {
  return YT.exec(url)?.[1] ?? null;
}

type Thumb = (imageUrl: string) => Promise<Pick<WAUrlInfo, 'jpegThumbnail' | 'highQualityThumbnail'>>;

/** Uploads the thumbnail the way Baileys does for high-quality previews. */
export const uploadThumb = (upload: WAMediaUploadFunction): Thumb => async (imageUrl) => {
  const { imageMessage } = await prepareWAMessageMedia({ image: { url: imageUrl } }, {
    upload,
    mediaTypeOverride: 'thumbnail-link',
    options: { timeout: 8000 },
  } as Parameters<typeof prepareWAMessageMedia>[1]);
  return {
    jpegThumbnail: imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined,
    highQualityThumbnail: imageMessage ?? undefined,
  };
};

const cache = new Map<string, WAUrlInfo>();

/** Preview card for a YouTube link, or undefined if it is not one or the thumbnail cannot be fetched. */
export async function youtubePreview(url: string, thumb: Thumb, fetchImpl: typeof fetch = fetch): Promise<WAUrlInfo | undefined> {
  const id = youtubeId(url);
  if (!id) return undefined;
  const hit = cache.get(id);
  if (hit) return { ...hit, 'matched-text': url };
  const canonical = `https://www.youtube.com/watch?v=${id}`;
  let title = 'YouTube';
  let description: string | undefined;
  try {
    const res = await fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonical)}`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const j = (await res.json()) as { title?: string; author_name?: string };
      if (j.title) title = j.title;
      if (j.author_name) description = j.author_name;
    }
  } catch {
    // The card still shows the thumbnail with a plain title.
  }
  const imageUrl = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const info: WAUrlInfo = { 'canonical-url': canonical, 'matched-text': url, title, description, originalThumbnailUrl: imageUrl, ...(await thumb(imageUrl)) };
  if (info.jpegThumbnail) {
    cache.set(id, info);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return info;
}
