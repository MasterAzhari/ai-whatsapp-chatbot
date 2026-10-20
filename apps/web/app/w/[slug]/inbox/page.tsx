import { listConversations } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';
import { ChatList, FILTERS, type InboxStatus } from './chat-list';
import { AutoRefresh } from './refresh';

export const dynamic = 'force-dynamic';

export default async function Inbox({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  const status = FILTERS.some(([k]) => k && k === sp.status) ? (sp.status as InboxStatus) : undefined;
  const rows = await listConversations(db(), ctx, { status, q: sp.q?.slice(0, 100) });
  return (
    <div className="wa">
      <AutoRefresh />
      <ChatList slug={slug} rows={rows} status={status} q={sp.q} />
      <section className="wa-chat wa-empty">
        <div>
          <div style={{ fontSize: 48 }}>💬</div>
          <b>MasterBot Inbox</b>
          <p className="small muted">Pilih chat di sebelah kiri. Chat yang ditanda Perlu staf menunggu anda.</p>
        </div>
      </section>
    </div>
  );
}
