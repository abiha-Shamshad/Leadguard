// API-007..011 Team and invitations.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError, findPlan, acceptInvitationBody, changeRoleBody, deactivateBody, inviteBody, isoSeconds, listMembersQuery, uuid,
} from '@leadguard/contracts';
import { uuidv7 } from '@leadguard/domain';
import { emit, getSubscription, loadOrgSettings, replanForOwner, withoutOrg, type Db } from '@leadguard/db';
import type { Deps } from '../deps.ts';
import { defineRoute } from '../lib/route.ts';
import { newInvitationToken, sha256 } from '../lib/crypto.ts';
import { planLimitError, usage } from '../lib/usage.ts';

const INVITE_DAYS = 7;

async function ownerCount(db: Db): Promise<number> {
  return (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM lg.memberships WHERE role = 'owner' AND status = 'active'`)).n;
}

export function registerTeam(app: FastifyInstance, deps: Deps): void {
  // API-007 List members (open-lead counts via one grouped subquery; no per-member queries).
  defineRoute(app, deps, {
    op: 'API-007',
    query: listMembersQuery,
    permission: ['members.manage', 'leads.assign'],
    permissionMessage: 'You do not have permission to view the team.',
    handler: async ctx => {
      const q = ctx.query;
      // Members (role member) only have self-claim; the team list is for owners and managers.
      if (ctx.actor.role === 'member' && !ctx.actor.support) throw new AppError('AUTHORIZATION_DENIED', 'You do not have permission to view the team.');
      const offset = Number((ctx.deps.cursors.decode(ctx.orgId, 'API-007', q.cursor) ?? [0])[0]);
      const rows = await ctx.db.q<any>(
        `SELECT * FROM (
           SELECT 0 AS kind, m.user_id, NULL::uuid AS invitation_id, u.name, u.email, m.role, m.status, m.version,
                  coalesce(c.n, 0)::int AS open_leads, NULL::timestamptz AS expires_at, m.created_at
             FROM lg.memberships m JOIN lg.users u ON u.id = m.user_id
             LEFT JOIN (SELECT owner_id, count(*) AS n FROM lg.leads WHERE status IN ('new','attempted') GROUP BY owner_id) c ON c.owner_id = m.user_id
           UNION ALL
           SELECT 1, NULL, i.id, NULL, i.email_norm, i.role, 'invited', 1, NULL, i.expires_at, i.created_at
             FROM lg.invitations i WHERE i.status = 'pending' AND i.expires_at > now()
         ) t
         WHERE ($1::text IS NULL OR t.status = $1)
         ORDER BY kind, CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, created_at, coalesce(user_id, invitation_id)
         OFFSET $2 LIMIT $3`,
        [q.status ?? null, offset, q.limit + 1]);
      const more = rows.length > q.limit;
      const items = rows.slice(0, q.limit).map(r => r.kind === 0
        ? { user_id: r.user_id, name: r.name, email: r.email, role: r.role, status: r.status, open_leads: r.open_leads, version: r.version }
        : { invitation_id: r.invitation_id, email: r.email, role: r.role, status: 'invited', expires_at: isoSeconds(r.expires_at) });
      return { data: { items, next_cursor: more ? ctx.deps.cursors.encode(ctx.orgId, 'API-007', [offset + q.limit]) : null } };
    },
  });

  // API-008 Invite member. Token: 32 random bytes, stored as SHA-256, single use, 7 days.
  defineRoute(app, deps, {
    op: 'API-008',
    body: inviteBody,
    permission: 'members.manage',
    permissionMessage: 'Only owners and managers can invite team members.',
    // The invitation link is shown once, like a source secret (R-IDEM-3).
    redactForReplay: r => ({ ...r, data: { ...(r.data as any), invite_url: null, invite_url_available: false } }),
    handler: async ctx => {
      const b = ctx.body;
      if (b.role === 'owner' && ctx.actor.role !== 'owner') throw new AppError('AUTHORIZATION_DENIED', 'Managers cannot invite owners.');
      const email = b.email.toLowerCase();
      const existing = await ctx.db.maybe(
        `SELECT 1 FROM lg.memberships m JOIN lg.users u ON u.id = m.user_id WHERE u.email = $1 AND m.status = 'active'`, [email]);
      if (existing) throw new AppError('ALREADY_INVITED', 'This person is already a member.');
      // An expired pending invitation no longer blocks a new one.
      await ctx.db.q(`UPDATE lg.invitations SET status = 'expired' WHERE email_norm = $1 AND status = 'pending' AND expires_at <= now()`, [email]);
      const pending = await ctx.db.maybe(`SELECT 1 FROM lg.invitations WHERE email_norm = $1 AND status = 'pending'`, [email]);
      if (pending) throw new AppError('ALREADY_INVITED', 'An invitation is already pending for this email.');
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const sub = await getSubscription(ctx.db, ctx.orgId);
      const u = await usage(ctx.db, s.timeZone, ctx.now);
      const max = findPlan(deps.config.plans, sub.plan_id).limits.members;
      if (u.membersAndInvites >= max) throw planLimitError('members', u.membersAndInvites, max);

      const id = uuidv7();
      const token = newInvitationToken();
      const expiresAt = new Date(ctx.now.getTime() + INVITE_DAYS * 86_400_000);
      await ctx.db.q(
        `INSERT INTO lg.invitations (id, org_id, email_norm, role, token_hash, expires_at, invited_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, ctx.orgId, email, b.role, sha256(token), expiresAt, ctx.userId]);
      await ctx.audit('member.invited', 'invitation', id);
      await emit(ctx.db, ctx.orgId, 'member.invited', { invitation_id: id });
      // Email provider is BLOCKED (INT-003): until it exists the owner copies the link (TASK-005).
      const emailConfigured = deps.email.configured;
      return {
        status: 201,
        message: emailConfigured ? 'Invitation sent.' : 'Invitation created. Copy the link and send it to your teammate.',
        data: {
          invitation_id: id, email, role: b.role, status: 'pending', expires_at: isoSeconds(expiresAt),
          email_delivery: emailConfigured ? 'queued' : 'not_configured',
          invite_url: `${deps.config.appUrl.replace(/\/$/, '')}/invite#${token}`,
        },
      };
    },
  });

  // API-009 Accept invitation (no org context exists yet for the invitee: resolve_invitation lookup).
  defineRoute(app, deps, {
    op: 'API-009',
    orgOptional: true,
    body: acceptInvitationBody,
    handler: async ctx => {
      const hash = sha256(ctx.body.token);
      const inv = await withoutOrg(deps.pool, db => db.maybe<{ invitation_id: string; org_id: string; email_norm: string; role: string; status: string; expires_at: Date }>(
        'SELECT invitation_id, org_id, email_norm, role, status, expires_at FROM lg.resolve_invitation($1)', [hash]));
      const expired = () => new AppError('INVITATION_EXPIRED', 'This invitation has expired. Ask your manager to send a new one.');
      if (!inv) throw expired();
      if (inv.email_norm !== ctx.actor.email.toLowerCase()) throw new AppError('AUTHORIZATION_DENIED', 'This invitation was sent to a different email address.');
      await ctx.switchOrg(inv.org_id);
      const org = await ctx.db.one<{ id: string; name: string }>('SELECT id, name FROM lg.organizations WHERE id = $1', [inv.org_id]);
      const member = await ctx.db.maybe<{ role: string; status: string }>('SELECT role, status FROM lg.memberships WHERE org_id = $1 AND user_id = $2', [inv.org_id, ctx.userId]);
      if (inv.status === 'accepted') {
        if (member?.status === 'active') return { message: `You joined ${org.name}.`, data: { org: { id: org.id, name: org.name }, membership: { role: member.role, status: 'active' } } };
        throw expired();
      }
      if (inv.status !== 'pending') throw expired();
      if (inv.expires_at <= ctx.now) throw expired();
      const claimed = await ctx.db.exec(`UPDATE lg.invitations SET status = 'accepted' WHERE id = $1 AND status = 'pending'`, [inv.invitation_id]);
      if (!claimed) throw expired();
      if (member) {
        await ctx.db.q(`UPDATE lg.memberships SET role = $3, status = 'active', version = version + 1 WHERE org_id = $1 AND user_id = $2`, [inv.org_id, ctx.userId, inv.role]);
      } else {
        await ctx.db.q('INSERT INTO lg.memberships (org_id, user_id, role) VALUES ($1,$2,$3)', [inv.org_id, ctx.userId, inv.role]);
      }
      await ctx.audit('member.joined', 'membership', ctx.userId);
      await emit(ctx.db, inv.org_id, 'member.joined', { user_id: ctx.userId });
      return { message: `You joined ${org.name}.`, data: { org: { id: org.id, name: org.name }, membership: { role: inv.role, status: 'active' } } };
    },
  });

  const memberParams = z.object({ memberId: uuid });

  // API-010 Change member role (only owners can grant or remove owner; last owner protected).
  defineRoute(app, deps, {
    op: 'API-010',
    params: memberParams,
    body: changeRoleBody,
    permission: 'members.manage',
    permissionMessage: 'Only owners and managers can change roles.',
    handler: async ctx => {
      const m = await ctx.db.maybe<{ role: string; status: string; version: number }>(
        'SELECT role, status, version FROM lg.memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE', [ctx.orgId, ctx.params.memberId]);
      if (!m || m.status !== 'active') throw new AppError('NOT_FOUND', 'Member not found.');
      if ((m.role === 'owner' || ctx.body.role === 'owner') && ctx.actor.role !== 'owner') throw new AppError('AUTHORIZATION_DENIED', 'Only owners can grant or remove the owner role.');
      if (m.version !== ctx.body.expected_version) throw new AppError('VERSION_CONFLICT', 'This member was changed by someone else. Reload and try again.', { current_version: m.version });
      if (m.role === 'owner' && ctx.body.role !== 'owner' && (await ownerCount(ctx.db)) <= 1) throw new AppError('LAST_OWNER', 'An organization must keep at least one owner.');
      const r = await ctx.db.one<{ version: number }>(
        'UPDATE lg.memberships SET role = $3, version = version + 1 WHERE org_id = $1 AND user_id = $2 RETURNING version', [ctx.orgId, ctx.params.memberId, ctx.body.role]);
      await ctx.audit('member.role_changed', 'membership', ctx.params.memberId, ['role']);
      await emit(ctx.db, ctx.orgId, 'member.role_changed', { user_id: ctx.params.memberId, role: ctx.body.role });
      return { message: 'Role updated.', data: { user_id: ctx.params.memberId, role: ctx.body.role, version: r.version } };
    },
  });

  // API-011 Deactivate member: access ends on the next request; open leads reassigned in the same transaction.
  defineRoute(app, deps, {
    op: 'API-011',
    params: memberParams,
    body: deactivateBody,
    permission: 'members.manage',
    permissionMessage: 'Only owners and managers can deactivate members.',
    handler: async ctx => {
      const id = ctx.params.memberId;
      const m = await ctx.db.maybe<{ role: string; status: string }>('SELECT role, status FROM lg.memberships WHERE org_id = $1 AND user_id = $2 FOR UPDATE', [ctx.orgId, id]);
      if (!m) throw new AppError('NOT_FOUND', 'Member not found.');
      if (m.role === 'owner' && ctx.actor.role !== 'owner') throw new AppError('AUTHORIZATION_DENIED', 'Only owners can deactivate an owner.');
      if (m.status === 'deactivated') {
        return { message: 'Member deactivated.', data: { user_id: id, status: 'deactivated', leads_reassigned: 0, access_removed: true } };
      }
      if (m.role === 'owner' && (await ownerCount(ctx.db)) <= 1) throw new AppError('LAST_OWNER', 'You cannot deactivate the last owner.');
      const target = ctx.body.reassign_to ?? null;
      if (target) {
        if (target === id) throw new AppError('VALIDATION_FAILED', 'Choose someone else to take over the leads.', { fields: { reassign_to: 'Must be a different active member.' } });
        const t = await ctx.db.maybe<{ status: string }>('SELECT status FROM lg.memberships WHERE org_id = $1 AND user_id = $2', [ctx.orgId, target]);
        if (!t) throw new AppError('NOT_FOUND', 'Member not found.');
        if (t.status !== 'active') throw new AppError('OWNER_INACTIVE', 'The person taking over the leads is not active.');
      }
      await ctx.db.q(`UPDATE lg.memberships SET status = 'deactivated', version = version + 1 WHERE org_id = $1 AND user_id = $2`, [ctx.orgId, id]);
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const leads = await ctx.db.q<{ id: string; status: string }>(
        `SELECT id, status FROM lg.leads WHERE owner_id = $1 AND status IN ('new','attempted','contacted','qualified') ORDER BY id FOR UPDATE`, [id]);
      const targetName = target ? (await ctx.db.maybe<{ name: string | null; email: string }>('SELECT name, email FROM lg.users WHERE id = $1', [target])) : null;
      for (const l of leads) {
        await ctx.db.q('UPDATE lg.leads SET owner_id = $2, version = version + 1, updated_at = now() WHERE id = $1', [l.id, target]);
        await ctx.db.q(`INSERT INTO lg.lead_activities (id, org_id, lead_id, type, note, actor_id, occurred_at, evidence) VALUES ($1,$2,$3,'assigned',$4,$5,now(),'system')`,
          [uuidv7(), ctx.orgId, l.id, target ? `Reassigned to ${targetName?.name ?? targetName?.email} - previous owner deactivated` : 'Moved to the unassigned queue - previous owner deactivated', ctx.userId]);
        await replanForOwner(ctx.db, s, l, target, ctx.now, 'owner deactivated');
        await emit(ctx.db, ctx.orgId, 'lead.assigned', { lead_id: l.id, owner_id: target, previous_owner_id: id });
      }
      // Pending deliveries addressed to the deactivated member are no longer useful.
      await ctx.db.q(`UPDATE lg.alert_deliveries SET state = 'cancelled', updated_at = now() WHERE recipient_id = $1 AND state = 'pending'`, [id]);
      await ctx.audit('member.deactivated', 'membership', id, ['status']);
      await emit(ctx.db, ctx.orgId, 'member.deactivated', { user_id: id });
      return { message: 'Member deactivated.', data: { user_id: id, status: 'deactivated', leads_reassigned: leads.length, access_removed: true } };
    },
  });
}
