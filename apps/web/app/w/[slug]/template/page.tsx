import { redirect } from 'next/navigation';
import { exportBotTemplate, importBotTemplate, listMemberships } from '@chatbot/core';
import { actionError, db, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 15 * 1024 * 1024; // room for a few keyword pictures

/** Runs a change, then returns to the page with an error or a saved notice. */
async function run(path: string, fn: () => Promise<{ rulesAdded: number; rulesRemoved: number }>, target: string) {
  let msg: string | null = null;
  let done = '';
  try {
    const r = await fn();
    done = `${target}: ${r.rulesAdded} keyword ditambah${r.rulesRemoved ? `, ${r.rulesRemoved} keyword lama dibuang` : ''}`;
  } catch (err) {
    msg = actionError(err);
  }
  redirect(msg ? `${path}?error=${encodeURIComponent(msg)}` : `${path}?saved=${encodeURIComponent(done)}`);
}

export default async function Template({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (ctx.role === 'operator') redirect(`/w/${slug}`);
  const path = `/w/${slug}/template`;
  const ws = await listMemberships(db(), ctx.user);
  const current = ws.find((w) => w.slug === slug);
  const targets = ws.filter((w) => w.slug !== slug && w.role !== 'operator');

  async function importFile(f: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    const file = f.get('file');
    await run(
      path,
      async () => {
        if (!(file instanceof File) || file.size === 0) throw new Error('Pilih fail template (.json) dulu.');
        if (file.size > MAX_FILE_BYTES) throw new Error('Fail terlalu besar untuk template bot.');
        let json: unknown;
        try {
          json = JSON.parse(await file.text());
        } catch {
          throw new Error('Fail ini bukan JSON yang sah.');
        }
        return importBotTemplate(db(), ctx, json, { replaceRules: f.get('replace') === 'on' });
      },
      'Workspace ini',
    );
  }
  async function copyTo(f: FormData) {
    'use server';
    const from = await requireTenant(slug);
    const targetSlug = String(f.get('target') ?? '');
    // requireTenant checks this user may open the target; importBotTemplate checks admin there.
    const to = await requireTenant(targetSlug);
    const name = (await listMemberships(db(), from.user)).find((w) => w.slug === targetSlug)?.name ?? targetSlug;
    await run(
      path,
      async () => importBotTemplate(db(), to, await exportBotTemplate(db(), from, current?.name), { replaceRules: f.get('replace') === 'on' }),
      name,
    );
  }

  return (
    <>
      <h1>Salin tetapan bot</h1>
      {sp.error && <div className="error">{sp.error}</div>}
      {sp.saved && <div className="notice">Disalin. {sp.saved}.</div>}
      <p className="small muted">
        Template mengandungi persona, arahan AI, model, lengah balasan dan semua keyword. Kunci API, sambungan WhatsApp, kenalan dan perbualan tidak disalin; setiap agent masukkan kunci API sendiri.
      </p>

      <h2 className="small muted">1. Muat turun template workspace ini</h2>
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="form">
          <a className="button primary" href={`${path}/export`}>Muat turun template ({current?.name})</a>
          <div className="small muted">Hantar fail ini kepada agent. Mereka import di halaman ini dalam workspace mereka.</div>
        </div>
      </div>

      {targets.length > 0 && (
        <>
          <h2 className="small muted">2. Salin terus ke workspace agent</h2>
          <div className="panel" style={{ marginBottom: 24 }}>
            <form action={copyTo} className="form">
              <label>
                Workspace tujuan
                <select name="target" required>
                  {targets.map((w) => <option key={w.slug} value={w.slug}>{w.name}</option>)}
                </select>
              </label>
              <label className="check"><input type="checkbox" name="replace" /> Buang keyword sedia ada di workspace tujuan dulu</label>
              <button className="primary" type="submit">Salin tetapan ke sana</button>
            </form>
          </div>
        </>
      )}

      <h2 className="small muted">{targets.length > 0 ? '3' : '2'}. Import template ke workspace ini</h2>
      <div className="panel">
        <form action={importFile} className="form">
          <label>
            Fail template (.json)
            <input type="file" name="file" accept="application/json,.json" required />
          </label>
          <label className="check"><input type="checkbox" name="replace" /> Buang semua keyword sedia ada dulu (jika tidak, keyword sama nama diganti dan yang lain kekal)</label>
          <div className="small muted">Tetapan bot workspace ini akan diganti dengan isi template.</div>
          <button className="primary" type="submit">Import</button>
        </form>
      </div>
    </>
  );
}
