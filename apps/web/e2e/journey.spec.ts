// E2E-01 (local stack): sign up -> create org -> connect a signed webhook source -> verified test event ->
// real enquiry in the inbox -> log a call -> contacted. Runs at 360 px and 1280 px.
import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:3001';

async function sendSigned(endpoint: string, secret: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v1=' + createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
  const url = endpoint.replace(/^https?:\/\/[^/]+/, API);
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-leadguard-timestamp': ts, 'x-leadguard-signature': sig }, body: raw });
}

test('enquiry to action journey', async ({ page }, info) => {
  const uid = `e2e_${info.project.name}_${Date.now()}`;
  await page.goto('/sign-in');
  await page.getByLabel('User ID').fill(uid);
  await page.getByLabel('Email').fill(`${uid}@example.com`);
  await page.getByLabel('Name', { exact: true }).fill('Pat Owner');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Create your organization' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByLabel('Business name').fill(`E2E Plumbing ${info.project.name}`);
  await page.getByLabel('Time zone').selectOption('America/Chicago');
  // Open every day so the test never depends on the clock.
  for (const d of ['Sat', 'Sun']) {
    const row = page.locator('.hours-row', { hasText: d });
    await row.getByRole('checkbox').check();
  }
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page.getByRole('heading', { name: 'Connect a source' })).toBeVisible();
  await page.getByRole('button', { name: 'Create source' }).click();
  await expect(page.getByRole('heading', { name: 'Copy your connection details' })).toBeVisible();
  const codes = page.locator('.copy code');
  const endpoint = (await codes.nth(0).textContent())!;
  const secret = (await codes.nth(1).textContent())!;
  await page.getByRole('button', { name: /I have saved it/ }).click();

  // Never Connected before a verified event (SRC-03).
  await expect(page.getByText('Status: Waiting for test event')).toBeVisible();
  const test1 = await sendSigned(endpoint, secret, { entry_id: `t_${uid}`, full_name: 'Test Lead', email: 'test@example.com' });
  expect(test1.status).toBe(201);
  await expect(page.getByText('Connected.', { exact: false })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Go to my inbox' }).click();
  await page.waitForURL('**/inbox');

  const real = await sendSigned(endpoint, secret, { entry_id: `r_${uid}`, full_name: 'Dana Morales', phone: '(512) 555-0142', comments: 'Water heater leaking' });
  expect(real.status).toBe(201);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Needs action' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dana Morales' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('inbox.png'), fullPage: true });

  await page.getByRole('link', { name: 'Dana Morales' }).click();
  await expect(page.getByRole('link', { name: 'Call Dana' })).toBeVisible();
  await page.getByRole('button', { name: 'Log activity' }).click();
  await page.getByLabel('Outcome').selectOption('reached');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Contacted').first()).toBeVisible();
  await expect(page.getByText(/logged a call: reached \(self-reported\)/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('lead.png'), fullPage: true });

  // Manager screens render without errors.
  for (const [path, heading] of [['/dashboard', 'Dashboard'], ['/sources', 'Sources'], ['/team', 'Team'], ['/rules', 'Follow-up rules'], ['/settings/billing', 'Subscription'], ['/settings/organization', 'Organization']] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expect(page.locator('.banner-bad')).toHaveCount(0);
    // 360 px to desktop without horizontal page scroll (Section 29.1).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} overflows horizontally`).toBeLessThanOrEqual(1);
  }
  await page.goto('/dashboard');
  await page.screenshot({ path: info.outputPath('dashboard.png'), fullPage: true });
});
