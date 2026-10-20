import { redirect } from 'next/navigation';
import { countDemoData, listAgentWorkspaces, purgeDemoData, renameWorkspace, setAgentDisabled } from '@chatbot/core';
import { actionError, db, requireTenant, requireUser } from '@/lib/server';
import { AddAgentForm, ResetPasswordButton } from './forms';

export const dynamic = 'force-dynamic';

export default async function Agents({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; purged?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!ctx.user.isPlatformOwner) redirect(`/w/${slug}`);
  const list = await listAgentWorkspaces(db(), ctx.user);
  const demo = await countDemoData(db(), ctx.user);
  const currentName = list.find((w) => w.slug === slug)?.name ?? '';
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

  async function rename(f: FormData) {
    'use server';
    const owner = await requireUser();
    let msg: string | null = null;
    let next = slug;
    try {
      const r = await renameWorkspace(db(), owner, String(f.get('tenantId')), { workspaceName: String(f.get('name') ?? ''), slug: String(f.get('newSlug') ?? '') });
      if (f.get('oldSlug') === slug) next = r.slug; // renamed the workspace we are in: follow it
    } catch (err) {
      msg = actionError(err);
    }
    const to = `/w/${next}/agents`;
    redirect(msg ? `${to}?error=${encodeURIComponent(msg)}` : to);
  }

  async function purge() {
    'use server';
    const owner = await requireUser();
    let msg: string | null = null;
    let gone = false;
    try {
      const r = await purgeDemoData(db(), owner);
      gone = r.sampleWorkspaces.includes(currentName); // the workspace we are in was a sample
    } catch (err) {
      msg = actionError(err);
    }
    if (msg) redirect(`${path}?error=${encodeURIComponent(msg)}`);
    redirect(gone ? '/' : `${path}?purged=1`);
  }

  return (
    <>
      <h1>Agent</h1>
      {sp.error && <div className="error">{sp.error}</div>}
      {sp.purged && <div className="notice">Data contoh telah dibuang. Yang tinggal hanya data sebenar.</div>}
      <p className="small muted">
        Setiap agent dapat workspace sendiri: pelanggan, perbualan, nombor WhatsApp dan kunci API mereka terasing daripada workspace lain. Agent tidak boleh lihat workspace anda.
      </p>

      {(demo.mockChannels > 0 || demo.sampleWorkspaces.length > 0) && (
        <div className="panel" style={{ padding: 16, marginBottom: 24 }}>
          <b>Data contoh masih ada</b>
          <p className="small" style={{ margin: '6px 0' }}>
            {demo.mockChannels} sambungan WhatsApp olok-olok dengan {demo.conversations} chat contoh
            {demo.sampleWorkspaces.length > 0 && <>, dan workspace contoh: {demo.sampleWorkspaces.join(', ')}</>}.
            Nombor WhatsApp sebenar, chat pelanggan sebenar, keyword dan tetapan bot tidak disentuh.
          </p>
          <form action={purge} className="toolbar" style={{ marginBottom: 0 }}>
            <label className="small"><input type="checkbox" required /> Saya faham data contoh ini dipadam terus</label>
            <button type="submit" className="danger">Buang data contoh</button>
          </form>
        </div>
      )}

      <h2 className="small muted">Tambah agent</h2>
      <AddAgentForm sources={list.map((w) => ({ slug: w.slug, name: w.name }))} defaultSource={slug} />

      <h2 className="small muted" style={{ marginTop: 24 }}>Semua workspace</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Workspace</th><th>Admin</th><th>WhatsApp</th><th>Dicipta</th></tr></thead>
          <tbody>
            {list.map((w) => (
              <tr key={w.tenantId}>
                <td>
                  <a href={`/w/${w.slug}`}>{w.name}</a><div className="small muted">{w.slug}</div>
                  <details className="small" style={{ marginTop: 4 }}>
                    <summary>Tukar nama</summary>
                    <form action={rename} className="form" style={{ marginTop: 6 }}>
                      <input type="hidden" name="tenantId" value={w.tenantId} />
                      <input type="hidden" name="oldSlug" value={w.slug} />
                      <label>Nama workspace<input name="name" defaultValue={w.name} required minLength={2} maxLength={200} /></label>
                      <label>Alamat (slug, dalam URL)<input name="newSlug" defaultValue={w.slug} required pattern="[a-z0-9][a-z0-9\-]{1,62}" /></label>
                      <button type="submit">Simpan</button>
                    </form>
                  </details>
                </td>
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
