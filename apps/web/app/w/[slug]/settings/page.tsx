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
          followupEnabled: f.get('followupEnabled') === 'on',
          // Hours on the form, minutes in the database; an empty box means fewer follow-ups.
          followupGapsMin: [1, 2, 3].map((i) => opt(`followupGap${i}`)).filter((v) => v != null).map((v) => Math.round(Number(v) * 60)),
          followupStartHour: Number(f.get('followupStartHour')),
          followupEndHour: Number(f.get('followupEndHour')),
          followupInstruction: String(f.get('followupInstruction') ?? ''),
          notifyNumbers: [1, 2, 3].map((i) => opt(`notifyNumber${i}`)).filter((v): v is string => v != null),
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
      <h1>Bot settings</h1>
      {sp.error && <div className="error">{sp.error}</div>}
      {sp.saved && <div className="notice">Saved.</div>}
      {!aiReady && (
        <div className="notice">
          AI is not active yet. Needed: an API key for the chosen provider, a chosen model, the workspace AI switch on, and the AI switch on the channel. Keywords still work without AI.
        </div>
      )}

      {AI_PROVIDERS.map((p) => (
        <div key={p}>
          <h2 className="small muted">{PROVIDER_LABEL[p]} API key{p === s.aiProvider ? ' (in use)' : ''}</h2>
          <div className="panel" style={{ marginBottom: 24 }}>
            <div className="form">
              <div>Status: {s.keysMasked[p] ? <span className="badge ok">Saved ({s.keysMasked[p]})</span> : <span className="badge warn">None</span>}</div>
              <form action={saveKey} className="form" style={{ padding: 0 }}>
                <input type="hidden" name="provider" value={p} />
                <label>
                  New key (stored encrypted; will not be shown again)
                  <input type="password" name="key" autoComplete="off" required minLength={10} maxLength={500} />
                </label>
                <button className="primary" type="submit">Save key</button>
              </form>
              {s.keysMasked[p] && (
                <form action={clearKey}>
                  <input type="hidden" name="provider" value={p} />
                  <button className="danger" type="submit">Remove key</button>
                </form>
              )}
            </div>
          </div>
        </div>
      ))}

      <h2 className="small muted">Channel switches</h2>
      <div className="panel" style={{ marginBottom: 24 }}>
        <table>
          <thead><tr><th>Channel</th><th>Automation (keyword + AI)</th><th>AI</th></tr></thead>
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

      <h2 className="small muted">Persona and AI</h2>
      <div className="panel">
        <form action={save} className="form">
          <input type="hidden" name="version" value={s.version} />
          <div className="row">
            <label>Persona name<input name="personaName" required maxLength={80} defaultValue={s.personaName} /></label>
            <label>Main language<input name="language" required maxLength={10} defaultValue={s.language} /></label>
          </div>
          <label>
            System instruction (style, scope, what it may and may not answer)
            <textarea name="systemInstruction" rows={8} maxLength={12000} defaultValue={s.systemInstruction} />
          </label>
          <div className="small muted">
            Fixed safety rules are always added: no made-up prices or promotions, no approvals, and instructions in customer messages are ignored.
          </div>
          <label className="check"><input type="checkbox" name="aiEnabled" defaultChecked={s.aiEnabled} /> AI on for this workspace</label>
          <label className="check"><input type="checkbox" name="leadMode" defaultChecked={s.leadMode} /> Leads only</label>
          <label>How long to serve each lead (days from first lead keyword; 0 = no limit)<input name="leadDays" type="number" min={0} max={365} defaultValue={s.leadDays} /></label>
          <div className="small muted">When on, the bot and AI only reply to chats that start with a lead keyword (e.g. ad text &quot;Saya nak info Aircond&quot;). Other chats, such as team or friends, get no reply; you answer them yourself. After the period ends, the bot stops for that lead until they send a lead keyword again. Mark lead keywords on the Keyword page.</div>
          <label>
            AI provider
            <select name="aiProvider" defaultValue={s.aiProvider}>
              {AI_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
            </select>
          </label>
          <div className="small muted">When you change provider, change the model too (e.g. Claude: claude-haiku-5-5; Gemini: gemini-3.5-flash-lite).</div>
          <label>
            Model
            <input name="aiModel" list="models" maxLength={80} defaultValue={s.aiModel ?? ''} placeholder="Pick from the model list" />
          </label>
          {models && (
            <datalist id="models">
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
          )}
          <div className="small">
            {s.aiKeyMasked ? (
              models ? <span className="muted">{models.length} models available for this key. Type to search.</span>
              : modelsError ? <span className="error">Could not get the model list: {modelsError}</span>
              : <a href={`${path}?models=1`}>Load model list from {PROVIDER_LABEL[s.aiProvider]}</a>
            ) : (
              <span className="muted">Save an API key first to see the model list.</span>
            )}
          </div>
          <div className="row">
            <label>Answer token limit<input name="maxOutputTokens" type="number" min={16} max={8192} defaultValue={s.maxOutputTokens} /></label>
            <label>Temperature (Gemini only; empty = default)<input name="temperature" type="number" min={0} max={2} step="0.1" defaultValue={s.temperature ?? ''} /></label>
          </div>
          <div className="row">
            <label>History messages<input name="historyTurns" type="number" min={1} max={50} defaultValue={s.historyTurns} /></label>
            <label>AI timeout (seconds)<input name="aiTimeoutSec" type="number" min={1} max={120} defaultValue={s.aiTimeoutMs / 1000} /></label>
          </div>
          <div className="row">
            <label>Minimum reply delay (seconds)<input name="replyDelayMinSec" type="number" min={0} max={120} defaultValue={s.replyDelayMinSec} /></label>
            <label>Maximum reply delay (seconds)<input name="replyDelayMaxSec" type="number" min={0} max={120} defaultValue={s.replyDelayMaxSec} /></label>
          </div>
          <label className="check"><input type="checkbox" name="typingIndicator" defaultChecked={s.typingIndicator} /> Show &quot;typing…&quot; before replying (WhatsApp QR)</label>
          <div className="small muted">The bot waits a random time between minimum and maximum, then types for a time based on the answer length. Human replies are not delayed.</div>
          <label>
            Reply when AI fails (empty = hand straight over to a human)
            <textarea name="fallbackReply" rows={2} maxLength={1000} defaultValue={s.fallbackReply ?? ''} />
          </label>
          <label>
            Reply when a customer asks for a human
            <textarea name="handoverReply" rows={2} maxLength={1000} defaultValue={s.handoverReply ?? ''} />
          </label>
          <label>
            Reply when a lead sends a video, or a voice note or picture the AI cannot read (leave empty for no reply; the chat is still marked needs staff)
            <textarea name="mediaReply" rows={2} maxLength={1000} defaultValue={s.mediaReply ?? ''} />
          </label>
          <h3 className="small muted">Auto follow-up</h3>
          <label className="check"><input type="checkbox" name="followupEnabled" defaultChecked={s.followupEnabled} /> Follow up customers who go quiet</label>
          <div className="row">
            {[0, 1, 2].map((i) => (
              <label key={i}>
                Follow-up {i + 1} (hours after the previous bot message)
                <input name={`followupGap${i + 1}`} type="number" min={0.25} max={168} step={0.25} defaultValue={s.followupGapsMin[i] != null ? s.followupGapsMin[i]! / 60 : ''} />
              </label>
            ))}
          </div>
          <div className="row">
            <label>Send from hour (Malaysia time)<input name="followupStartHour" type="number" min={0} max={23} defaultValue={s.followupStartHour} /></label>
            <label>Until hour<input name="followupEndHour" type="number" min={1} max={24} defaultValue={s.followupEndHour} /></label>
          </div>
          <label>
            Follow-up style for AI
            <textarea name="followupInstruction" rows={3} maxLength={2000} defaultValue={s.followupInstruction} />
          </label>
          <div className="small muted">
            When a customer does not reply to the bot, AI sends follow-ups at the times above, at most 3 times, then stops until the customer messages again. Clear a box to send fewer. No follow-ups for chats staff are handling, that need staff, are resolved, are labelled Rejected, or where the customer asked to be contacted later. Only chats the bot replied to after this switch was turned on.
          </div>
          <h3 className="small muted">Staff notifications (WhatsApp)</h3>
          <div className="row">
            {[0, 1, 2].map((i) => (
              <label key={i}>
                Staff number {i + 1}
                <input name={`notifyNumber${i + 1}`} type="tel" placeholder="0123456789" maxLength={20} defaultValue={s.notifyNumbers[i] ? `0${s.notifyNumbers[i]!.slice(2)}` : ''} />
              </label>
            ))}
          </div>
          <div className="small muted">
            When a chat needs staff (customer asks for staff, a hand-over keyword such as a filled form, or AI cannot answer), the bot sends a WhatsApp to these numbers with the customer's name, number and a link to the chat. The bot does not reply to messages from staff numbers. These numbers are not copied in templates.
          </div>
          <label>Stop keywords (exact message, one per line)<textarea name="stopKeywords" rows={3} defaultValue={s.stopKeywords.join('\n')} /></label>
          <label>Ask-for-human keywords (phrase, one per line)<textarea name="humanKeywords" rows={3} defaultValue={s.humanKeywords.join('\n')} /></label>
          <button className="primary" type="submit">Save settings</button>
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
      <span className={`badge ${on ? 'ok' : 'warn'}`}>{on ? 'On' : 'Off'}</span>{' '}
      <button type="submit">{on ? 'Turn off' : 'Turn on'}</button>
    </form>
  );
}
