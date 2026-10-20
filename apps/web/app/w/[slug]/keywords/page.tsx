import { redirect } from 'next/navigation';
import { createKeywordRule, deleteKeywordRule, getDashboard, listKeywordRules, saveImageAsset, setKeywordRuleEnabled, updateKeywordRule, type KeywordRuleView, type TenantContext } from '@chatbot/core';
import { actionError, db, lines, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** The rule's picture: a new upload, kept as it was, or removed. */
async function imageFromForm(ctx: TenantContext, f: FormData): Promise<string | null> {
  const file = f.get('image');
  if (file instanceof File && file.size > 0) return saveImageAsset(db(), ctx, file.type, Buffer.from(await file.arrayBuffer()));
  if (f.get('removeImage') === 'on') return null;
  return String(f.get('currentImage') ?? '') || null;
}

function ruleFromForm(f: FormData, imageAssetId: string | null) {
  const reply = String(f.get('replyText') ?? '').trim();
  const label = String(f.get('setLabel') ?? '').trim();
  const channel = String(f.get('channelId') ?? '');
  return {
    name: String(f.get('name') ?? ''),
    matchType: f.get('matchType') === 'exact' ? ('exact' as const) : ('phrase' as const),
    patterns: lines(f.get('patterns')),
    priority: Number(f.get('priority') || 100),
    enabled: f.get('enabled') === 'on',
    channelId: channel || null,
    replyText: reply || null,
    setLabel: label || null,
    handover: f.get('handover') === 'on',
    startsLead: f.get('startsLead') === 'on',
    cooldownSeconds: Math.round(Number(f.get('cooldownMinutes') || 0) * 60),
    imageAssetId,
  };
}

/** Runs a change, then returns to the page with an error message if it failed. */
async function run(path: string, fn: () => Promise<unknown>) {
  let msg: string | null = null;
  try {
    await fn();
  } catch (err) {
    msg = actionError(err);
  }
  redirect(msg ? `${path}?error=${encodeURIComponent(msg)}` : path);
}

export default async function Keywords({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; edit?: string }> }) {
  const { slug } = await params;
  const { error, edit } = await searchParams;
  const ctx = await requireTenant(slug);
  const rules = await listKeywordRules(db(), ctx);
  const { channels } = await getDashboard(db(), ctx);
  const path = `/w/${slug}/keywords`;
  const isAdmin = ctx.role !== 'operator';

  async function create(f: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    await run(path, async () => createKeywordRule(db(), ctx, ruleFromForm(f, await imageFromForm(ctx, f))));
  }
  async function update(f: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    await run(path, async () => updateKeywordRule(db(), ctx, String(f.get('id')), Number(f.get('version')), ruleFromForm(f, await imageFromForm(ctx, f))));
  }
  async function toggle(f: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    await run(path, () => setKeywordRuleEnabled(db(), ctx, String(f.get('id')), f.get('enabled') === 'true'));
  }
  async function remove(f: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    await run(path, () => deleteKeywordRule(db(), ctx, String(f.get('id'))));
  }

  const editing = rules.find((r) => r.id === edit);
  return (
    <>
      <h1>Keyword</h1>
      <p className="small muted">
        Keyword diperiksa sebelum AI. Padanan &quot;frasa&quot; mencari perkataan penuh dalam mesej (&quot;ok&quot; tidak padan dengan &quot;book&quot;); &quot;tepat&quot; perlukan
        keseluruhan mesej sama. Nombor keutamaan lebih kecil diperiksa dulu, dan hanya satu peraturan dipakai bagi setiap mesej.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="panel" style={{ marginBottom: 24 }}>
        <table>
          <thead>
            <tr><th>Keutamaan</th><th>Nama</th><th>Padanan</th><th>Tindakan</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {rules.length === 0 && <tr><td colSpan={6} className="muted">Belum ada peraturan.</td></tr>}
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.priority}</td>
                <td>{r.name}{r.channelId && <div className="small muted">{channels.find((c) => c.id === r.channelId)?.name ?? 'channel lain'}</div>}</td>
                <td><span className="small muted">{r.matchType === 'exact' ? 'tepat' : 'frasa'}:</span> {r.patterns.join(', ')}</td>
                <td className="small">
                  {r.imageAssetId && <img src={`/w/${slug}/media/${r.imageAssetId}`} alt="Gambar" style={{ display: 'block', maxWidth: 80, borderRadius: 6, marginBottom: 4 }} />}
                  {r.replyText && <div>Balas: {r.replyText.slice(0, 80)}</div>}
                  {r.setLabel && <div>Label: {r.setLabel}</div>}
                  {r.startsLead && <div><span className="badge ok">Keyword lead</span></div>}
                  {r.handover && <div>Serah kepada manusia</div>}
                  {r.cooldownSeconds > 0 && <div className="muted">Rehat {Math.round(r.cooldownSeconds / 60)} min</div>}
                </td>
                <td><span className={`badge ${r.enabled ? 'ok' : 'warn'}`}>{r.enabled ? 'Hidup' : 'Mati'}</span></td>
                <td>
                  {isAdmin && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <a href={`${path}?edit=${r.id}`}>Ubah</a>
                      <form action={toggle} className="inline">
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="enabled" value={String(!r.enabled)} />
                        <button type="submit">{r.enabled ? 'Matikan' : 'Hidupkan'}</button>
                      </form>
                      <form action={remove} className="inline">
                        <input type="hidden" name="id" value={r.id} />
                        <button type="submit">Padam</button>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isAdmin && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>{editing ? `Ubah "${editing.name}"` : 'Peraturan baru'}</h2>
          <RuleForm key={editing?.id ?? 'new'} action={editing ? update : create} rule={editing} channels={channels} slug={slug} />
          {editing && <a href={path}>Batal</a>}
        </div>
      )}
    </>
  );
}

function RuleForm({ action, rule, channels, slug }: { action: (f: FormData) => Promise<void>; rule?: KeywordRuleView; channels: Array<{ id: string; name: string }>; slug: string }) {
  return (
    <form action={action} className="form">
      {rule && <input type="hidden" name="id" value={rule.id} />}
      {rule && <input type="hidden" name="version" value={rule.version} />}
      <label>Nama<input name="name" required maxLength={100} defaultValue={rule?.name} /></label>
      <label>
        Jenis padanan
        <select name="matchType" defaultValue={rule?.matchType ?? 'phrase'}>
          <option value="phrase">Frasa (perkataan penuh dalam mesej)</option>
          <option value="exact">Tepat (seluruh mesej)</option>
        </select>
      </label>
      <label>Keyword (satu setiap baris)<textarea name="patterns" rows={3} required defaultValue={rule?.patterns.join('\n')} /></label>
      <label>Balasan tetap<textarea name="replyText" rows={5} maxLength={4096} defaultValue={rule?.replyText ?? ''} /></label>
      <div className="small muted">Untuk hantar sebagai beberapa bubble (maksimum 4), letak satu baris <code>---</code> antara setiap bubble. Gambar dihantar bersama bubble pertama.</div>
      <label>
        Gambar bersama balasan (pilihan: poster atau gambar produk, JPG/PNG/WebP sehingga 5 MB; balasan jadi kapsyen, maksimum 1000 aksara)
        {rule?.imageAssetId && <img src={`/w/${slug}/media/${rule.imageAssetId}`} alt="Gambar semasa" style={{ display: 'block', maxWidth: 160, borderRadius: 8, margin: '6px 0' }} />}
        <input type="file" name="image" accept="image/jpeg,image/png,image/webp" />
      </label>
      {rule?.imageAssetId && (
        <>
          <input type="hidden" name="currentImage" value={rule.imageAssetId} />
          <label className="check"><input type="checkbox" name="removeImage" /> Buang gambar</label>
        </>
      )}
      <label>Label pelanggan (pilihan)<input name="setLabel" maxLength={60} defaultValue={rule?.setLabel ?? ''} /></label>
      <label>
        Channel
        <select name="channelId" defaultValue={rule?.channelId ?? ''}>
          <option value="">Semua channel</option>
          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label>Keutamaan (kecil dulu)<input name="priority" type="number" min={0} max={10000} defaultValue={rule?.priority ?? 100} /></label>
      <label>Rehat sebelum padan lagi dalam perbualan sama (minit)<input name="cooldownMinutes" type="number" min={0} step="1" defaultValue={rule ? Math.round(rule.cooldownSeconds / 60) : 0} /></label>
      <label className="check"><input type="checkbox" name="handover" defaultChecked={rule?.handover} /> Serahkan perbualan kepada manusia</label>
      <label className="check"><input type="checkbox" name="startsLead" defaultChecked={rule?.startsLead} /> Keyword lead: chat yang masuk dengan keyword ini dilayan bot dan AI (untuk mod &quot;Layan lead sahaja&quot;)</label>
      <label className="check"><input type="checkbox" name="enabled" defaultChecked={rule?.enabled ?? true} /> Hidup</label>
      <button className="primary" type="submit">Simpan</button>
    </form>
  );
}
