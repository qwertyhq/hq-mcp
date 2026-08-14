import { describe, expect, it } from 'vitest';
import { matchForbidden } from '@hq/registry';
import { renameSafeRemnaKeys } from '@hq/remna';
import { makeCtx } from '../testkit.js';
import { subpageRead } from './read.js';

interface Answer {
  configs: {
    declared_total: number | null;
    listed: number;
    returned: number;
    bodiesRead: number;
    items: {
      uuid: string | null;
      name: string | null;
      bodyRead: boolean;
      summary: {
        baseSettings: Record<string, unknown>;
        svgLibraryNames: string[];
        platforms: {
          platform: string;
          apps: { name: string | null; blocks: { title: string | null; buttons: { link: string | null }[] }[] }[];
        }[];
      } | null;
    }[];
  };
  snippets: { declared_total: number | null; returned: number } | null;
  scrubbed: { removed: number };
  warnings: { code: string; message: string }[];
}

type Handler = typeof subpageRead.handler;
type Input = Parameters<Handler>[0];

async function run(input: unknown, ctx: Parameters<Handler>[1]): Promise<Answer> {
  return (await subpageRead.handler(subpageRead.input.parse(input) as Input, ctx)) as Answer;
}

const LIST = {
  total: 1,
  configs: [{ uuid: '00000000-0000-0000-0000-000000000000', viewPosition: 1, name: 'My-Sub', config: null }],
};

const CARD = {
  uuid: '00000000-0000-0000-0000-000000000000',
  viewPosition: 1,
  name: 'My-Sub',
  config: {
    version: '1',
    locales: ['en', 'ru'],
    uiConfig: { subscriptionInfoBlockType: 'collapsed' },
    baseSettings: { metaTitle: 'HQ', hideGetLinkButton: false, showConnectionKeys: false },
    brandingSettings: { title: 'HQ', logoUrl: 'https://example.test/logo.png' },
    baseTranslations: { name: { en: 'Name', ru: 'Имя' }, status: { en: 'Status', ru: 'Статус' } },
    svgLibrary: { Happ: '<svg>...very long markup...</svg>', TV: '<svg>...</svg>' },
    platforms: {
      ios: {
        apps: [
          {
            name: 'Incy',
            blocks: [
              {
                title: { en: 'App Installation', ru: 'Установка' },
                buttons: [{ link: 'https://apps.apple.test/incy', text: { en: 'App Store' }, type: 'external' }],
              },
            ],
          },
        ],
      },
    },
  },
};

/**
 * Стаб проходит через `renameSafeRemnaKeys` ровно потому, что через него
 * проходит настоящий клиент @hq/remna, — и делает он это ДО редакции. Без
 * этого шага тест видел бы имена, которых хендлер в работе никогда не получает.
 */
function ctxWith(overrides: { list?: unknown; card?: unknown; snippets?: unknown } = {}) {
  return makeCtx({
    remnaGet: (path) => {
      if (path === '/api/subscription-page-configs') return renameSafeRemnaKeys(overrides.list ?? LIST);
      if (path.startsWith('/api/subscription-page-configs/')) {
        return renameSafeRemnaKeys(overrides.card ?? CARD);
      }
      if (path === '/api/snippets') return overrides.snippets ?? { total: 0, snippets: [] };
      throw new Error(`unexpected path ${path}`);
    },
  });
}

describe('subpage_read', () => {
  /**
   * Правило `/api/sub` было ПРЕФИКСНЫМ и запирало два соседних контроллера,
   * чьи имена лишь начинаются с тех же букв. Тест стоит здесь, а не только в
   * реестре: инструмент физически не мог существовать, пока правило не сужено,
   * и возвращение прежней формы обязано ронять именно того, кто от неё зависит.
   */
  it('is reachable at all: the subscription-serving prefix no longer swallows this controller', () => {
    expect(matchForbidden('/api/sub/abc123', 'GET')).toBeDefined();
    expect(matchForbidden('/api/sub', 'GET')).toBeDefined();
    expect(matchForbidden('/api/subscription-page-configs', 'GET')).toBeUndefined();
    expect(matchForbidden('/api/subscription-request-history', 'GET')).toBeUndefined();
    expect(matchForbidden('/api/snippets', 'GET')).toBeUndefined();
  });

  it('reads the body from the per-uuid card, because the listing never carries one', async () => {
    const result = await run({}, ctxWith());
    expect(result.configs.declared_total).toBe(1);
    expect(result.configs.bodiesRead).toBe(1);
    const summary = result.configs.items[0]?.summary;
    expect(summary?.platforms[0]?.apps[0]?.name).toBe('Incy');
    expect(summary?.platforms[0]?.apps[0]?.blocks[0]?.buttons[0]?.link).toBe(
      'https://apps.apple.test/incy',
    );
    // Локализованный заголовок схлопывается в одну строку, а не удваивает ответ.
    expect(summary?.platforms[0]?.apps[0]?.blocks[0]?.title).toBe('App Installation');
  });

  /**
   * Найдено прогоном по работающей панели: `showConnectionKeys` матчит /key/i
   * и уезжал маркером '<redacted>' вместо булева флага. Значение секретом не является.
   * Чинится в клиенте (REMNA_SAFE_RENAMES) — на выходе хендлера чинить уже
   * нечего, — а здесь проверяется, что инструмент результат не теряет.
   */
  it('keeps the page flag that name-based redaction would otherwise eat', async () => {
    const result = await run({}, ctxWith());
    const settings = result.configs.items[0]?.summary?.baseSettings;
    expect(settings?.showConnectionCreds).toBe(false);
    expect(settings).not.toHaveProperty('showConnectionKeys');
  });

  it('returns svg names and never svg markup', async () => {
    const result = await run({}, ctxWith());
    expect(result.configs.items[0]?.summary?.svgLibraryNames).toEqual(['Happ', 'TV']);
    expect(JSON.stringify(result)).not.toContain('<svg>');
  });

  it('says the listing carries no body by construction, so nobody reads null as unconfigured', async () => {
    const result = await run({}, ctxWith());
    expect(result.warnings.map((one) => one.code)).toContain('subpage_body_absent_from_listing');
  });

  it('separates an installed-but-unused feature from a missing one', async () => {
    const result = await run({}, ctxWith());
    const empty = result.warnings.find((one) => one.code === 'feature_present_but_unused');
    expect(empty?.message).toMatch(/answered normally and holds nothing/);
    // Ноль снипетов — это ноль, а не «неизвестно»: ручка ответила.
    expect(result.snippets?.declared_total).toBe(0);
  });

  it('does not claim a config is missing when the panel never answered', async () => {
    const ctx = makeCtx({
      remnaGet: () => {
        throw new Error('panel down');
      },
    });
    const result = await run({}, ctx);
    expect(result.configs.declared_total).toBeNull();
    expect(result.warnings.map((one) => one.code)).toContain('partial_result');
    expect(result.warnings.map((one) => one.code)).not.toContain('subpage_config_not_found');
  });

  it('refuses a non-uuid rather than letting the panel answer 400', async () => {
    const result = await run({ uuid: 'My-Sub' }, ctxWith());
    expect(result.warnings.map((one) => one.code)).toContain('subpage_uuid_malformed');
  });

  it('counts a secret that reached client-facing text instead of shipping it', async () => {
    const card = {
      ...CARD,
      config: {
        ...CARD.config,
        brandingSettings: {
          title: 'HQ',
          supportUrl: 'https://example.test/?api_token=A1b2C3d4E5f6G7h8J9k0L1m2N3o4P5q6',
        },
      },
    };
    const result = await run({}, ctxWith({ card }));
    expect(result.scrubbed.removed).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('A1b2C3d4E5f6G7h8J9k0L1m2N3o4P5q6');
    expect(result.warnings.map((one) => one.code)).toContain('secrets_scrubbed');
  });
});
