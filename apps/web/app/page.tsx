import { redirect } from 'next/navigation';
import { requireUser, workspaces } from '@/lib/server';

export default async function Home() {
  const user = await requireUser();
  const ws = await workspaces(user);
  if (ws.length === 1) redirect(`/w/${ws[0]!.slug}`);
  return (
    <main>
      <h1>Choose a workspace</h1>
      {ws.length === 0 && <p className="muted">This account has no access to any workspace yet.</p>}
      <div className="panel list">
        {ws.map((w) => (
          <a key={w.tenantId} className="row" href={`/w/${w.slug}`}>
            <span>{w.name}</span>
            <span className="badge">{w.role}</span>
          </a>
        ))}
      </div>
    </main>
  );
}
