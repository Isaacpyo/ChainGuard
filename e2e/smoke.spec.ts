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
  const rows = feed.locator('li[data-severity]');
  await expect(rows.first()).toBeVisible();

  // The seed already has critical alerts and a guardian pause, so count them now
  // to prove the simulation's own alerts arrive over SSE later.
  const criticalRows = feed.locator('li[data-severity="critical"]');
  const pausedRows = rows.filter({ hasText: 'Guardian paused vault' });
  const criticalBefore = await criticalRows.count();
  const pausedBefore = await pausedRows.count();

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

  // New alerts streamed in over SSE, including the guardian's response.
  await expect.poll(() => criticalRows.count()).toBeGreaterThan(criticalBefore);
  await expect.poll(() => pausedRows.count()).toBeGreaterThan(pausedBefore);

  // Triage: acknowledge the newest critical alert.
  const critical = criticalRows.first();
  await critical.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(critical.getByText('acknowledged')).toBeVisible();
});
