import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { addInternalNote, getConversation, listConversations, resumeBot, sendManualReply, setStatus, takeOver } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';
import { Avatar, BotPill, ChatList, displayName } from '../chat-list';
import { AutoRefresh } from '../refresh';

export const dynamic = 'force-dynamic';

const ROUTE = { none: 'no reply', stop: 'stopped', human: 'hand over to human', keyword: 'keyword', media: 'voice/picture, asked to type', ai: 'AI' } as const;
const ORIGIN = { customer: '', keyword: '🔑 Keyword', flow: 'Flow', ai: '🤖 AI', human: '🙋 Human', system: '⚙️ System', followup: '⏰ Follow-up' } as const;
const TICK: Record<string, { mark: string; title: string; cls?: string }> = {
  queued: { mark: '🕓', title: 'Queued' },
  accepted: { mark: '✓', title: 'Accepted' },
  sent: { mark: '✓', title: 'Sent' },
  delivered: { mark: '✓✓', title: 'Delivered' },
  read: { mark: '✓✓', title: 'Read', cls: 'read' },
  failed: { mark: '⚠️', title: 'Failed', cls: 'failed' },
  unknown: { mark: '?', title: 'Status unknown', cls: 'failed' },
};
const TZ = 'Asia/Kuala_Lumpur';
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-MY', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-MY', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export default async function ConversationPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireTenant(slug);
  const data = await getConversation(db(), ctx, id);
  if (!data) notFound();
  const rows = await listConversations(db(), ctx, {});
  const { conversation: c, messages } = data;
  const path = `/w/${slug}/inbox/${id}`;

  // Server actions re-check the session and tenant on every call.
  async function reply(formData: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    await sendManualReply(db(), ctx, id, { text: String(formData.get('text') ?? ''), clientRequestId: String(formData.get('rid') ?? '') || undefined });
    revalidatePath(path);
    redirect(path);
  }
  async function note(formData: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    await addInternalNote(db(), ctx, id, String(formData.get('text') ?? ''));
    revalidatePath(path);
    redirect(path);
  }
  async function toggleTakeover() {
    'use server';
    const ctx = await requireTenant(slug);
    const cur = await getConversation(db(), ctx, id);
    if (cur?.conversation.botState === 'on') await takeOver(db(), ctx, id);
    else await resumeBot(db(), ctx, id);
    revalidatePath(path);
  }
  async function resolve() {
    'use server';
    const ctx = await requireTenant(slug);
    await setStatus(db(), ctx, id, 'resolved');
    revalidatePath(path);
  }

  // The scroll box is column-reverse, so the view opens pinned to the latest message.
  const items: Array<{ key: string; el: React.ReactNode }> = [];
  let lastDay = '';
  for (const m of messages) {
    const d = day(m.createdAt);
    if (d !== lastDay) {
      items.push({ key: `d-${m.id}`, el: <div className="wa-day"><span>{d}</span></div> });
      lastDay = d;
    }
    if (m.direction === 'note') {
      items.push({ key: m.id, el: <div className="wa-note">📝 {m.body} <span className="wa-meta">{clock(m.createdAt)}</span></div> });
      continue;
    }
    const tick = m.direction === 'outbound' ? TICK[m.status] : undefined;
    items.push({
      key: m.id,
      el: (
        <div className={`wa-bubble ${m.direction}`}>
          {m.direction === 'outbound' && ORIGIN[m.origin] && <div className="wa-origin">{ORIGIN[m.origin]}</div>}
          {m.imageAssetId && <img src={`/w/${slug}/media/${m.imageAssetId}`} alt="Picture sent" className="wa-img" />}
          {m.attachments.length > 0 && <div className="wa-attach">📎 {m.attachments.join(', ')} <span className="muted">(open on phone)</span></div>}
          {m.body && <span className="wa-text">{m.body}</span>}
          <span className="wa-meta">
            {clock(m.createdAt)}
            {tick && <span className={`wa-tick ${tick.cls ?? ''}`} title={m.statusDetail ? `${tick.title}: ${m.statusDetail}` : tick.title}>{tick.mark}</span>}
          </span>
          {m.direction === 'inbound' && (
            <div className="wa-route">{m.route ? `Bot: ${ROUTE[m.route.route as keyof typeof ROUTE] ?? m.route.route}, ${m.route.reason}` : 'Bot: not processed yet'}</div>
          )}
          {m.direction === 'outbound' && m.status === 'failed' && m.statusDetail && <div className="wa-route failed">{m.statusDetail}</div>}
        </div>
      ),
    });
  }

  return (
    <div className="wa has-chat">
      <AutoRefresh />
      <ChatList slug={slug} rows={rows} activeId={id} />
      <section className="wa-chat">
        <header className="wa-head">
          <a href={`/w/${slug}/inbox`} className="wa-back" aria-label="Back to chat list">←</a>
          <Avatar name={displayName(c)} size={40} />
          <div className="wa-head-name">
            <b>{displayName(c)}</b>
            <span className="small">{[c.contactName ? c.contactPhone : null, c.channelName].filter(Boolean).join(' · ')}</span>
          </div>
          <div className="wa-actions">
            <BotPill state={c.botState} />
            <form action={toggleTakeover} className="inline">
              <button type="submit" className={c.botState === 'on' ? 'danger' : 'primary'} title="Bot for this number only">
                <span className="long">{c.botState === 'on' ? 'Turn bot off' : 'Turn bot on'}</span>
                <span className="short">{c.botState === 'on' ? '⏸ Bot' : '▶ Bot'}</span>
              </button>
            </form>
            {c.status !== 'resolved' ? (
              <form action={resolve} className="inline"><button type="submit" title="Mark resolved">✓<span className="long"> Resolve</span></button></form>
            ) : (
              <span className="pill">Resolved</span>
            )}
          </div>
        </header>
        <div className="wa-scroll">
          <div className="wa-msgs">{items.map((i) => <div key={i.key} className="wa-row">{i.el}</div>)}</div>
        </div>
        <form action={reply} className="wa-composer">
          <input type="hidden" name="rid" value={randomUUID()} />
          <textarea name="text" rows={1} placeholder={c.botState === 'on' ? 'Type a message (bot will stop for this number)' : 'Type a message'} required maxLength={4096} />
          <button type="submit" formAction={note} className="wa-note-btn" title="Save as internal note (not sent to the customer)">📝</button>
          <button type="submit" className="wa-send" aria-label="Send">➤</button>
        </form>
      </section>
    </div>
  );
}
