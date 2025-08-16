// Simple step helper for Vitest/Jest style tests
// Usage: await step('Given ...', async () => { ... })
export async function step(title, fn) {
  // eslint-disable-next-line no-console
  console.log(`STEP: ${title}`);
  return await fn();
}
