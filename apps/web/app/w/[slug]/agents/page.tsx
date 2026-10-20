import { redirect } from 'next/navigation';
import { listAgentWorkspaces, setAgentDisabled } from '@chatbot/core';
import { actionError, db, requireTenant, requireUser } from '@/lib/server';
import { AddAgentForm, ResetPasswordButton } from './forms';

export const dynamic = 'force-dynamic';

export default async function Agents({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!ctx.user.isPlatformOwner) redirect(`/w/${slug}`);
  const list = await listAgentWorkspaces(db(), ctx.user);
  const path = `/w/${slug}/agents`;

  async function toggle(f: FormData) {
    'use server';
    const owner = await requireUser();
    let msg: string | null = null;
    try {
      await setAgentDisabled(db(), owner, String(f.get('userId')), f.get('disable') === 'true');
    } catch (err) {
      msg = actionError(err);
    }
    redirect(msg ? `${path}?error=${encodeURIComponent(msg)}` : path);
  }

  return (
    <>
      <h1>Agent</h1>
      {sp.error && <div className="error">{sp.error}</div>}
      <p className="small muted">
        Setiap agent dapat workspace sendiri: pelanggan, perbualan, nombor WhatsApp dan kunci API mereka terasing daripada workspace lain. Agent tidak boleh lihat workspace anda.
      </p>

      <h2 className="small muted">Tambah agent</h2>
      <AddAgentForm sources={list.map((w) => ({ slug: w.slug, name: w.name }))} defaultSource={slug} />

      <h2 className="small muted" style={{ marginTop: 24 }}>Semua workspace</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Workspace</th><th>Admin</th><th>WhatsApp</th><th>Dicipta</th></tr></thead>
          <tbody>
            {list.map((w) => (
              <tr key={w.tenantId}>
                <td><a href={`/w/${w.slug}`}>{w.name}</a><div className="small muted">{w.slug}</div></td>
                <td>
                  {w.admins.length === 0 && <span className="muted">Tiada</span>}
                  {w.admins.map((a) => (
                    <div key={a.userId} style={{ marginBottom: 6 }}>
                      {a.name} · {a.email} {a.disabled && <span className="badge warn">Disekat</span>}
                      {!a.isOwner && <div className="toolbar" style={{ marginTop: 4, marginBottom: 0 }}>
                        <ResetPasswordButton userId={a.userId} email={a.email} />
                        <form action={toggle}>
                          <input type="hidden" name="userId" value={a.userId} />
                          <input type="hidden" name="disable" value={String(!a.disabled)} />
                          <button type="submit" className={a.disabled ? '' : 'danger'}>{a.disabled ? 'Buka sekatan' : 'Sekat log masuk'}</button>
                        </form>
                      </div>}
                    </div>
                  ))}
                </td>
                <td>{w.connectedChannels}/{w.channels} bersambung</td>
                <td className="small">{w.createdAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
