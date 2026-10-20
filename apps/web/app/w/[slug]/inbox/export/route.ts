import { exportConversationsForReview } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** Downloads recent conversations with names and numbers hidden, for reviewing the bot. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (ctx.role === 'operator') return Response.json({ error: 'forbidden' }, { status: 403 });
  const days = Math.min(30, Math.max(1, Number(new URL(req.url).searchParams.get('days')) || 7));
  const r = await exportConversationsForReview(db(), ctx, days);
  return new Response(JSON.stringify(r, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="semakan-chat-${slug}-${r.exportedAt.slice(0, 10)}.json"`,
      'cache-control': 'no-store',
    },
  });
}
