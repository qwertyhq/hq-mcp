import { describe, expect, it } from 'vitest';
import {
  BOT_LIST_CAP,
  BOT_SENTINEL,
  isForbiddenKey,
  normalizeKey,
  redactBotStrict,
  redactMessage,
  scrubString,
} from './redactBot.js';

describe('normalizeKey / isForbiddenKey', () => {
  it('снимает регистр и разделители, поэтому snake и camel ловятся одним списком', () => {
    expect(normalizeKey('sub_last_user_agent')).toBe('sublastuseragent');
    expect(normalizeKey('subLastUserAgent')).toBe('sublastuseragent');
    expect(isForbiddenKey('subLastUserAgent')).toBe(true);
    expect(isForbiddenKey('full_name')).toBe(true);
    expect(isForbiddenKey('telegram_login')).toBe(true);
    // login в SHM — это 'tg100000001', то есть telegram_id клиента открытым текстом
    expect(isForbiddenKey('login')).toBe(true);
    expect(isForbiddenKey('login1')).toBe(true);
    expect(isForbiddenKey('login2')).toBe(true);
    expect(isForbiddenKey('subscriptionUrl')).toBe(true);
    expect(isForbiddenKey('shortUuid')).toBe(true);
    expect(isForbiddenKey('vpn_mrzb_ru')).toBe(true);
    expect(isForbiddenKey('trojanPassword')).toBe(true);
    expect(isForbiddenKey('apiToken')).toBe(true);
  });

  it('не жрёт полезные поля', () => {
    for (const key of ['uuid', 'user_id', 'status', 'expire', 'balance', 'nodeName', 'userServiceId']) {
      expect(isForbiddenKey(key)).toBe(false);
    }
  });

  /**
   * Обратная сторона, ради которой этот список — свой, а не `SECRET_KEY_RE`.
   * Та регулярка матчит подстроку `key` и съедала настоящие поля, чьё значение —
   * ИМЕНА ключей, а не ключевой материал. В бот-контуре цена такой ошибки
   * выше, а не ниже: чинить нечем, ответ уже ушёл клиенту.
   */
  it('не путает имя ключа с самим ключом', () => {
    for (const key of ['changedKeys', 'svgLibraryKeys', 'translationKeys', 'showConnectionKeys', 'uniq_id']) {
      expect(isForbiddenKey(key)).toBe(false);
    }
    // И при этом сами креды подключения по-прежнему запрещены.
    expect(isForbiddenKey('connectionKeys')).toBe(true);
  });
});

describe('scrubString', () => {
  it('вычищает IPv4, прокси-ссылки и ссылки подписки из свободного текста', () => {
    expect(scrubString('client from 95.24.11.7 complains')).toEqual({ value: 'client from <redacted> complains', hits: 1 });
    expect(scrubString('vless://uuid@1.2.3.4:443?x=1#tag').value).toBe('<redacted>');
    expect(scrubString('open https://sub.example.com/sub/AbCdEf12').value).toBe('open <redacted>');
  });

  it('обычный текст и версии не трогает', () => {
    expect(scrubString('SHM 2.18.2, Remnawave 2.8.0')).toEqual({ value: 'SHM 2.18.2, Remnawave 2.8.0', hits: 0 });
  });

  it('предупреждение §6.11 про слепоту панели проходит невредимым', () => {
    const warning =
      'panel blind spot: isConnected reflects the control plane only; a relay backend outage ' +
      '(HAProxy option allbackups) is invisible here, see the Germany 2 incident';
    expect(scrubString(warning)).toEqual({ value: warning, hits: 0 });
  });

  /**
   * Форма секрета, а не только форма адреса. Токен бота приезжает В ЗНАЧЕНИИ
   * обычного поля (`host` сервера SHM, `response.request.url` строки спула), и
   * именно этот класс `@hq/redact` пропускал по построению, пока правило было
   * только про имена.
   */
  it('вычищает и то, что выглядит секретом, а не адресом', () => {
    const token = ['1088', '9977', '01:'].join('') + ['AAF', 'q7x2Kd0Lm9', 'Zt4Rv1Ns6Wb', '3Yc8Hj5Pg2Q'].join('');
    const { value, hits } = scrubString(`spool row went to ${token} yesterday`);
    expect(value).not.toContain(token);
    expect(hits).toBe(1);
  });

  it('не трогает непрозрачный идентификатор платежа', () => {
    // `uniq_id` бывает 32-символьным hex, и он — ровно то поле, ради которого
    // билинговую строку и читают. Порог «длинного непрозрачного прогона»
    // откалиброван на телах шаблонов, поэтому здесь он выключен.
    const line = 'payment 9f8e7d6c5b4a392817065f4e3d2c1b0a settled';
    expect(scrubString(line)).toEqual({ value: line, hits: 0 });
  });
});

describe('redactMessage', () => {
  it('вырезает URL целиком: в пути и параметрах едут секрет shm-all и идентификаторы', () => {
    const shm = redactMessage('SHM GET https://billing.example.com/shm/v1/admin/user/search?text=tg100000001 failed with 403');
    expect(shm).not.toContain('billing.example.com');
    expect(shm).not.toContain('tg100000001');
    expect(shm).toContain('403');

    const remna = redactMessage('Remnawave PATCH https://panel.example.com/api/hosts returned 500');
    expect(remna).not.toContain('panel.example.com');
    expect(remna).toContain('500');
  });

  it('чистит IP и прокси-ссылки в тексте ошибки', () => {
    expect(redactMessage('connect ETIMEDOUT 192.0.2.20:6767')).not.toContain('192.0.2.20');
    expect(redactMessage('bad link vless://uuid@1.2.3.4:443#tag')).not.toContain('vless://');
  });

  it('сообщение без секретов остаётся читаемым', () => {
    expect(redactMessage('Tool client_overview not found')).toBe('Tool client_overview not found');
  });
});

describe('redactBotStrict', () => {
  it('вырезает креды, ссылку подписки и PII, считая срабатывания', () => {
    const input = {
      shm: { user_id: 3073, login: 'tg100000001', balance: 120.5, email: 'client@example.com', full_name: 'Иван И.' },
      remna: {
        uuid: 'a1b2c3',
        status: 'ACTIVE',
        subscriptionUrl: 'https://sub.example.com/sub/AbCdEf12',
        shortUuid: 'AbCdEf12',
        trojanPassword: 'p@ssw0rd',
        vlessUuid: 'dead-beef'
      },
      lastIp: '95.24.11.7',
      subLastUserAgent: 'Happ/2.1 iOS',
      note: 'заходил с 95.24.11.7'
    };
    const { value, report } = redactBotStrict(input);
    const out = value as Record<string, Record<string, unknown>>;

    expect(out.shm?.user_id).toBe(3073);
    expect(out.shm?.balance).toBe(120.5);
    expect(out.shm?.login).toBe(BOT_SENTINEL);
    expect(out.shm?.email).toBe(BOT_SENTINEL);
    expect(out.shm?.full_name).toBe(BOT_SENTINEL);
    expect(out.remna?.uuid).toBe('a1b2c3');
    expect(out.remna?.status).toBe('ACTIVE');
    expect(out.remna?.subscriptionUrl).toBe(BOT_SENTINEL);
    expect(out.remna?.shortUuid).toBe(BOT_SENTINEL);
    expect(out.remna?.trojanPassword).toBe(BOT_SENTINEL);
    expect(out.remna?.vlessUuid).toBe(BOT_SENTINEL);
    expect((out as unknown as { lastIp: string }).lastIp).toBe(BOT_SENTINEL);
    expect((out as unknown as { subLastUserAgent: string }).subLastUserAgent).toBe(BOT_SENTINEL);
    expect((out as unknown as { note: string }).note).toBe('заходил с <redacted>');

    expect(report.forbiddenKeys).toBe(9);
    expect(report.scrubbedStrings).toBe(1);
    expect(JSON.stringify(value)).not.toContain('95.24.11.7');
    expect(JSON.stringify(value)).not.toContain('AbCdEf12');
    expect(JSON.stringify(value)).not.toContain('tg100000001');
  });

  it('режет длинные списки и отмечает это в отчёте', () => {
    const items = Array.from({ length: BOT_LIST_CAP + 10 }, (_, i) => ({ id: i }));
    const { value, report } = redactBotStrict({ items });
    expect((value as { items: unknown[] }).items).toHaveLength(BOT_LIST_CAP);
    expect(report.truncatedLists).toBe(1);
  });

  it('PII внутри элементов списка вырезается, а не только на верхнем уровне', () => {
    const { value, report } = redactBotStrict({
      items: [
        { user_id: 1, login: 'tg111', email: 'a@example.com', balance: 10 },
        { user_id: 2, login: 'tg222', email: 'b@example.com', balance: 20 }
      ],
      items_total: 2
    });
    const rows = (value as { items: Array<Record<string, unknown>> }).items;
    expect(rows[0]?.user_id).toBe(1);
    expect(rows[0]?.balance).toBe(10);
    expect(rows[0]?.login).toBe(BOT_SENTINEL);
    expect(rows[1]?.email).toBe(BOT_SENTINEL);
    expect(report.forbiddenKeys).toBe(4);
    // items_total (§6.4, полный FOUND_ROWS) — не PII и обязан доезжать до бота
    expect((value as { items_total: number }).items_total).toBe(2);
    expect(JSON.stringify(value)).not.toContain('tg111');
    expect(JSON.stringify(value)).not.toContain('example.com');
  });

  it('переживает циклы и запредельную вложенность', () => {
    const cyclic: Record<string, unknown> = { name: 'node' };
    cyclic.self = cyclic;
    expect((redactBotStrict(cyclic).value as { self: unknown }).self).toBe('<cycle>');

    let deep: unknown = { leaf: true };
    for (let i = 0; i < 30; i += 1) deep = { nested: deep };
    expect(() => redactBotStrict(deep)).not.toThrow();
    expect(JSON.stringify(redactBotStrict(deep).value)).toContain('<depth-limit>');
  });

  /**
   * Цикл — это ССЫЛКА НА СЕБЯ ПО ТЕКУЩЕЙ ВЕТКЕ, а не «объект, который уже
   * встречался». Ответ инструмента собирается в JS, поэтому одна и та же
   * ссылка спокойно лежит в двух местах; пометив второе вхождение маркером,
   * редакция молча съела бы кусок ответа. `@hq/redact` эту же ошибку уже
   * исправляла у себя — здесь она не повторяется.
   */
  it('не принимает общий подобъект за цикл', () => {
    const shared = { user_id: 7, login: 'tg777' };
    const { value } = redactBotStrict({ primary: shared, mirror: shared, list: [shared] });
    const out = value as Record<string, Record<string, unknown>>;
    expect(out.primary).toEqual({ user_id: 7, login: BOT_SENTINEL });
    expect(out.mirror).toEqual({ user_id: 7, login: BOT_SENTINEL });
    expect((value as { list: Array<Record<string, unknown>> }).list[0]).toEqual({
      user_id: 7,
      login: BOT_SENTINEL,
    });
  });

  /**
   * Класс, который правило по именам пропускает по построению: имя поля
   * безобидно, секрет лежит ВНУТРИ значения. Бот-контур — тот, из которого
   * утечка уходит из-под нашего контроля насовсем.
   */
  it('вырезает секрет из значения поля с безобидным именем', () => {
    const token = ['1088', '9977', '01:'].join('') + ['AAF', 'q7x2Kd0Lm9', 'Zt4Rv1Ns6Wb', '3Yc8Hj5Pg2Q'].join('');
    const { value } = redactBotStrict({
      server: { name: 'telegram-http', host: `https://api.telegram.org/bot${token}/sendMessage` },
    });
    expect(JSON.stringify(value)).not.toContain(token);
    expect(JSON.stringify(value)).toContain('telegram-http');
  });

  it('не гасит поля, чьё имя лишь похоже на секретное', () => {
    const payload = {
      changedKeys: ['limit', 'expire'],
      svgLibraryKeys: ['Happ'],
      translationKeys: 12,
      showConnectionKeys: false,
      uniq_id: '9f8e7d6c5b4a392817065f4e3d2c1b0a',
    };
    const { value, report } = redactBotStrict(payload);
    expect(value).toEqual(payload);
    expect(report).toEqual({ forbiddenKeys: 0, scrubbedStrings: 0, truncatedLists: 0 });
  });

  it('примитивы и даты проходят насквозь', () => {
    expect(redactBotStrict(42).value).toBe(42);
    expect(redactBotStrict(null).value).toBeNull();
    expect(redactBotStrict({ at: new Date('2026-08-08T00:00:00.000Z') }).value).toEqual({ at: '2026-08-08T00:00:00.000Z' });
  });
});
