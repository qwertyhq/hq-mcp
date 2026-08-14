import { describe, expect, it } from 'vitest';
import {
  buildTopology,
  forecastOrphans,
  hostsWithUnknownInbound,
  inboundsActiveWithoutHost,
  inboundsPublishedOnlyByDisabledHosts,
} from './topology.js';

/**
 * Мир по мотивам настоящей панели: страна с живым хостом, страна, которую держит
 * один выключенный хост, и МОСТ — инбаунд, который нода обслуживает, а хоста у
 * него нет и быть не должно (`remna-configs/fix-bridge.sh` его не создаёт).
 * Мост здесь не для полноты: именно на нём ломается любая «чистка», которая
 * считает отсутствие хоста поломкой.
 */
const NODES = [
  {
    uuid: 'n-de',
    name: 'Germany',
    countryCode: 'DE',
    isConnected: true,
    isDisabled: false,
    configProfile: {
      activeConfigProfileUuid: 'p-1',
      activeInbounds: [
        { uuid: 'i-live', tag: 'VLESS_DE_IN' },
        { uuid: 'i-dark', tag: 'VLESS_DE_OLD' },
        { uuid: 'i-bridge', tag: 'BRIDGE_DE_IN' },
      ],
    },
  },
];

const HOSTS = [
  { uuid: 'h-live', remark: 'Germany', isDisabled: false, inbound: { configProfileInboundUuid: 'i-live' } },
  { uuid: 'h-live-2', remark: 'Germany 2', isDisabled: false, inbound: { configProfileInboundUuid: 'i-live' } },
  { uuid: 'h-off', remark: 'Germany old', isDisabled: true, inbound: { configProfileInboundUuid: 'i-dark' } },
  { uuid: 'h-zombie', remark: 'VISPARK leftover', isDisabled: true, inbound: { configProfileInboundUuid: 'i-gone' } },
];

const PROFILES = [
  {
    uuid: 'p-1',
    name: 'main',
    inbounds: [
      { uuid: 'i-live', tag: 'VLESS_DE_IN', type: 'vless' },
      { uuid: 'i-dark', tag: 'VLESS_DE_OLD', type: 'vless' },
      { uuid: 'i-bridge', tag: 'BRIDGE_DE_IN', type: 'vless' },
    ],
  },
];

const world = (hosts = HOSTS): ReturnType<typeof buildTopology> =>
  buildTopology({ nodes: NODES, hosts, inbounds: [], profiles: PROFILES });

describe('buildTopology', () => {
  it('различает «опубликован хоть кем-то» и «опубликован живым хостом»', () => {
    const topology = world();
    expect([...topology.publishedByAny].sort()).toEqual(['i-dark', 'i-gone', 'i-live']);
    expect([...topology.publishedByEnabled]).toEqual(['i-live']);
    expect(topology.servedBy.get('i-live')).toEqual(['n-de']);
  });

  it('тег инбаунда берётся и из состава ноды, когда каталог инбаундов пуст', () => {
    expect(world().tagByInbound.get('i-bridge')).toBe('BRIDGE_DE_IN');
  });
});

describe('разрывы', () => {
  it('зомби — только хост, чей инбаунд панели неизвестен', () => {
    expect(hostsWithUnknownInbound(world())).toEqual([
      { uuid: 'h-zombie', remark: 'VISPARK leftover', inboundUuid: 'i-gone' },
    ]);
  });

  it('мост попадает в «активен без хоста» — и это НЕ повод его чинить', () => {
    expect(inboundsActiveWithoutHost(world())).toEqual([
      { uuid: 'i-bridge', tag: 'BRIDGE_DE_IN', activeOnNodes: ['n-de'] },
    ]);
  });

  /**
   * `i-gone` в списке — не промах, а поведение карты: разрыв считается по
   * листингу ХОСТОВ в одиночку, и инбаунд зомби-хоста тоже «опубликован только
   * выключенным». Проверять здесь ещё и существование инбаунда значило бы
   * привязать этот разрыв к листингу инбаундов, то есть погасить его вместе с
   * ним. Сам зомби при этом уже назван своим именем соседней функцией.
   */
  it('«страна погасла» — инбаунд, у которого остались только выключенные хосты', () => {
    expect(inboundsPublishedOnlyByDisabledHosts(world())).toEqual([
      { uuid: 'i-dark', tag: 'VLESS_DE_OLD' },
      { uuid: 'i-gone', tag: null },
    ]);
  });
});

describe('forecastOrphans', () => {
  it('снос зомби не оставляет сирот: его инбаунда всё равно нет на нодах', () => {
    expect(forecastOrphans(world(), ['h-zombie'])).toEqual({
      losingLastLiveHost: [],
      losingLastHost: [],
    });
  });

  it('снос ОДНОГО из двух живых хостов страну не гасит', () => {
    expect(forecastOrphans(world(), ['h-live']).losingLastLiveHost).toEqual([]);
  });

  it('снос ОБОИХ живых хостов гасит страну — это отказ, а не предупреждение', () => {
    const forecast = forecastOrphans(world(), ['h-live', 'h-live-2']);
    expect(forecast.losingLastLiveHost).toEqual([
      { uuid: 'i-live', tag: 'VLESS_DE_IN', activeOnNodes: ['n-de'] },
    ]);
    expect(forecast.losingLastHost).toEqual([
      { uuid: 'i-live', tag: 'VLESS_DE_IN', activeOnNodes: ['n-de'] },
    ]);
  });

  it('снос последнего ВЫКЛЮЧЕННОГО хоста клиентам ничего не рвёт, но делает инбаунд неотличимым от моста', () => {
    const forecast = forecastOrphans(world(), ['h-off']);
    // Клиентам он и так не светил: живого хоста у него уже не было.
    expect(forecast.losingLastLiveHost).toEqual([]);
    expect(forecast.losingLastHost).toEqual([
      { uuid: 'i-dark', tag: 'VLESS_DE_OLD', activeOnNodes: ['n-de'] },
    ]);
  });

  it('инбаунд, который не обслуживает ни одна нода, сиротой не становится — он им уже был', () => {
    const detached = buildTopology({ nodes: [], hosts: HOSTS, inbounds: [], profiles: PROFILES });
    expect(forecastOrphans(detached, ['h-live', 'h-live-2', 'h-off'])).toEqual({
      losingLastLiveHost: [],
      losingLastHost: [],
    });
  });
});
