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
            Nama workspace
            <input name="workspaceName" required maxLength={200} placeholder="Contoh: Agent Ali" value={name}
              onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(toSlug(e.target.value)); }} />
          </label>
          <label>
            Alamat workspace
            <input name="slug" required pattern="[a-z0-9][a-z0-9\-]{1,62}" value={slug}
              onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
          </label>
        </div>
        <div className="row">
          <label>Nama agent<input name="agentName" required maxLength={200} /></label>
          <label>Emel agent (untuk log masuk)<input name="agentEmail" type="email" required /></label>
        </div>
        <label>
          Salin tetapan bot dan keyword dari
          <select name="copyFrom" defaultValue={defaultSource}>
            <option value="">Jangan salin (mula kosong)</option>
            {sources.map((w) => <option key={w.slug} value={w.slug}>{w.name}</option>)}
          </select>
        </label>
        <button className="primary" type="submit" disabled={pending}>{pending ? 'Mencipta…' : 'Tambah agent'}</button>
      </form>
      {state.error && <div className="result"><div className="error">{state.error}</div></div>}
      {state.created && (
        <div className="result">
          <div className="notice">
            Workspace <b>{state.created.slug}</b> dicipta untuk {state.created.email}
            {state.created.rulesCopied != null ? `, dengan ${state.created.rulesCopied} keyword disalin` : ''}.
          </div>
          {state.created.tempPassword ? (
            <div>
              Kata laluan sementara (dipaparkan sekali sahaja, salin sekarang): <code className="secret">{state.created.tempPassword}</code>
              <div className="small muted">Beri kepada agent bersama alamat website dan emel. Minta mereka tukar di halaman Akaun selepas log masuk.</div>
            </div>
          ) : (
            <div className="small muted">Emel ini sudah ada akaun, jadi agent guna kata laluan sedia ada.</div>
          )}
        </div>
      )}
    </div>
  );
}

export function ResetPasswordButton({ userId, email }: { userId: string; email: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(resetPassword, {});
  if (state.tempPassword) return <span>Baru: <code className="secret">{state.tempPassword}</code></span>;
  return (
    <form action={action}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="email" value={email} />
      <button type="submit" disabled={pending}>Set semula kata laluan</button>
      {state.error && <span className="error">{state.error}</span>}
    </form>
  );
}
