import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createPool, getSessionUser, listMemberships, resolveTenantContext, type Db, type SessionUser, type TenantContext } from '@chatbot/core';

export const SESSION_COOKIE = 'cb_session';

const g = globalThis as unknown as { __chatbotDb?: Db };
export function db(): Db {
  g.__chatbotDb ??= createPool();
  return g.__chatbotDb;
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUser(db(), token);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

/** Authorised tenant context for a workspace route; redirects or 404s otherwise. */
export async function requireTenant(slug: string): Promise<TenantContext> {
  const user = await requireUser();
  try {
    return await resolveTenantContext(db(), user, slug);
  } catch {
    redirect('/');
  }
}

export async function workspaces(user: SessionUser) {
  return listMemberships(db(), user);
}
