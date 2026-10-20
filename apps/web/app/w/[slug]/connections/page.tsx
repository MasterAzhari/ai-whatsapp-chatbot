import { redirect } from 'next/navigation';
import { addQrChannel, getDashboard } from '@chatbot/core';
import { actionError, db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const PROVIDER = { official: 'Official (Cloud API)', qr: 'QR (unofficial)', mock: 'MOCK (test)' } as const;

export default async function Connections({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const { channels } = await getDashboard(db(), ctx);
  const isAdmin = ctx.role !== 'operator';

  async function addQr(f: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    let to = `/w/${slug}/connections`;
    try {
      to = `/w/${slug}/connections/${await addQrChannel(db(), ctx, String(f.get('name') ?? ''))}`;
    } catch (err) {
      to += `?error=${encodeURIComponent(actionError(err))}`;
    }
    redirect(to);
  }

  return (
    <>
      <h1>WhatsApp connections</h1>
      <div className="notice">
        QR mode (like WhatsApp Web) is not an official Meta connection. The number may get banned, so use a test number or one you are willing to risk.
        Official connection (Cloud API) is coming in Phase 3.
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Name</th><th>Type</th><th>Status</th><th>Automation</th><th>AI</th></tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>{c.provider === 'qr' && isAdmin ? <a href={`/w/${slug}/connections/${c.id}`}>{c.name}</a> : c.name}</td>
                <td>{PROVIDER[c.provider as keyof typeof PROVIDER] ?? c.provider}</td>
                <td><span className={`badge ${c.status === 'connected' ? 'ok' : 'warn'}`}>{c.status}</span></td>
                <td>{c.automationEnabled ? 'On' : 'Off'}</td>
                <td>{c.aiEnabled ? 'On' : 'Off'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isAdmin && (
        <div className="panel" style={{ marginTop: 24 }}>
          <form action={addQr} className="form">
            <label>New QR channel name<input name="name" required maxLength={80} placeholder="Example: Test WhatsApp" /></label>
            <button className="primary" type="submit">Add QR channel</button>
          </form>
        </div>
      )}
    </>
  );
}
