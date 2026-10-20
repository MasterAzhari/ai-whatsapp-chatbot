import { listConversations } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const FILTERS = [
  ['', 'Semua'],
  ['open', 'Aktif'],
  ['pending_human', 'Menunggu manusia'],
  ['resolved', 'Selesai'],
] as const;

export default async function Inbox({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  const status = FILTERS.some(([k]) => k && k === sp.status) ? (sp.status as 'open' | 'pending_human' | 'resolved') : undefined;
  const rows = await listConversations(db(), ctx, { status, q: sp.q?.slice(0, 100) });
  const qs = (s: string) => `?${new URLSearchParams({ ...(s ? { status: s } : {}), ...(sp.q ? { q: sp.q } : {}) })}`;
  return (
    <>
      <h1>Inbox</h1>
      <div className="toolbar">
        <div className="filters toolbar" style={{ margin: 0 }}>
          {FILTERS.map(([k, label]) => (
            <a key={k} href={qs(k)} className={(status ?? '') === k ? 'active' : ''}>{label}</a>
          ))}
        </div>
        <form style={{ marginLeft: 'auto', minWidth: 220 }}>
          {status && <input type="hidden" name="status" value={status} />}
          <input type="text" name="q" placeholder="Cari nama atau nombor" defaultValue={sp.q ?? ''} />
        </form>
      </div>
      <div className="panel list">
        {rows.length === 0 && <div style={{ padding: 16 }} className="muted">Tiada perbualan.</div>}
        {rows.map((c) => (
          <a key={c.id} className="row" href={`/w/${slug}/inbox/${c.id}`}>
            <strong>{c.contactName ?? c.contactPhone ?? 'Tanpa nama'}</strong>
            <span className="small muted">{c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' }) : ''}</span>
            <span className="small muted">{c.lastMessagePreview}</span>
            <span>
              {c.botState === 'on' ? <span className="badge ok">Bot</span> : c.botState === 'off' ? <span className="badge warn">Manusia</span> : <span className="badge">Bukan lead</span>}{' '}
              <span className="badge">{c.status}</span>
            </span>
          </a>
        ))}
      </div>
    </>
  );
}
