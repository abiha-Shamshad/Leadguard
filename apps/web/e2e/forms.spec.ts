// Form constraints and browser security headers (runs against the local stack).
import { test, expect } from '@playwright/test';

test('security headers are sent with every page', async ({ page }) => {
  const res = await page.goto('/sign-in');
  const h = res!.headers();
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['content-security-policy']).toContain("object-src 'none'");
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-powered-by']).toBeUndefined();
});

test('text boxes enforce limits, formats and strip control characters', async ({ page }, info) => {
  await page.goto('/sign-in');
  // Invalid user ID format blocks submission (browser constraint validation).
  await page.getByLabel('User ID').fill('a b');
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByLabel('Name', { exact: true }).fill('Pat');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  expect(await page.getByLabel('User ID').evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  expect(await page.getByLabel('Email').evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);

  const uid = `forms_${info.project.name}_${Date.now()}`;
  await page.getByLabel('User ID').fill(uid);
  await page.getByLabel('Email').fill(`${uid}@example.com`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Create your organization' })).toBeVisible();

  // maxLength: the business name cannot exceed 120 characters.
  await page.getByLabel('Business name').fill('x'.repeat(200));
  expect((await page.getByLabel('Business name').inputValue()).length).toBe(120);
  // Control characters typed or pasted are removed.
  await page.getByLabel('Business name').fill('Acme\u0007 Plumbing');
  await expect(page.getByLabel('Business name')).toHaveValue('Acme Plumbing');
  // Country code must be two letters.
  await page.getByLabel('Country code').fill('1');
  await page.getByRole('button', { name: 'Create organization' }).click();
  expect(await page.getByLabel('Country code').evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  await expect(page.getByRole('heading', { name: 'Create your organization' })).toBeVisible();

  await page.getByLabel('Country code').fill('US');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Connect a source' })).toBeVisible();

  // Manual lead form: phone format and the email-or-phone rule.
  await page.goto('/leads');
  await page.getByRole('button', { name: 'Add lead' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Phone').fill('call me maybe');
  await dialog.getByRole('button', { name: 'Create lead' }).click();
  expect(await dialog.getByLabel('Phone').evaluate((el: HTMLInputElement) => el.validity.patternMismatch)).toBe(true);
  await dialog.getByLabel('Phone').fill('');
  await dialog.getByRole('button', { name: 'Create lead' }).click();
  expect(await dialog.getByLabel('Email').evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  const msg = dialog.getByLabel('What do they need?');
  await msg.fill('y'.repeat(5000));
  expect((await msg.inputValue()).length).toBe(4000);
  await expect(dialog.getByText('4000/4000 characters')).toBeVisible();
});
