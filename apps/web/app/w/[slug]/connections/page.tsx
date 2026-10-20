import { getDashboard } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const PROVIDER = { official: 'Rasmi (Cloud API)', qr: 'QR (tidak rasmi)', mock: 'MOCK (ujian)' } as const;

export default async function Connections({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const { channels } = await getDashboard(db(), ctx);
  return (
    <>
      <h1>Sambungan WhatsApp</h1>
      <div className="notice">
        Pairing QR dan sambungan rasmi akan dibina dalam Fasa 2 dan 3. Mod QR bukan sambungan rasmi Meta dan tiada jaminan daripada sekatan.
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Nama</th><th>Jenis</th><th>Status</th><th>Automasi</th><th>AI</th></tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{PROVIDER[c.provider as keyof typeof PROVIDER] ?? c.provider}</td>
                <td><span className={`badge ${c.status === 'connected' ? 'ok' : 'warn'}`}>{c.status}</span></td>
                <td>{c.automationEnabled ? 'Hidup' : 'Mati'}</td>
                <td>{c.aiEnabled ? 'Hidup' : 'Mati'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
