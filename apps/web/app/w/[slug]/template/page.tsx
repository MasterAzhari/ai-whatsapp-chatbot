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
    done = `${target}: ${r.rulesAdded} keywords added${r.rulesRemoved ? `, ${r.rulesRemoved} old keywords removed` : ''}`;
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
        if (!(file instanceof File) || file.size === 0) throw new Error('Choose a template file (.json) first.');
        if (file.size > MAX_FILE_BYTES) throw new Error('File is too large for a bot template.');
        let json: unknown;
        try {
          json = JSON.parse(await file.text());
        } catch {
          throw new Error('This file is not valid JSON.');
        }
        return importBotTemplate(db(), ctx, json, { replaceRules: f.get('replace') === 'on' });
      },
      'This workspace',
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
      <h1>Copy bot settings</h1>
      {sp.error && <div className="error">{sp.error}</div>}
      {sp.saved && <div className="notice">Copied. {sp.saved}.</div>}
      <p className="small muted">
        The template holds the persona, AI instructions, model, reply delay and all keywords. API keys, WhatsApp connections, contacts and conversations are not copied; each agent enters their own API key.
      </p>

      <h2 className="small muted">1. Download this workspace's template</h2>
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="form">
          <a className="button primary" href={`${path}/export`}>Download template ({current?.name})</a>
          <div className="small muted">Send this file to the agent. They import it on this page in their workspace.</div>
        </div>
      </div>

      {targets.length > 0 && (
        <>
          <h2 className="small muted">2. Copy straight to an agent's workspace</h2>
          <div className="panel" style={{ marginBottom: 24 }}>
            <form action={copyTo} className="form">
              <label>
                Target workspace
                <select name="target" required>
                  {targets.map((w) => <option key={w.slug} value={w.slug}>{w.name}</option>)}
                </select>
              </label>
              <label className="check"><input type="checkbox" name="replace" /> Remove existing keywords in the target workspace first</label>
              <button className="primary" type="submit">Copy settings there</button>
            </form>
          </div>
        </>
      )}

      <h2 className="small muted">{targets.length > 0 ? '3' : '2'}. Import a template into this workspace</h2>
      <div className="panel">
        <form action={importFile} className="form">
          <label>
            Template file (.json)
            <input type="file" name="file" accept="application/json,.json" required />
          </label>
          <label className="check"><input type="checkbox" name="replace" /> Remove all existing keywords first (otherwise keywords with the same name are replaced and the rest stay)</label>
          <div className="small muted">This workspace's bot settings will be replaced with the template contents.</div>
          <button className="primary" type="submit">Import</button>
        </form>
      </div>
    </>
  );
}
