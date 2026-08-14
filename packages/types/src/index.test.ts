import { describe, expect, it } from 'vitest';
import { ACCESS_LEVELS, CAPABILITIES, PROFILES, isAccess, isCapability, isProfile } from './index.js';

describe('@hq/types guards', () => {
  it('recognises the two profiles and nothing else', () => {
    expect(isProfile('human')).toBe(true);
    expect(isProfile('bot')).toBe(true);
    expect(isProfile('admin')).toBe(false);
    expect(isProfile(undefined)).toBe(false);
    expect([...PROFILES]).toEqual(['human', 'bot']);
  });

  it('recognises the two access levels and nothing else', () => {
    expect(isAccess('ro')).toBe(true);
    expect(isAccess('rw')).toBe(true);
    expect(isAccess('RW')).toBe(false);
    expect(isAccess(null)).toBe(false);
    expect([...ACCESS_LEVELS]).toEqual(['ro', 'rw']);
  });

  it('publishes the capability list that gates tools behind the probe', () => {
    expect([...CAPABILITIES]).toEqual([
      'shm.filter',
      'shm.dry_run',
      'remna.subscriptionRequestHistory',
      'remna.realtimeBandwidth',
      'tunnel.mysql',
      'tunnel.postgres',
      'tunnel.abuse',
    ]);
    expect(isCapability('shm.filter')).toBe(true);
    expect(isCapability('shm.whatever')).toBe(false);
    // `remna.searchValue` жил здесь и был снят 2026-08-13. Параметра с таким
    // именем не было ни в 2.8.1, ни в 3.2.3: схема запроса `/api/users` в обеих
    // версиях байт в байт одна и та же и содержит start/size/filters/
    // filterModes/globalFilterMode/sorting. Объект нестрогий, поэтому запрос с
    // ним отвечал 200 всегда, и возможность рапортовалась `true` при полностью
    // неработающем фильтре. Проверка стоит здесь, чтобы имя не вернулось.
    expect(isCapability('remna.searchValue')).toBe(false);
  });
});
