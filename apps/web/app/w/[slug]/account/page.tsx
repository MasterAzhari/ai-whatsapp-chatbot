import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { changeOwnName, changeOwnPassword } from '@chatbot/core';
import { actionError, db, requireTenant, requireUser, SESSION_COOKIE } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function Account({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  const path = `/w/${slug}/account`;

  async function change(f: FormData) {
    'use server';
    const user = await requireUser();
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    let msg: string | null = null;
    try {
      if (f.get('next') !== f.get('confirm')) throw new Error('New passwords do not match.');
      await changeOwnPassword(db(), user, String(f.get('current') ?? ''), String(f.get('next') ?? ''), token);
    } catch (err) {
      msg = actionError(err);
    }
    redirect(msg ? `${path}?error=${encodeURIComponent(msg)}` : `${path}?saved=1`);
  }

  async function rename(f: FormData) {
    'use server';
    const user = await requireUser();
    let msg: string | null = null;
    try {
      await changeOwnName(db(), user, String(f.get('name') ?? ''));
    } catch (err) {
      msg = actionError(err);
    }
    redirect(msg ? `${path}?error=${encodeURIComponent(msg)}` : `${path}?saved=name`);
  }

  return (
    <>
      <h1>Account</h1>
      {sp.error && <div className="error">{sp.error}</div>}
      {sp.saved === 'name' && <div className="notice">Name saved.</div>}
      {sp.saved === '1' && <div className="notice">Password changed. Other sessions have been logged out.</div>}
      <div className="panel" style={{ marginBottom: 16 }}>
        <form action={rename} className="form">
          <label>Your name<input name="name" defaultValue={ctx.user.name} required maxLength={200} /></label>
          <button type="submit">Save name</button>
        </form>
      </div>
      <div className="panel">
        <form action={change} className="form">
          <div>{ctx.user.name} · {ctx.user.email}</div>
          <label>Current password<input type="password" name="current" required autoComplete="current-password" /></label>
          <label>New password (at least 10 characters)<input type="password" name="next" required minLength={10} autoComplete="new-password" /></label>
          <label>Repeat new password<input type="password" name="confirm" required minLength={10} autoComplete="new-password" /></label>
          <button className="primary" type="submit">Change password</button>
        </form>
      </div>
    </>
  );
}
