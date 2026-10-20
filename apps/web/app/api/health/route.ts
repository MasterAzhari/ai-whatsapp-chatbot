import { db } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db().query('SELECT 1');
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, error: 'database unavailable' }, { status: 503 });
  }
}
