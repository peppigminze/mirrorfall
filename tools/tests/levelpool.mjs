// MIRRORFALL — all level definitions available to the tests.

import { KITCHEN_SINK } from './fixtures.js';

export async function levelPool({ withDaily = 0 } = {}) {
  const pool = [KITCHEN_SINK];
  try {
    const { CAMPAIGN } = await import('../../levels/campaign.js');
    pool.push(...CAMPAIGN);
  } catch { /* campaign not available yet */ }
  if (withDaily > 0) {
    try {
      const { generateRoom } = await import('../../levels/daily.js');
      for (let i = 0; i < withDaily; i++) pool.push(generateRoom(0xC0FFEE + i * 7919).def);
    } catch { /* generator not available yet */ }
  }
  return pool;
}
