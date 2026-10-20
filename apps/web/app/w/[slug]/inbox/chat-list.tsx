import type { ConversationSummary } from '@chatbot/core';

export const FILTERS = [
  ['', 'All'],
  ['open', 'Active'],
  ['pending_human', 'Needs staff'],
  ['resolved', 'Resolved'],
] as const;

export type InboxStatus = 'open' | 'pending_human' | 'resolved';

const TZ = 'Asia/Kuala_Lumpur';
const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ });

/** WhatsApp-style time: clock time today, "Yesterday", then the date. */
export function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return d.toLocaleTimeString('en-MY', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  return d.toLocaleDateString('en-MY', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit' });
}

const COLORS = ['#25a36f', '#2f80ed', '#9b51e0', '#eb5757', '#f2994a', '#219ebc', '#d6336c', '#6c757d'];

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initials = /^[+\d]/.test(name) ? '👤' : name.replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '#';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="avatar" style={{ width: size, height: size, background: COLORS[h % COLORS.length], fontSize: size * 0.38 }} aria-hidden>
      {initials}
    </span>
  );
}

export const displayName = (c: Pick<ConversationSummary, 'contactName' | 'contactPhone'>) => c.contactName ?? c.contactPhone ?? 'No name';

export function BotPill({ state }: { state: ConversationSummary['botState'] }) {
  if (state === 'on') return <span className="pill bot">🤖 Bot</span>;
  if (state === 'off') return <span className="pill human">🙋 Human</span>;
  return <span className="pill">Not a lead</span>;
}

/** The left column: search, filters and the chat list, newest first. */
export function ChatList({ slug, rows, activeId, status, q }: { slug: string; rows: ConversationSummary[]; activeId?: string; status?: InboxStatus; q?: string }) {
  const qs = (s: string) => `/w/${slug}/inbox?${new URLSearchParams({ ...(s ? { status: s } : {}), ...(q ? { q } : {}) })}`;
  return (
    <aside className="wa-list">
      <div className="wa-list-head">
        <b>Chat</b>
        <form action={`/w/${slug}/inbox`} className="wa-search">
          {status && <input type="hidden" name="status" value={status} />}
          <input type="search" name="q" placeholder="Search name or number" defaultValue={q ?? ''} />
        </form>
        <div className="wa-chips">
          {FILTERS.map(([k, label]) => (
            <a key={k} href={qs(k)} className={(status ?? '') === k ? 'active' : ''}>{label}</a>
          ))}
        </div>
      </div>
      <div className="wa-items">
        {rows.length === 0 && <div className="muted" style={{ padding: 16 }}>No conversations.</div>}
        {rows.map((c) => (
          <a key={c.id} href={`/w/${slug}/inbox/${c.id}`} className={`wa-item${c.id === activeId ? ' active' : ''}`}>
            <Avatar name={displayName(c)} />
            <span className="wa-item-body">
              <span className="wa-item-top">
                <span className="wa-name">{displayName(c)}</span>
                <span className="wa-time">{shortTime(c.lastMessageAt)}</span>
              </span>
              <span className="wa-item-bottom">
                <span className="wa-preview">{c.lastMessagePreview ?? ''}</span>
                {c.status === 'pending_human' && <span className="pill warn">Needs staff</span>}
                <BotPill state={c.botState} />
              </span>
            </span>
          </a>
        ))}
      </div>
    </aside>
  );
}
