import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { changeOwnPassword } from '@chatbot/core';
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
      if (f.get('next') !== f.get('confirm')) throw new Error('Kata laluan baru tidak sama.');
      await changeOwnPassword(db(), user, String(f.get('current') ?? ''), String(f.get('next') ?? ''), token);
    } catch (err) {
      msg = actionError(err);
    }
    redirect(msg ? `${path}?error=${encodeURIComponent(msg)}` : `${path}?saved=1`);
  }

  return (
    <>
      <h1>Akaun</h1>
      {sp.error && <div className="error">{sp.error}</div>}
      {sp.saved && <div className="notice">Kata laluan ditukar. Sesi lain telah dilog keluar.</div>}
      <div className="panel">
        <form action={change} className="form">
          <div>{ctx.user.name} · {ctx.user.email}</div>
          <label>Kata laluan semasa<input type="password" name="current" required autoComplete="current-password" /></label>
          <label>Kata laluan baru (sekurang-kurangnya 10 aksara)<input type="password" name="next" required minLength={10} autoComplete="new-password" /></label>
          <label>Ulang kata laluan baru<input type="password" name="confirm" required minLength={10} autoComplete="new-password" /></label>
          <button className="primary" type="submit">Tukar kata laluan</button>
        </form>
      </div>
    </>
  );
}
