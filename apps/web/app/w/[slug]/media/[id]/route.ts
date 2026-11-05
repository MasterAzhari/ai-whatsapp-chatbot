import { getImageAsset } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** A keyword picture or a file sent from the Inbox, for the admin pages. Only members of the workspace can load it. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireTenant(slug);
  const img = await getImageAsset(db(), ctx, id);
  if (!img) return new Response('not found', { status: 404 });
  // Pictures and videos show in the page; documents always download, never open as a web page.
  const inline = /^(image|video)\//.test(img.mimeType);
  const name = (img.fileName ?? 'file').replace(/[^\w.\- ]/g, '_');
  return new Response(new Uint8Array(img.data), {
    headers: {
      'content-type': img.mimeType,
      'cache-control': 'private, max-age=86400',
      'content-disposition': inline ? 'inline' : `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(img.fileName ?? 'file').replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
    },
  });
}
