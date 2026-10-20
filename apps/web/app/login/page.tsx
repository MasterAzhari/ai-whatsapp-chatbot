import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { login, SESSION_TTL_MS } from '@chatbot/core';
import { currentUser, db, SESSION_COOKIE } from '@/lib/server';

async function doLogin(formData: FormData) {
  'use server';
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const token = await login(db(), email, password, (await headers()).get('user-agent') ?? undefined);
  if (!token) redirect('/login?error=1');
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  redirect('/');
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect('/');
  const { error } = await searchParams;
  return (
    <form action={doLogin} className="login">
      <div className="brand">MasterBot</div>
      <h1>Log masuk</h1>
      {error && <div className="error">Email atau kata laluan salah.</div>}
      <label>
        Email
        <input type="email" name="email" required autoComplete="username" />
      </label>
      <label>
        Kata laluan
        <input type="password" name="password" required autoComplete="current-password" />
      </label>
      <button className="primary" type="submit">Log masuk</button>
    </form>
  );
}
