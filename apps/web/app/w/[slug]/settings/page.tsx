import { redirect } from 'next/navigation';
import { AI_PROVIDERS, KEY_KIND, createAiResolver, getBotSettings, getDashboard, setChannelSwitches, setCredential, updateBotSettings } from '@chatbot/core';
import { actionError, db, lines, requireTenant } from '@/lib/server';

export const dynamic = 'force-dynamic';

const PROVIDER_LABEL = { gemini: 'Gemini (Google)', anthropic: 'Claude (Anthropic)' } as const;

/** Maps the submitted provider field to its credential kind; rejects anything else. */
function keyKind(f: FormData) {
  const p = String(f.get('provider'));
  const provider = AI_PROVIDERS.find((x) => x === p);
  if (!provider) throw new Error('unknown provider');
  return KEY_KIND[provider] as 'gemini_api_key' | 'anthropic_api_key';
}

/** Runs a change, then returns to the page with an error or a saved notice. */
async function run(path: string, fn: () => Promise<unknown>, done: string) {
  let msg: string | null = null;
  try {
    await fn();
  } catch (err) {
    msg = actionError(err);
  }
  redirect(msg ? `${path}?error=${encodeURIComponent(msg)}` : `${path}?saved=${done}`);
}

export default async function Settings({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; saved?: string; models?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (ctx.role === 'operator') redirect(`/w/${slug}`);
  const s = await getBotSettings(db(), ctx);
  const { channels } = await getDashboard(db(), ctx);
  const path = `/w/${slug}/settings`;

  // The model list comes from the provider for this key, only when asked.
  let models: string[] | null = null;
  let modelsError: string | null = null;
  if (sp.models && s.aiKeyMasked) {
    try {
      const p = await createAiResolver(db())(ctx.tenantId);
      models = (await p?.listModels?.()) ?? [];
    } catch (err) {
      modelsError = actionError(err);
    }
  }

  async function save(f: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    const opt = (k: string) => String(f.get(k) ?? '').trim() || null;
    const temp = opt('temperature');
    await run(
      path,
      () =>
        updateBotSettings(db(), ctx, {
          expectedVersion: Number(f.get('version')),
          personaName: String(f.get('personaName') ?? ''),
          language: String(f.get('language') ?? 'ms'),
          systemInstruction: String(f.get('systemInstruction') ?? ''),
          aiEnabled: f.get('aiEnabled') === 'on',
          aiProvider: String(f.get('aiProvider')) as 'gemini' | 'anthropic',
          aiModel: opt('aiModel'),
          maxOutputTokens: Number(f.get('maxOutputTokens')),
          temperature: temp == null ? null : Number(temp),
          historyTurns: Number(f.get('historyTurns')),
          aiTimeoutMs: Math.round(Number(f.get('aiTimeoutSec')) * 1000),
          fallbackReply: opt('fallbackReply'),
          handoverReply: opt('handoverReply'),
          mediaReply: opt('mediaReply'),
          stopKeywords: lines(f.get('stopKeywords')),
          humanKeywords: lines(f.get('humanKeywords')),
          replyDelayMinSec: Number(f.get('replyDelayMinSec')),
          replyDelayMaxSec: Number(f.get('replyDelayMaxSec')),
          typingIndicator: f.get('typingIndicator') === 'on',
          leadMode: f.get('leadMode') === 'on',
          leadDays: Number(f.get('leadDays')),
        }),
      'settings',
    );
  }
  async function saveKey(f: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    await run(path, () => setCredential(db(), ctx, keyKind(f), String(f.get('key') ?? '')), 'key');
  }
  async function clearKey(f: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    await run(path, () => setCredential(db(), ctx, keyKind(f), null), 'key');
  }
  async function switches(f: FormData) {
    'use server';
    const ctx = await requireTenant(slug);
    const field = String(f.get('field'));
    const on = f.get('on') === 'true';
    await run(
      path,
      () => setChannelSwitches(db(), ctx, String(f.get('channelId')), field === 'ai' ? { aiEnabled: on } : { automationEnabled: on }),
      'channel',
    );
  }

  const aiReady = s.aiEnabled && s.aiModel && s.aiKeyMasked;
  return (
    <>
      <h1>Tetapan bot</h1>
      {sp.error && <div className="error">{sp.error}</div>}
      {sp.saved && <div className="notice">Disimpan.</div>}
      {!aiReady && (
        <div className="notice">
          AI belum aktif. Perlu: kunci API untuk penyedia yang dipilih, model dipilih, suis AI workspace hidup, dan suis AI pada channel. Keyword tetap berfungsi tanpa AI.
        </div>
      )}

      {AI_PROVIDERS.map((p) => (
        <div key={p}>
          <h2 className="small muted">Kunci API {PROVIDER_LABEL[p]}{p === s.aiProvider ? ' (sedang digunakan)' : ''}</h2>
          <div className="panel" style={{ marginBottom: 24 }}>
            <div className="form">
              <div>Status: {s.keysMasked[p] ? <span className="badge ok">Disimpan ({s.keysMasked[p]})</span> : <span className="badge warn">Tiada</span>}</div>
              <form action={saveKey} className="form" style={{ padding: 0 }}>
                <input type="hidden" name="provider" value={p} />
                <label>
                  Kunci baru (disimpan bersulit; tidak akan dipaparkan semula)
                  <input type="password" name="key" autoComplete="off" required minLength={10} maxLength={500} />
                </label>
                <button className="primary" type="submit">Simpan kunci</button>
              </form>
              {s.keysMasked[p] && (
                <form action={clearKey}>
                  <input type="hidden" name="provider" value={p} />
                  <button className="danger" type="submit">Buang kunci</button>
                </form>
              )}
            </div>
          </div>
        </div>
      ))}

      <h2 className="small muted">Suis channel</h2>
      <div className="panel" style={{ marginBottom: 24 }}>
        <table>
          <thead><tr><th>Channel</th><th>Automasi (keyword + AI)</th><th>AI</th></tr></thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td><Toggle action={switches} channelId={c.id} field="automation" on={c.automationEnabled} /></td>
                <td><Toggle action={switches} channelId={c.id} field="ai" on={c.aiEnabled} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="small muted">Persona dan AI</h2>
      <div className="panel">
        <form action={save} className="form">
          <input type="hidden" name="version" value={s.version} />
          <div className="row">
            <label>Nama persona<input name="personaName" required maxLength={80} defaultValue={s.personaName} /></label>
            <label>Bahasa utama<input name="language" required maxLength={10} defaultValue={s.language} /></label>
          </div>
          <label>
            Arahan sistem (gaya, skop, apa yang boleh dan tak boleh dijawab)
            <textarea name="systemInstruction" rows={8} maxLength={8000} defaultValue={s.systemInstruction} />
          </label>
          <div className="small muted">
            Peraturan keselamatan tetap sentiasa ditambah: tiada harga atau promosi rekaan, tiada kelulusan, dan arahan dalam mesej pelanggan diabaikan.
          </div>
          <label className="check"><input type="checkbox" name="aiEnabled" defaultChecked={s.aiEnabled} /> AI hidup untuk workspace ini</label>
          <label className="check"><input type="checkbox" name="leadMode" defaultChecked={s.leadMode} /> Layan lead sahaja</label>
          <label>Tempoh layan setiap lead (hari dari keyword lead pertama; 0 = tiada had)<input name="leadDays" type="number" min={0} max={365} defaultValue={s.leadDays} /></label>
          <div className="small muted">Bila hidup, bot dan AI hanya membalas chat yang bermula dengan keyword lead (contoh teks iklan &quot;Saya nak info Aircond&quot;). Chat lain, seperti team atau kawan, tidak dibalas; anda jawab sendiri. Selepas tempoh tamat, bot berhenti untuk lead itu sehingga dia hantar keyword lead semula. Tanda keyword lead di halaman Keyword.</div>
          <label>
            Penyedia AI
            <select name="aiProvider" defaultValue={s.aiProvider}>
              {AI_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
            </select>
          </label>
          <div className="small muted">Bila tukar penyedia, tukar juga model (contoh Claude: claude-haiku-5-5; Gemini: gemini-3.5-flash-lite).</div>
          <label>
            Model
            <input name="aiModel" list="models" maxLength={80} defaultValue={s.aiModel ?? ''} placeholder="Pilih dari senarai model" />
          </label>
          {models && (
            <datalist id="models">
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
          )}
          <div className="small">
            {s.aiKeyMasked ? (
              models ? <span className="muted">{models.length} model tersedia untuk kunci ini. Taip untuk cari.</span>
              : modelsError ? <span className="error">Gagal dapatkan senarai model: {modelsError}</span>
              : <a href={`${path}?models=1`}>Muat senarai model dari {PROVIDER_LABEL[s.aiProvider]}</a>
            ) : (
              <span className="muted">Simpan kunci API dulu untuk lihat senarai model.</span>
            )}
          </div>
          <div className="row">
            <label>Had token jawapan<input name="maxOutputTokens" type="number" min={16} max={8192} defaultValue={s.maxOutputTokens} /></label>
            <label>Temperature (Gemini sahaja; kosong = lalai)<input name="temperature" type="number" min={0} max={2} step="0.1" defaultValue={s.temperature ?? ''} /></label>
          </div>
          <div className="row">
            <label>Bilangan mesej sejarah<input name="historyTurns" type="number" min={1} max={50} defaultValue={s.historyTurns} /></label>
            <label>Had masa AI (saat)<input name="aiTimeoutSec" type="number" min={1} max={120} defaultValue={s.aiTimeoutMs / 1000} /></label>
          </div>
          <div className="row">
            <label>Lengah balasan minimum (saat)<input name="replyDelayMinSec" type="number" min={0} max={120} defaultValue={s.replyDelayMinSec} /></label>
            <label>Lengah balasan maksimum (saat)<input name="replyDelayMaxSec" type="number" min={0} max={120} defaultValue={s.replyDelayMaxSec} /></label>
          </div>
          <label className="check"><input type="checkbox" name="typingIndicator" defaultChecked={s.typingIndicator} /> Tunjuk &quot;sedang menaip…&quot; sebelum balas (WhatsApp QR)</label>
          <div className="small muted">Bot menunggu masa rawak antara minimum dan maksimum, kemudian menaip mengikut panjang jawapan. Balasan manusia tidak dilengahkan.</div>
          <label>
            Balasan bila AI gagal (kosong = serah terus kepada manusia)
            <textarea name="fallbackReply" rows={2} maxLength={1000} defaultValue={s.fallbackReply ?? ''} />
          </label>
          <label>
            Balasan bila pelanggan minta manusia
            <textarea name="handoverReply" rows={2} maxLength={1000} defaultValue={s.handoverReply ?? ''} />
          </label>
          <label>
            Balasan bila lead hantar voice note, gambar atau video tanpa teks (kosongkan untuk tidak membalas; chat tetap ditanda perlu staf)
            <textarea name="mediaReply" rows={2} maxLength={1000} defaultValue={s.mediaReply ?? ''} />
          </label>
          <label>Keyword berhenti (mesej tepat, satu setiap baris)<textarea name="stopKeywords" rows={3} defaultValue={s.stopKeywords.join('\n')} /></label>
          <label>Keyword minta manusia (frasa, satu setiap baris)<textarea name="humanKeywords" rows={3} defaultValue={s.humanKeywords.join('\n')} /></label>
          <button className="primary" type="submit">Simpan tetapan</button>
        </form>
      </div>
    </>
  );
}

function Toggle({ action, channelId, field, on }: { action: (f: FormData) => Promise<void>; channelId: string; field: string; on: boolean }) {
  return (
    <form action={action} className="inline">
      <input type="hidden" name="channelId" value={channelId} />
      <input type="hidden" name="field" value={field} />
      <input type="hidden" name="on" value={String(!on)} />
      <span className={`badge ${on ? 'ok' : 'warn'}`}>{on ? 'Hidup' : 'Mati'}</span>{' '}
      <button type="submit">{on ? 'Matikan' : 'Hidupkan'}</button>
    </form>
  );
}
