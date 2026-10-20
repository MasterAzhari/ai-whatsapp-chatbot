import { getDashboard, getUsageSummary } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const ORIGIN_LABEL = { keyword: 'Keyword', flow: 'Flow', ai: 'AI', human: 'Manusia' } as const;

export default async function Dashboard({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const d = await getDashboard(db(), ctx);
  const usage = await getUsageSummary(db(), ctx, 30);
  const usesMock = d.channels.some((c) => c.provider === 'mock');
  return (
    <>
      <h1>Dashboard</h1>
      {usesMock && <div className="notice">Workspace ini guna channel MOCK dan data sintetik. Tiada mesej dihantar ke WhatsApp sebenar.</div>}
      <div className="cards">
        <Card label="Baru hari ini" value={d.conversations.newToday} />
        <Card label="Aktif" value={d.conversations.open} />
        <Card label="Menunggu manusia" value={d.conversations.pendingHuman} />
        <Card label="Selesai" value={d.conversations.resolved} />
      </div>
      <h2 className="small muted">Balasan 7 hari lepas mengikut sumber</h2>
      <div className="cards">
        {(Object.keys(ORIGIN_LABEL) as Array<keyof typeof ORIGIN_LABEL>).map((k) => (
          <Card key={k} label={ORIGIN_LABEL[k]} value={d.repliesByOrigin[k]} />
        ))}
      </div>
      <h2 className="small muted">Status penghantaran (dilaporkan provider)</h2>
      <div className="panel" style={{ marginBottom: 24 }}>
        <table>
          <thead>
            <tr><th>Status</th><th>Bilangan</th></tr>
          </thead>
          <tbody>
            {Object.entries(d.messageStatus).length === 0 && (
              <tr><td colSpan={2} className="muted">Tiada mesej keluar lagi.</td></tr>
            )}
            {Object.entries(d.messageStatus).map(([s, n]) => (
              <tr key={s}><td>{s}</td><td>{n}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="small muted">Penggunaan AI 30 hari lepas</h2>
      <div className="panel" style={{ marginBottom: 8 }}>
        <table>
          <thead>
            <tr><th>Model</th><th>Sumber</th><th>Panggilan</th><th>Gagal</th><th>Token masuk</th><th>Token keluar</th><th>Anggaran kos</th></tr>
          </thead>
          <tbody>
            {usage.length === 0 && <tr><td colSpan={7} className="muted">Belum ada panggilan AI.</td></tr>}
            {usage.map((u) => (
              <tr key={`${u.provider}/${u.model}/${u.source}`}>
                <td>{u.model}</td>
                <td>{u.source === 'live' ? 'Pelanggan' : 'Playground'}</td>
                <td>{u.calls}</td>
                <td>{u.failed}</td>
                <td>{u.inputTokens.toLocaleString('ms-MY')}</td>
                <td>{u.outputTokens.toLocaleString('ms-MY')}</td>
                <td>{u.estimatedCost ? `${u.estimatedCost.currency} ${u.estimatedCost.amount.toFixed(4)}` : <span className="muted">tiada kadar</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Token ialah angka yang dilaporkan Gemini{usage.some((u) => u.unreportedCalls > 0) ? '; sesetengah panggilan tiada data token dan tidak dikira' : ''}. Kos ialah anggaran
        daripada jadual kadar, bukan invois. Bil sebenar ada di Google AI Studio.
      </p>
    </>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
