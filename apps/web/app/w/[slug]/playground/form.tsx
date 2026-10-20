'use client';

import { useActionState } from 'react';
import { runPlayground, sendAsMockCustomer, type PlaygroundState } from './actions';

const ROUTE = { none: 'No automatic reply', stop: 'Stop (opt-out)', human: 'Hand over to human', keyword: 'Keyword', media: 'Voice/picture: ask to type', ai: 'AI' } as const;

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
        <label>Customer message<textarea name="text" rows={3} required maxLength={4096} defaultValue={state.text} /></label>
        <label className="check"><input type="checkbox" name="callAi" /> Call the real AI if no keyword matches (uses tokens)</label>
        <label className="check"><input type="checkbox" name="isLead" defaultChecked /> Treat this chat as a lead (for &quot;Leads only&quot; mode)</label>
        <button className="primary" type="submit" disabled={pending}>{pending ? 'Testing…' : 'Test'}</button>
      </form>
      {(state.route || state.error) && (
        <div className="result">
          {state.error && <div className="error">{state.error}</div>}
          {state.route && (
            <>
              <div><b>{ROUTE[state.route.route as keyof typeof ROUTE] ?? state.route.route}</b> · <span className="muted">{state.route.reason}</span></div>
              {state.route.bubbles.map((b, i) => (
                <div key={i} className="bubble outbound" style={{ marginTop: 8 }}>
                  {i === 0 && state.route!.imageAssetId && (
                    <img src={`/w/${slug}/media/${state.route!.imageAssetId}`} alt="Picture" style={{ display: 'block', maxWidth: 240, borderRadius: 8, marginBottom: 6 }} />
                  )}
                  {b}
                </div>
              ))}
              {state.route.bubbles.length === 0 && state.route.imageAssetId && (
                <div className="bubble outbound" style={{ marginTop: 8 }}>
                  <img src={`/w/${slug}/media/${state.route.imageAssetId}`} alt="Picture" style={{ display: 'block', maxWidth: 240, borderRadius: 8 }} />
                </div>
              )}
            </>
          )}
          {state.ai &&
            (state.ai.ok ? (
              <>
                {state.ai.bubbles?.map((b, i) => <div key={i} className="bubble outbound" style={{ marginTop: 8 }}>{b}</div>)}
                {state.ai.handover && <div className="small" style={{ marginTop: 8 }}><b>Hand over to staff</b> · {state.ai.handover} (staff get notified)</div>}
                <div className="small muted">{state.ai.tokens}</div>
              </>
            ) : (
              <div className="error">AI failed ({state.ai.reason}): {state.ai.detail}</div>
            ))}
        </div>
      )}
      {mock.length > 0 && (
        <form action={sendAsMockCustomer} className="form" style={{ borderTop: '1px solid var(--border)' }}>
          <input type="hidden" name="slug" value={slug} />
          <div className="small muted">
            Or send as a test customer to a MOCK channel. The message goes through the real path (store, routing, outbox) and shows in the Inbox. Nothing is sent to WhatsApp.
          </div>
          <label>
            Channel MOCK
            <select name="channelId">{mock.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <label>Message<textarea name="text" rows={2} required maxLength={4096} /></label>
          <button type="submit">Send as test customer</button>
        </form>
      )}
    </div>
  );
}
