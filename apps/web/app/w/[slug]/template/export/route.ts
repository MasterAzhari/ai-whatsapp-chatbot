import { exportBotTemplate, listMemberships } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** Downloads this workspace's bot settings and keyword rules as a JSON template (no API keys). */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (ctx.role === 'operator') return Response.json({ error: 'forbidden' }, { status: 403 });
  const name = (await listMemberships(db(), ctx.user)).find((w) => w.slug === slug)?.name ?? slug;
  const t = await exportBotTemplate(db(), ctx, name);
  return new Response(JSON.stringify(t, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="bot-template-${slug}-${t.exportedAt.slice(0, 10)}.json"`,
      'cache-control': 'no-store',
    },
  });
}
