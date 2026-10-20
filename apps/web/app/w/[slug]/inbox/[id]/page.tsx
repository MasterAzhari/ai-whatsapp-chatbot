import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { addInternalNote, getConversation, resumeBot, sendManualReply, setStatus, takeOver } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const ROUTE = { none: 'tiada balasan', stop: 'berhenti', human: 'serah kepada manusia', keyword: 'keyword', media: 'voice/gambar, minta taip', ai: 'AI' } as const;
const ORIGIN = { customer: 'Pelanggan', keyword: 'Keyword', flow: 'Flow', ai: 'AI', human: 'Manusia', system: 'Sistem' } as const;

export default async function ConversationPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireTenant(slug);
  const data = await getConversation(db(), ctx, id);
  if (!data) notFound();
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

  return (
    <>
      <div className="toolbar">
        <a href={`/w/${slug}/inbox`}>← Inbox</a>
        <h1 style={{ margin: 0 }}>{c.contactName ?? c.contactPhone ?? 'Tanpa nama'}</h1>
        <span className="badge">{c.status}</span>
        {c.botState === 'on' && <span className="badge ok">Bot hidup untuk nombor ini</span>}
        {c.botState === 'off' && <span className="badge warn">Bot mati (anda layan)</span>}
        {c.botState === 'not_lead' && <span className="badge">Bot senyap: bukan lead</span>}
        <span style={{ marginLeft: 'auto' }} />
        <form action={toggleTakeover} className="inline">
          <button type="submit" className={c.botState === 'on' ? 'danger' : 'primary'}>{c.botState === 'on' ? 'Matikan bot untuk nombor ini' : 'Hidupkan bot untuk nombor ini'}</button>
        </form>
        {c.status !== 'resolved' && (
          <form action={resolve} className="inline"><button type="submit">Tanda selesai</button></form>
        )}
      </div>
      <div className="small muted" style={{ marginBottom: 8 }}>{c.channelName}{c.contactPhone ? ` · ${c.contactPhone}` : ''}</div>
      <div className="panel">
        <div className="thread">
          {messages.map((m) => (
            <div key={m.id} className={`bubble ${m.direction}`}>
              {m.imageAssetId && <img src={`/w/${slug}/media/${m.imageAssetId}`} alt="Gambar dihantar" style={{ display: 'block', maxWidth: 220, borderRadius: 8, marginBottom: 6 }} />}
              {m.attachments.length > 0 && <div className="small"><b>📎 {m.attachments.join(', ')}</b> <span className="muted">(buka di WhatsApp telefon)</span></div>}
              {m.body}
              <div className="meta">
                {ORIGIN[m.origin]} · {new Date(m.createdAt).toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' })}
                {m.direction === 'outbound' && <> · {m.status}{m.statusDetail ? ` (${m.statusDetail})` : ''}</>}
              </div>
              {m.direction === 'inbound' && (
                <div className="route">{m.route ? `Bot: ${ROUTE[m.route.route as keyof typeof ROUTE] ?? m.route.route}, ${m.route.reason}` : 'Bot: belum diproses'}</div>
              )}
            </div>
          ))}
        </div>
        <form action={reply} className="composer">
          <input type="hidden" name="rid" value={randomUUID()} />
          <textarea name="text" rows={2} placeholder="Balas sebagai manusia (bot akan dipause)" required maxLength={4096} />
          <button className="primary" type="submit">Hantar</button>
        </form>
        <form action={note} className="composer">
          <input type="text" name="text" placeholder="Nota dalaman (tidak dihantar kepada pelanggan)" required maxLength={4096} />
          <button type="submit">Simpan nota</button>
        </form>
      </div>
    </>
  );
}
