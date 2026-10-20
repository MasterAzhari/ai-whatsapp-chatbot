import { timingSafeEqual } from 'node:crypto';
import { receiveGatewayEvents } from '@chatbot/core';
import { db } from '@/lib/server';

export const dynamic = 'force-dynamic';

function authorised(req: Request): boolean {
  const token = process.env.GATEWAY_TOKEN ?? '';
  if (token.length < 24) return false;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Inbound events from the internal WhatsApp gateway. Stores them and returns at once; the worker replies. */
export async function POST(req: Request) {
  if (!authorised(req)) return Response.json({ error: 'unauthorised' }, { status: 401 });
  const body = await req.json().catch(() => null);
  const r = await receiveGatewayEvents(db(), body);
  if ('error' in r) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ results: r.results.map((x) => x.kind) });
}
