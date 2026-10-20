import { notFound, redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { connectQrChannel, getDashboard, logoutQrChannel, qrChannelStatus } from '@chatbot/core';
import { actionError, db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const STATE = { disconnected: 'Tidak bersambung', pairing: 'Menunggu imbasan QR', connected: 'Bersambung', error: 'Ralat' } as const;

export default async function QrChannel({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { slug, id } = await params;
  const { error } = await searchParams;
  const ctx = await requireTenant(slug);
  if (ctx.role === 'operator') redirect(`/w/${slug}/connections`);
  const ch = (await getDashboard(db(), ctx)).channels.find((c) => c.id === id && c.provider === 'qr');
  if (!ch) notFound();
  const path = `/w/${slug}/connections/${id}`;

  const status = await qrChannelStatus(db(), ctx, id);
  // The pairing code is rendered on the server; it never goes into a URL or log.
  const qrImage = status.state === 'pairing' && status.qr ? await QRCode.toDataURL(status.qr, { margin: 1, width: 280 }) : null;

  async function connect() {
    'use server';
    const ctx = await requireTenant(slug);
    let msg: string | null = null;
    try {
      await connectQrChannel(db(), ctx, id);
    } catch (err) {
      msg = actionError(err);
    }
    redirect(msg ? `${path}?error=${encodeURIComponent(msg)}` : path);
  }
  async function logout() {
    'use server';
    const ctx = await requireTenant(slug);
    let msg: string | null = null;
    try {
      await logoutQrChannel(db(), ctx, id);
    } catch (err) {
      msg = actionError(err);
    }
    redirect(msg ? `${path}?error=${encodeURIComponent(msg)}` : path);
  }

  return (
    <>
      {status.state === 'pairing' && <meta httpEquiv="refresh" content="5" />}
      <div className="toolbar">
        <a href={`/w/${slug}/connections`}>← Sambungan</a>
        <h1 style={{ margin: 0 }}>{ch.name}</h1>
        <span className={`badge ${status.state === 'connected' ? 'ok' : 'warn'}`}>{STATE[status.state]}</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <div className="form">
          {status.state === 'connected' && (
            <>
              <div>Nombor: <b>{status.displayNumber ?? 'tidak dilaporkan'}</b></div>
              <div className="small muted">
                Mesej masuk akan muncul dalam Inbox. Bot hanya membalas bila suis Automasi channel ini dihidupkan di Tetapan bot.
              </div>
              <form action={logout}><button className="danger" type="submit">Putuskan dan nyahpaut</button></form>
            </>
          )}
          {status.state === 'pairing' && (
            qrImage ? (
              <>
                <div>Buka WhatsApp di telefon → <b>Peranti dipaut</b> → <b>Paut peranti</b>, kemudian imbas kod ini.</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrImage} alt="Kod QR WhatsApp" width={280} height={280} style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
                <div className="small muted">Kod bertukar setiap beberapa saat; halaman ini dimuat semula sendiri.</div>
              </>
            ) : (
              <div>Menyediakan kod QR… halaman ini dimuat semula sendiri.</div>
            )
          )}
          {(status.state === 'disconnected' || status.state === 'error') && (
            <>
              {status.reason && <div className="small muted">Sebab: {status.reason}</div>}
              <form action={connect}><button className="primary" type="submit">Sambung (papar kod QR)</button></form>
            </>
          )}
        </div>
      </div>
    </>
  );
}
