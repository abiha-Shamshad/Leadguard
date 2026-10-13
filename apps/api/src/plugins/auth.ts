// Authentication and membership resolution (Sections 7, 16 step 1, API-050..052 support middleware).
// 1) Verify the Clerk session token. 2) Upsert the LeadGuard user (cached 60 s). 3) Resolve the active
// membership on every request from LeadGuard's own table (no cached role is trusted for writes).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clerkPlugin, getAuth, clerkClient, verifyToken, createClerkClient } from '@clerk/fastify';
import { withoutOrg, withOrg, audit } from '@leadguard/db';
import { AppError } from '@leadguard/contracts';
import { permissionsFor, uuidv7, UUID_RE, type Permission, type Role } from '@leadguard/domain';
import type { Deps } from '../deps.ts';

export interface Membership {
  org_id: string;
  role: Role;
  status: 'active' | 'deactivated';
}

export interface Actor {
  userId: string;
  email: string;
  name: string | null;
  /** Active organization for this request (null when the user has none, e.g. before setup). */
  orgId: string | null;
  role: Role | null;
  memberships: Membership[];
  permissions: Permission[];
  support: null | { grantId: string; scope: 'read_only' | 'read_write' };
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    requestId: string;
  }
}

interface Identity { clerkUserId: string; email: string; name: string | null }

const userCache = new Map<string, { userId: string; email: string; name: string | null; at: number }>();
const identityCache = new Map<string, { identity: Identity; at: number }>();
const CACHE_MS = 60_000;

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

const unauthenticated = () => new AppError('AUTHENTICATION_REQUIRED', 'Your session has expired. Sign in again.');

/**
 * Development identity (AUTH_MODE=dev, refused in production): `Authorization: Bearer dev:<clerk_user_id>:<email>[:<name>]`.
 * Lets the API run end to end before the Clerk development instance exists (INT-001 sandbox test is TASK-003).
 */
function devIdentity(token: string, prefix: 'dev' | 'devsupport'): Identity | null {
  const parts = token.split(':');
  if (parts[0] !== prefix || parts.length < 3) return null;
  const [, id, email] = parts;
  const name = parts.slice(3).join(':').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (!/^[^\s@:]{1,64}@[^\s@:]{1,190}\.[A-Za-z]{2,24}$/.test(email)) return null;
  if (name.length > 120 || /[\u0000-\u001F\u007F]/.test(name)) return null;
  return { clerkUserId: id, email: email.toLowerCase(), name: name || null };
}

async function clerkIdentity(req: FastifyRequest): Promise<Identity | null> {
  const { userId } = getAuth(req);
  if (!userId) return null;
  const cached = identityCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.identity;
  const u = await clerkClient.users.getUser(userId);
  const primary = u.emailAddresses.find(e => e.id === u.primaryEmailAddressId) ?? u.emailAddresses[0];
  if (!primary || primary.verification?.status !== 'verified') return null;
  const identity = { clerkUserId: userId, email: primary.emailAddress.toLowerCase(), name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null };
  identityCache.set(userId, { identity, at: Date.now() });
  return identity;
}

async function supportIdentity(deps: Deps, token: string): Promise<Identity | null> {
  if (deps.config.authMode === 'dev') return devIdentity(token, 'devsupport');
  const sk = deps.config.supportClerk.secretKey;
  if (!sk) return null;
  try {
    const payload = await verifyToken(token, { secretKey: sk });
    const sub = String(payload.sub);
    const client = createClerkClient({ secretKey: sk, publishableKey: deps.config.supportClerk.publishableKey });
    const u = await client.users.getUser(sub);
    const primary = u.emailAddresses.find(e => e.id === u.primaryEmailAddressId) ?? u.emailAddresses[0];
    if (!primary) return null;
    return { clerkUserId: `support:${sub}`, email: primary.emailAddress.toLowerCase(), name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null };
  } catch {
    return null;
  }
}

async function upsertUser(deps: Deps, id: Identity, support: boolean): Promise<string | null> {
  const key = `${support ? 's' : 'c'}:${id.clerkUserId}`;
  const c = userCache.get(key);
  if (c && Date.now() - c.at < CACHE_MS && c.email === id.email && c.name === id.name) return c.userId;
  const fn = support ? 'lg.upsert_support_user' : 'lg.upsert_user';
  const userId = await withoutOrg(deps.pool, async db =>
    (await db.one<{ id: string | null }>(`SELECT ${fn}($1,$2,$3,$4) AS id`, [uuidv7(), id.clerkUserId, id.email, id.name])).id);
  if (userId) userCache.set(key, { userId, email: id.email, name: id.name, at: Date.now() });
  return userId;
}

async function memberships(deps: Deps, userId: string): Promise<Membership[]> {
  return withoutOrg(deps.pool, db => db.q<Membership>('SELECT org_id, role, status FROM lg.user_memberships($1)', [userId]));
}

/** Routes that do not need an active organization. */
const ORG_OPTIONAL = new Set(['/api/v1/me', '/api/v1/organizations', '/api/v1/invitations/accept']);

export async function registerAuth(app: FastifyInstance, deps: Deps): Promise<void> {
  if (deps.config.authMode === 'clerk') {
    await app.register(clerkPlugin, {
      secretKey: deps.config.clerk.secretKey,
      publishableKey: deps.config.clerk.publishableKey,
      jwtKey: deps.config.clerk.jwtKey,
      hookName: 'preHandler',
    } as any);
  }

  app.addHook('preHandler', async req => {
    if (!req.url.startsWith('/api/v1/')) return;
    // An IP that keeps failing authentication is blocked for the rest of the minute.
    const budget = await deps.limiter.hit(`unauth:${req.ip}`, deps.config.rateLimits.ipUnauthPerMinute, 60, { peek: true });
    if (!budget.allowed) throw new AppError('RATE_LIMITED', 'Too many failed sign-in attempts. Try again shortly.', {}, { headers: { 'Retry-After': String(budget.retryAfter) } });
    const token = bearer(req);
    if (!token) throw unauthenticated();

    const grantHeader = req.headers['x-support-grant-id'];
    if (typeof grantHeader === 'string' && grantHeader) {
      req.actor = await resolveSupportActor(deps, req, token, grantHeader);
      return;
    }

    const identity = deps.config.authMode === 'dev' ? devIdentity(token, 'dev') : await clerkIdentity(req);
    if (!identity) throw unauthenticated();
    const userId = await upsertUser(deps, identity, false);
    if (!userId) throw unauthenticated();
    const all = await memberships(deps, userId);
    const active = all.filter(m => m.status === 'active');

    const header = req.headers['x-org-id'];
    let chosen: Membership | null = null;
    if (typeof header === 'string' && header) {
      if (!UUID_RE.test(header)) throw new AppError('VALIDATION_FAILED', 'X-Org-Id must be an organization ID.', { fields: { 'X-Org-Id': 'Invalid ID.' } });
      chosen = active.find(m => m.org_id === header) ?? null;
      if (!chosen) throw new AppError('NOT_FOUND', 'Organization not found.');
    } else if (active.length === 1) {
      chosen = active[0];
    } else if (active.length > 1) {
      const path = req.routeOptions.url ?? '';
      if (!ORG_OPTIONAL.has(path)) {
        throw new AppError('VALIDATION_FAILED', 'Choose an organization.', { fields: { 'X-Org-Id': 'Required when you belong to more than one organization.' } });
      }
      chosen = active[0];
    }
    req.actor = {
      userId,
      email: identity.email,
      name: identity.name,
      orgId: chosen?.org_id ?? null,
      role: chosen?.role ?? null,
      memberships: all,
      permissions: chosen ? permissionsFor(chosen.role) : [],
      support: null,
    };
  });
}

/** Support staff act only through an active, owner-approved grant; every request is audited with the grant ID. */
async function resolveSupportActor(deps: Deps, req: FastifyRequest, token: string, grantId: string): Promise<Actor> {
  if (!UUID_RE.test(grantId)) throw new AppError('AUTHORIZATION_DENIED', 'Support access is not active.');
  const identity = await supportIdentity(deps, token);
  if (!identity) throw unauthenticated();
  const userId = await upsertUser(deps, identity, true);
  if (!userId) throw new AppError('AUTHORIZATION_DENIED', 'Support access is not active.');
  const grant = await withoutOrg(deps.pool, db =>
    db.maybe<{ org_id: string; scope: 'read_only' | 'read_write'; expires_at: Date }>('SELECT org_id, scope, expires_at FROM lg.active_support_grant($1)', [grantId]));
  if (!grant) {
    // Denied attempts are audited against the grant's organization when the grant exists (SEC-07).
    const org = await withoutOrg(deps.pool, db => db.maybe<{ org_id: string }>('SELECT org_id FROM lg.support_grant_org($1)', [grantId]));
    if (org) {
      await withOrg(deps.pool, org.org_id, userId, db => audit(db, {
        orgId: org.org_id, actorType: 'support', actorId: userId, action: 'support.access_denied', recordType: 'support_grant', recordId: grantId, supportGrantId: grantId, requestId: req.requestId,
      }));
    }
    req.log.warn({ request_id: req.requestId, grant_id: grantId }, 'support access denied');
    throw new AppError('AUTHORIZATION_DENIED', 'Support access is not active.');
  }
  const role: Role = grant.scope === 'read_write' ? 'manager' : 'member';
  // Support never manages billing, exports, members or support grants, even under read_write.
  const perms: Permission[] = grant.scope === 'read_write'
    ? ['sources.manage', 'leads.read', 'leads.write', 'leads.assign', 'rules.manage', 'dashboard.read']
    : ['leads.read', 'dashboard.read'];
  return {
    userId, email: identity.email, name: identity.name, orgId: grant.org_id, role, memberships: [],
    permissions: perms, support: { grantId, scope: grant.scope },
  };
}
