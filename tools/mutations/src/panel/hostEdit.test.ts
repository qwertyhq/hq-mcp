import { describe, expect, it } from 'vitest';
import { REDACTED } from '@hq/redact';
import { hostEdit, mergeHost, previousOf } from './hostEdit.js';
import { callTool, makeWorld, planThenApply } from '../testkit.js';
import type { FakeWorld, RecordedCall } from '../testkit.js';

/**
 * Хост снят с работающей панели 3.2.3 и оставлен со своим
 * `finalMask.udp[0].settings.password` НАРОЧНО: такое поле есть у части
 * хостов, и это ровно то значение, которое `redact` маскирует по имени
 * ключа на любой глубине. Без него тест про маски проверял бы выдуманную
 * опасность.
 */
const HOST = {
  uuid: '8b0b40cd-ed47-47ad-894c-0a16d168ba22',
  viewPosition: 3,
  remark: '🇩🇪 Germany ⚡',
  address: 'de.example.io',
  port: 443,
  path: null,
  sni: 'de.example.io',
  host: null,
  alpn: null,
  fingerprint: 'chrome',
  isDisabled: true,
  isHidden: false,
  overrideSniFromAddress: false,
  keepSniBlank: false,
  shuffleHost: false,
  mihomoX25519: false,
  securityLayer: 'TLS',
  serverDescription: null,
  tags: ['FAST'],
  inbound: {
    configProfileUuid: 'bf9b750e-4c1c-4cd0-8642-92c2d98d8ac2',
    configProfileInboundUuid: '7b24aad8-e7d5-4b90-bb3d-da90393b6afa',
  },
  finalMask: { udp: [{ type: 'hysteria2', settings: { password: 'real-udp-secret' } }] },
  nodes: ['7c39c520-87ed-4c64-aaf0-5246bdbffb36'],
  excludedInternalSquads: [],
  excludeFromSubscriptionTypes: [],
};

const UUID = HOST.uuid;

function world(host: Record<string, unknown> = HOST): FakeWorld {
  return makeWorld({
    // Редактирующий канал возвращает то же самое, но с маской — как настоящий
    // клиент. Если инструмент однажды начнёт читать отсюда, тесты это увидят.
    remnaGet: () => ({
      response: [
        { ...host, finalMask: { udp: [{ type: 'hysteria2', settings: { password: REDACTED } }] } },
      ],
    }),
    remnaGetRaw: () => ({ response: [host] }),
    remnaSend: (_method, _path, body) => ({
      response: { ...host, ...(body as Record<string, unknown>) },
    }),
  });
}

const bodies = (world: FakeWorld): unknown[] =>
  world.calls.filter((call: RecordedCall) => call.body !== undefined).map((call) => call.body);

describe('mergeHost', () => {
  it('переносит ВСЕ булевы снимка, даже те, которых правка не касается', () => {
    expect(mergeHost(HOST, { remark: 'новое' })).toEqual({
      uuid: UUID,
      isDisabled: true,
      isHidden: false,
      overrideSniFromAddress: false,
      keepSniBlank: false,
      shuffleHost: false,
      mihomoX25519: false,
      remark: 'новое',
    });
  });

  it('патч перекрывает булево снимка', () => {
    expect(mergeHost(HOST, { isDisabled: false }).isDisabled).toBe(false);
  });

  it('не тащит в тело inbound, nodes и сырые блобы', () => {
    const body = mergeHost(HOST, { port: 8443 }) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'isDisabled',
      'isHidden',
      'keepSniBlank',
      'mihomoX25519',
      'overrideSniFromAddress',
      'port',
      'shuffleHost',
      'uuid',
    ]);
  });

  /**
   * Снимок без `isDisabled` — единственный случай, где «разумное умолчание»
   * является аварией: подставленный false ВКЛЮЧАЕТ хост.
   */
  it('отказывается собирать тело, если снимок не дал isDisabled', () => {
    const { isDisabled: _drop, ...withoutFlag } = HOST;
    expect(() => mergeHost(withoutFlag, { port: 8443 })).toThrow(/isDisabled/);
  });

  it('падает, если маска оказалась в самом патче', () => {
    expect(() => mergeHost(HOST, { remark: REDACTED })).toThrow(/getRaw/);
  });

  /**
   * Тело правки собирается минимальным (uuid + булевы + изменяемые поля), и
   * маска в НЕТРОНУТОМ поле снимка до панели не доезжает по построению. Это
   * свойство, а не случайность, и оно проверяется здесь: если тело однажды
   * начнут собирать из всего снимка, маска поедет — и `assertNoMaskedValues` внутри
   * `mergeHost` её поймает.
   */
  it('маска в поле, которого правка не касается, в тело не попадает вовсе', () => {
    const body = mergeHost({ ...HOST, sni: REDACTED }, { port: 8443 });
    expect(body).not.toHaveProperty('sni');
  });
});

describe('previousOf', () => {
  it('возвращает прежние значения ровно изменяемых полей', () => {
    expect(previousOf(HOST, { remark: 'новое', port: 8443 })).toEqual({
      remark: '🇩🇪 Germany ⚡',
      port: 443,
    });
  });

  it('поля, которого в снимке не было, в откате нет — восстанавливать нечего', () => {
    expect(previousOf({ uuid: UUID }, { sni: 'x' })).toEqual({});
  });
});

describe('host_edit', () => {
  it('план читает хост ТОЛЬКО нередактированным каналом', async () => {
    const w = world();
    await callTool(hostEdit(w.deps), { uuid: UUID, is_disabled: false }, w);
    const reads = w.calls.filter((call) => call.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((call) => call.raw === true)).toBe(true);
  });

  it('план показывает снимок, diff и готовый откат', async () => {
    const w = world();
    const plan = (await callTool(hostEdit(w.deps), { uuid: UUID, is_disabled: false }, w)) as {
      before: Record<string, unknown>;
      diff: Array<{ path: string; from: unknown; to: unknown }>;
      rollback: { method: string; path: string; body: Record<string, unknown> };
      sideEffects: string[];
    };

    expect(plan.before).toMatchObject({ uuid: UUID, isDisabled: true, remark: '🇩🇪 Germany ⚡' });
    expect(plan.diff).toEqual([{ path: 'isDisabled', from: true, to: false }]);
    expect(plan.rollback.method).toBe('PATCH');
    expect(plan.rollback.path).toBe('/api/hosts');
    expect(plan.rollback.body).toMatchObject({ uuid: UUID, isDisabled: true, isHidden: false });
    expect(plan.sideEffects.join(' ')).toMatch(/мост/i);
  });

  /**
   * ГЛАВНЫЙ ТЕСТ ЭТОГО ФАЙЛА. Ни одно тело, ушедшее в панель за весь цикл
   * план → применение, не смеет содержать маркер редакции. Проверяется по всем
   * записанным вызовам, а не по одному ожидаемому: правка, вернувшая чтение на
   * `get()`, покрасит этот тест независимо от того, какое поле пострадало.
   */
  it('маска не доезжает до панели ни одним телом', async () => {
    const w = world();
    await planThenApply(hostEdit(w.deps), { uuid: UUID, remark: 'Германия ⚡' }, w);
    const sent = JSON.stringify(bodies(w));
    expect(sent).not.toContain(REDACTED);
    expect(sent).toContain('Германия ⚡');
  });

  /**
   * ВТОРОЙ ПУТЬ, ПО КОТОРОМУ МАСКА ДОЕХАЛА БЫ ДО ПАНЕЛИ, — ОТКАТ. Тело правки
   * маску нетронутого поля не несёт, а вот `rollback.body` собирается из
   * ПРЕЖНИХ значений ровно тех полей, которые меняются: снимок, прочитанный
   * редактирующим каналом, превратил бы «вернуть как было» в «затереть
   * маской». План здесь не строится вовсе.
   */
  it('план не строится, если прежнее значение изменяемого поля замаскировано', async () => {
    const w = world({ ...HOST, remark: REDACTED });
    await expect(
      callTool(hostEdit(w.deps), { uuid: UUID, remark: 'Германия ⚡' }, w),
    ).rejects.toThrow(/getRaw/);
    expect(w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('применение шлёт PATCH /api/hosts с uuid в теле и всеми булевыми', async () => {
    const w = world();
    await planThenApply(hostEdit(w.deps), { uuid: UUID, remark: 'Германия ⚡' }, w);
    const patch = w.calls.find((call) => call.method === 'PATCH');
    expect(patch?.path).toBe('/api/hosts');
    expect(patch?.body).toEqual({
      uuid: UUID,
      isDisabled: true,
      isHidden: false,
      overrideSniFromAddress: false,
      keepSniBlank: false,
      shuffleHost: false,
      mihomoX25519: false,
      remark: 'Германия ⚡',
    });
  });

  it('пустая правка планом не становится', async () => {
    const w = world();
    await expect(callTool(hostEdit(w.deps), { uuid: UUID }, w)).rejects.toThrow(
      /ни одного изменяемого поля/,
    );
  });

  it('правка, которая ничего не меняет, отбивается каркасом как пустой diff', async () => {
    const w = world();
    await expect(callTool(hostEdit(w.deps), { uuid: UUID, is_disabled: true }, w)).rejects.toThrow(
      /diff пуст/,
    );
  });

  it('несуществующий хост — отказ с числом хостов панели', async () => {
    const w = world();
    await expect(
      callTool(hostEdit(w.deps), { uuid: '00000000-0000-4000-8000-000000000000', port: 8443 }, w),
    ).rejects.toThrow(/в панели нет/);
  });

  it('уехавший мир отбивает применение: хост правили между планом и подтверждением', async () => {
    let reads = 0;
    const w = makeWorld({
      remnaGetRaw: () => {
        reads += 1;
        return { response: [reads <= 1 ? HOST : { ...HOST, remark: 'кто-то уже переименовал' }] };
      },
      remnaSend: () => ({ response: HOST }),
    });
    const tool = hostEdit(w.deps);
    const plan = (await callTool(tool, { uuid: UUID, port: 8443 }, w)) as { plan_id: string };
    await expect(
      callTool(tool, { uuid: UUID, port: 8443, plan_id: plan.plan_id }, w),
    ).rejects.toThrow(/состояние изменилось/);
    expect(w.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});
