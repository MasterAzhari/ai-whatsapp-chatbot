import { redirect } from 'next/navigation';
import { addQrChannel, getDashboard } from '@chatbot/core';
import { actionError, db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const PROVIDER = { official: 'Rasmi (Cloud API)', qr: 'QR (tidak rasmi)', mock: 'MOCK (ujian)' } as const;

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
      <h1>Sambungan WhatsApp</h1>
      <div className="notice">
        Mod QR (seperti WhatsApp Web) bukan sambungan rasmi Meta. Ada risiko nombor disekat, jadi guna nombor ujian atau nombor yang hang sanggup tanggung risikonya.
        Sambungan rasmi (Cloud API) akan datang dalam Fasa 3.
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Nama</th><th>Jenis</th><th>Status</th><th>Automasi</th><th>AI</th></tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>{c.provider === 'qr' && isAdmin ? <a href={`/w/${slug}/connections/${c.id}`}>{c.name}</a> : c.name}</td>
                <td>{PROVIDER[c.provider as keyof typeof PROVIDER] ?? c.provider}</td>
                <td><span className={`badge ${c.status === 'connected' ? 'ok' : 'warn'}`}>{c.status}</span></td>
                <td>{c.automationEnabled ? 'Hidup' : 'Mati'}</td>
                <td>{c.aiEnabled ? 'Hidup' : 'Mati'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isAdmin && (
        <div className="panel" style={{ marginTop: 24 }}>
          <form action={addQr} className="form">
            <label>Nama channel QR baru<input name="name" required maxLength={80} placeholder="Contoh: WhatsApp ujian" /></label>
            <button className="primary" type="submit">Tambah channel QR</button>
          </form>
        </div>
      )}
    </>
  );
}
