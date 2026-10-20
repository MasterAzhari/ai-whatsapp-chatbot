import { z } from 'zod';
import type { Db } from '../db.js';
import { inTenant, requireRole, type TenantContext } from '../auth.js';
import type { ChannelStatus } from '../channels/adapter.js';
import { GatewayChannelAdapter } from '../channels/gateway-client.js';
import { audit } from './audit.js';

export interface QrControl {
  getStatus(): Promise<ChannelStatus>;
  connect(): Promise<ChannelStatus>;
  disconnect(): Promise<void>;
}

const defaultControl = (channelId: string): QrControl => new GatewayChannelAdapter(channelId);

/** Adds a QR (linked-device) channel. It starts with automation and AI off. */
export async function addQrChannel(db: Db, ctx: TenantContext, name: string): Promise<string> {
  requireRole(ctx, 'admin');
  const clean = z.string().trim().min(1).max(80).parse(name);
  return inTenant(db, ctx, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO channels (tenant_id, name, provider) VALUES ($1, $2, 'qr') RETURNING id`,
      [ctx.tenantId, clean],
    );
    await audit(tx, ctx, 'channel.create', 'channel', rows[0]!.id, null, { name: clean, provider: 'qr' });
    return rows[0]!.id;
  });
}

async function requireQrChannel(db: Db, ctx: TenantContext, channelId: string) {
  if (!z.string().uuid().safeParse(channelId).success) throw new Error('channel not found');
  const ch = await inTenant(db, ctx, async (tx) => (await tx.query('SELECT id, provider FROM channels WHERE id = $1', [channelId])).rows[0]);
  if (!ch || ch.provider !== 'qr') throw new Error('channel not found');
}

/** Saves what the gateway reports, so the dashboard shows it without asking the gateway. */
async function record(db: Db, ctx: TenantContext, channelId: string, s: ChannelStatus) {
  await inTenant(db, ctx, (tx) =>
    tx.query(
      `UPDATE channels SET status = $2, status_reason = $3,
              display_number = CASE WHEN $2 = 'connected' THEN coalesce($4, display_number) ELSE display_number END,
              last_connected_at = CASE WHEN $2 = 'connected' THEN now() ELSE last_connected_at END
        WHERE id = $1`,
      [channelId, s.state, s.reason ?? null, s.displayNumber ?? null],
    ),
  );
}

/** Live status of a QR channel. The pairing code is only returned to admins. */
export async function qrChannelStatus(db: Db, ctx: TenantContext, channelId: string, control = defaultControl): Promise<ChannelStatus> {
  requireRole(ctx, 'admin');
  await requireQrChannel(db, ctx, channelId);
  const s = await control(channelId).getStatus();
  if (s.state !== 'error' || !/gateway/.test(s.reason ?? '')) await record(db, ctx, channelId, s);
  return s;
}

export async function connectQrChannel(db: Db, ctx: TenantContext, channelId: string, control = defaultControl): Promise<ChannelStatus> {
  requireRole(ctx, 'admin');
  await requireQrChannel(db, ctx, channelId);
  const s = await control(channelId).connect();
  await record(db, ctx, channelId, s);
  await inTenant(db, ctx, (tx) => audit(tx, ctx, 'channel.connect', 'channel', channelId, null, { state: s.state }));
  return s;
}

export async function logoutQrChannel(db: Db, ctx: TenantContext, channelId: string, control = defaultControl): Promise<void> {
  requireRole(ctx, 'admin');
  await requireQrChannel(db, ctx, channelId);
  await control(channelId).disconnect();
  await record(db, ctx, channelId, { state: 'disconnected' });
  await inTenant(db, ctx, (tx) => audit(tx, ctx, 'channel.logout', 'channel', channelId, null, null));
}
