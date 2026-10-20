'use client';

import { useActionState, useEffect, useState } from 'react';
import { addAgent, resetPassword, type AgentFormState, type ResetState } from './actions';

/** Lowercase, dash-separated workspace address from a name ("Agent Ali" → "agent-ali"). */
function toSlug(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

export function AddAgentForm({ sources, defaultSource }: { sources: Array<{ slug: string; name: string }>; defaultSource: string }) {
  const [state, action, pending] = useActionState<AgentFormState, FormData>(addAgent, {});
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  useEffect(() => {
    if (!state.created) return;
    setName('');
    setSlug('');
    setSlugTouched(false);
  }, [state.created]);
  return (
    <div className="panel">
      <form action={action} className="form">
        <div className="row">
          <label>
            Workspace name
            <input name="workspaceName" required maxLength={200} placeholder="Example: Agent Ali" value={name}
              onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(toSlug(e.target.value)); }} />
          </label>
          <label>
            Workspace address
            <input name="slug" required pattern="[a-z0-9][a-z0-9\-]{1,62}" value={slug}
              onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
          </label>
        </div>
        <div className="row">
          <label>Agent name<input name="agentName" required maxLength={200} /></label>
          <label>Agent email (for login)<input name="agentEmail" type="email" required /></label>
        </div>
        <label>
          Copy bot settings and keywords from
          <select name="copyFrom" defaultValue={defaultSource}>
            <option value="">Don't copy (start empty)</option>
            {sources.map((w) => <option key={w.slug} value={w.slug}>{w.name}</option>)}
          </select>
        </label>
        <button className="primary" type="submit" disabled={pending}>{pending ? 'Creating…' : 'Add agent'}</button>
      </form>
      {state.error && <div className="result"><div className="error">{state.error}</div></div>}
      {state.created && (
        <div className="result">
          <div className="notice">
            Workspace <b>{state.created.slug}</b> created for {state.created.email}
            {state.created.rulesCopied != null ? `, with ${state.created.rulesCopied} keywords copied` : ''}.
          </div>
          {state.created.tempPassword ? (
            <div>
              Temporary password (shown once only, copy it now): <code className="secret">{state.created.tempPassword}</code>
              <div className="small muted">Give it to the agent with the website address and email. Ask them to change it on the Account page after logging in.</div>
            </div>
          ) : (
            <div className="small muted">This email already has an account, so the agent uses their existing password.</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ResetPasswordButton({ userId, email }: { userId: string; email: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(resetPassword, {});
  if (state.tempPassword) return <span>New: <code className="secret">{state.tempPassword}</code></span>;
  return (
    <form action={action}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="email" value={email} />
      <button type="submit" disabled={pending}>Reset password</button>
      {state.error && <span className="error">{state.error}</span>}
    </form>
  );
}
