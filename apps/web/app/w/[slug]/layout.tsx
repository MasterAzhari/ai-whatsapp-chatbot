import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { logout } from '@chatbot/core';
import { db, requireTenant, SESSION_COOKIE, workspaces } from '@/lib/server';

async function doLogout() {
  'use server';
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await logout(db(), token);
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}

export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  const ws = await workspaces(ctx.user);
  const current = ws.find((w) => w.slug === slug);
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Chatbot Admin</div>
        <div className="tenant">{current?.name}</div>
        <nav>
          <a href={`/w/${slug}`}>Dashboard</a>
          <a href={`/w/${slug}/inbox`}>Inbox</a>
          {ctx.role !== 'operator' && (
            <>
              <a href={`/w/${slug}/keywords`}>Keyword</a>
              <a href={`/w/${slug}/settings`}>Tetapan bot</a>
              <a href={`/w/${slug}/playground`}>Playground</a>
            </>
          )}
          <a href={`/w/${slug}/connections`}>Sambungan</a>
          {ws.length > 1 && <a href="/">Tukar workspace</a>}
        </nav>
        <div className="bottom">
          <div>{ctx.user.name}</div>
          <div>{ctx.role}</div>
          <form action={doLogout}>
            <button type="submit" style={{ marginTop: 8 }}>Log keluar</button>
          </form>
        </div>
      </aside>
      <main>{children}</main>
    </div>
  );
}
