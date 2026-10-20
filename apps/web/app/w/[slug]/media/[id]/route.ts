import { getImageAsset } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** A keyword picture, for previews in the admin pages. Only members of the workspace can load it. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireTenant(slug);
  const img = await getImageAsset(db(), ctx, id);
  if (!img) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(img.data), {
    headers: { 'content-type': img.mimeType, 'cache-control': 'private, max-age=86400', 'content-disposition': 'inline' },
  });
}
