import { notFound, redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { connectQrChannel, getDashboard, logoutQrChannel, qrChannelStatus } from '@chatbot/core';
import { actionError, db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const STATE = { disconnected: 'Not connected', pairing: 'Waiting for QR scan', connected: 'Connected', error: 'Error' } as const;

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
        <a href={`/w/${slug}/connections`}>← Connections</a>
        <h1 style={{ margin: 0 }}>{ch.name}</h1>
        <span className={`badge ${status.state === 'connected' ? 'ok' : 'warn'}`}>{STATE[status.state]}</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <div className="form">
          {status.state === 'connected' && (
            <>
              <div>Number: <b>{status.displayNumber ?? 'not reported'}</b></div>
              <div className="small muted">
                Incoming messages will show in the Inbox. The bot only replies when this channel's Automation switch is on in Bot settings.
              </div>
              <form action={logout}><button className="danger" type="submit">Disconnect and unlink</button></form>
            </>
          )}
          {status.state === 'pairing' && (
            qrImage ? (
              <>
                <div>Open WhatsApp on the phone → <b>Linked devices</b> → <b>Link a device</b>, then scan this code.</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrImage} alt="WhatsApp QR code" width={280} height={280} style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
                <div className="small muted">The code changes every few seconds; this page reloads by itself.</div>
              </>
            ) : (
              <div>Preparing QR code… this page reloads by itself.</div>
            )
          )}
          {(status.state === 'disconnected' || status.state === 'error') && (
            <>
              {status.reason && <div className="small muted">Reason: {status.reason}</div>}
              <form action={connect}><button className="primary" type="submit">Connect (show QR code)</button></form>
            </>
          )}
        </div>
      </div>
    </>
  );
}
