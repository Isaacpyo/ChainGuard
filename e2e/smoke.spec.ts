import { expect, test } from '@playwright/test';

test('demo login → live feed → simulated drain is stopped → triage', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the demo' }).click();

  await expect(page).toHaveURL(/\/dashboard\/$/);
  await expect(page.getByRole('heading', { name: 'Sandbox Treasury' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Active' })).toBeVisible();

  // Seeded history is there before anything runs.
  const feed = page.getByTestId('alert-feed');
  await expect(feed.locator('li[data-severity]').first()).toBeVisible();

  await page.getByRole('button', { name: 'Simulate attack' }).click();
  await expect(page.getByRole('button', { name: 'Simulation running…' })).toBeDisabled();
  await expect(page.getByRole('list', { name: 'Simulation progress' })).toBeVisible();

  // The watcher front-runs the burst: nothing is lost and the vault ends up paused.
  const result = page.getByTestId('simulation-result');
  await expect(result.getByText(/Last run · just now/i)).toBeVisible({ timeout: 60_000 });
  await expect(result.getByText('0 ETH lost')).toBeVisible();
  await expect(result.getByText(/paused \d+ ms after the attack hit the mempool/)).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Paused — withdrawals blocked' }),
  ).toBeVisible();

  // Live alerts streamed in over SSE, including the guardian's response.
  await expect(feed.getByText('Guardian paused vault').first()).toBeVisible();
  await expect(feed.locator('li[data-severity="critical"]').first()).toBeVisible();

  // Triage: acknowledge the newest critical alert.
  const critical = feed.locator('li[data-severity="critical"]').first();
  await critical.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(critical.getByText('acknowledged')).toBeVisible();
});
