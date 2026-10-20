'use client';

import { useActionState } from 'react';
import { runPlayground, sendAsMockCustomer, type PlaygroundState } from './actions';

const ROUTE = { none: 'Tiada balasan automatik', stop: 'Berhenti (opt-out)', human: 'Serah kepada manusia', keyword: 'Keyword', ai: 'AI' } as const;

export function PlaygroundForm({ slug, channels }: { slug: string; channels: Array<{ id: string; name: string; provider: string }> }) {
  const [state, action, pending] = useActionState<PlaygroundState, FormData>(runPlayground, {});
  const mock = channels.filter((c) => c.provider === 'mock');
  return (
    <div className="panel">
      <form action={action} className="form">
        <input type="hidden" name="slug" value={slug} />
        <label>
          Channel
          <select name="channelId">
            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Mesej pelanggan<textarea name="text" rows={3} required maxLength={4096} defaultValue={state.text} /></label>
        <label className="check"><input type="checkbox" name="callAi" /> Panggil AI sebenar jika tiada keyword padan (guna token)</label>
        <button className="primary" type="submit" disabled={pending}>{pending ? 'Menguji…' : 'Uji'}</button>
      </form>
      {(state.route || state.error) && (
        <div className="result">
          {state.error && <div className="error">{state.error}</div>}
          {state.route && (
            <>
              <div><b>{ROUTE[state.route.route as keyof typeof ROUTE] ?? state.route.route}</b> · <span className="muted">{state.route.reason}</span></div>
              {state.route.reply && <div className="bubble outbound" style={{ marginTop: 8 }}>{state.route.reply}</div>}
            </>
          )}
          {state.ai &&
            (state.ai.ok ? (
              <>
                <div className="bubble outbound" style={{ marginTop: 8 }}>{state.ai.text}</div>
                <div className="small muted">{state.ai.tokens}</div>
              </>
            ) : (
              <div className="error">AI gagal ({state.ai.reason}): {state.ai.detail}</div>
            ))}
        </div>
      )}
      {mock.length > 0 && (
        <form action={sendAsMockCustomer} className="form" style={{ borderTop: '1px solid var(--border)' }}>
          <input type="hidden" name="slug" value={slug} />
          <div className="small muted">
            Atau hantar sebagai pelanggan ujian ke channel MOCK. Mesej melalui laluan sebenar (simpan, routing, outbox) dan dipaparkan dalam Inbox. Tiada apa dihantar ke WhatsApp.
          </div>
          <label>
            Channel MOCK
            <select name="channelId">{mock.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <label>Mesej<textarea name="text" rows={2} required maxLength={4096} /></label>
          <button type="submit">Hantar sebagai pelanggan ujian</button>
        </form>
      )}
    </div>
  );
}
