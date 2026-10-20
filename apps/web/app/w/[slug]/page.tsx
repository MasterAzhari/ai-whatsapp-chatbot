import { getDashboard, getUsageSummary } from '@chatbot/core';
import { db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const ORIGIN_LABEL = { keyword: 'Keyword', flow: 'Flow', ai: 'AI', followup: 'Follow-up', human: 'Human' } as const;

export default async function Dashboard({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const d = await getDashboard(db(), ctx);
  const usage = await getUsageSummary(db(), ctx, 30);
  const usesMock = d.channels.some((c) => c.provider === 'mock');
  return (
    <>
      <h1>Dashboard</h1>
      {usesMock && <div className="notice">This workspace uses a MOCK channel and synthetic data. No messages are sent to real WhatsApp.</div>}
      <div className="cards">
        <Card label="New today" value={d.conversations.newToday} />
        <Card label="Active" value={d.conversations.open} />
        <Card label="Waiting for human" value={d.conversations.pendingHuman} />
        <Card label="Resolved" value={d.conversations.resolved} />
      </div>
      <h2 className="small muted">Replies in the last 7 days by source</h2>
      <div className="cards">
        {(Object.keys(ORIGIN_LABEL) as Array<keyof typeof ORIGIN_LABEL>).map((k) => (
          <Card key={k} label={ORIGIN_LABEL[k]} value={d.repliesByOrigin[k]} />
        ))}
      </div>
      <h2 className="small muted">Delivery status (reported by provider)</h2>
      <div className="panel" style={{ marginBottom: 24 }}>
        <table>
          <thead>
            <tr><th>Status</th><th>Count</th></tr>
          </thead>
          <tbody>
            {Object.entries(d.messageStatus).length === 0 && (
              <tr><td colSpan={2} className="muted">No outgoing messages yet.</td></tr>
            )}
            {Object.entries(d.messageStatus).map(([s, n]) => (
              <tr key={s}><td>{s}</td><td>{n}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="small muted">AI usage in the last 30 days</h2>
      <div className="panel" style={{ marginBottom: 8 }}>
        <table>
          <thead>
            <tr><th>Model</th><th>Source</th><th>Calls</th><th>Failed</th><th>Input tokens</th><th>Output tokens</th><th>Estimated cost</th></tr>
          </thead>
          <tbody>
            {usage.length === 0 && <tr><td colSpan={7} className="muted">No AI calls yet.</td></tr>}
            {usage.map((u) => (
              <tr key={`${u.provider}/${u.model}/${u.source}`}>
                <td>{u.model}</td>
                <td>{u.source === 'live' ? 'Customers' : 'Playground'}</td>
                <td>{u.calls}</td>
                <td>{u.failed}</td>
                <td>{u.inputTokens.toLocaleString('en-MY')}</td>
                <td>{u.outputTokens.toLocaleString('en-MY')}</td>
                <td>{u.estimatedCost ? `${u.estimatedCost.currency} ${u.estimatedCost.amount.toFixed(4)}` : <span className="muted">no rate</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Tokens are the figures reported by the AI provider{usage.some((u) => u.unreportedCalls > 0) ? '; some calls had no token data and are not counted' : ''}. Cost is an estimate
        from a rate table, not an invoice. The actual bill is in Google AI Studio.
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
