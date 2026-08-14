import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  asArray,
  asRecord,
  assertHumanOnly,
  capLimit,
  errMessage,
  httpStatus,
  num,
  safeEndpoint,
  str,
  warn,
} from '../kit.js';

const PROVIDERS = '/api/infra-billing/providers';
const BILLING_NODES = '/api/infra-billing/nodes';
const BILLING_HISTORY = '/api/infra-billing/history';
const NODES = '/api/nodes';

/** GetInfraBillingRecordsCommand: size ∈ [1, 500], 501 отвергается валидацией. */
const MAX_HISTORY = 500;
const DEFAULT_HISTORY = 50;

/** Дыра, которую НЕ посчитали, и почему. */
interface Suppression {
  gap: string;
  reason: string;
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string; status: number | null };

/**
 * `settle` из kit теряет HTTP-статус, а здесь он несёт СМЫСЛ: 404 роутера
 * означает «инфра-биллинга на этой версии панели нет», и это другой ответ, чем
 * «есть, но никто не настроил». Пустой список вместо этого различия — ровно то,
 * что клиент @hq/remna запрещает делать с удалёнными маршрутами.
 */
async function read<T>(promise: Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error: unknown) {
    return { ok: false, error: errMessage(error), status: httpStatus(error) };
  }
}

function valueOf<T>(result: Read<T>, into: Degraded[], system: Degraded['system'], fallback: T): T {
  if (result.ok) return result.value;
  into.push({ system, error: result.error });
  return fallback;
}

function isoAt(value: unknown): { iso: string | null; at: number | null } {
  const text = str(value);
  if (text === null) return { iso: null, at: null };
  const parsed = Date.parse(text);
  return { iso: text, at: Number.isFinite(parsed) ? parsed : null };
}

export const infraCosts = defineTool({
  name: 'infra_costs',
  description:
    'What the infrastructure costs, from the Remnawave infra-billing controller: providers, ' +
    'which node bills to which provider and when it is next due, and the payment history with ' +
    'per-provider totals. The interesting part is the join with the panel itself, and this tool ' +
    'does it rather than leaving it to the reader: a billed node that is disabled, offline or ' +
    'carrying nobody is money going out for capacity no client reaches, and a panel node with no ' +
    'billing record is spend that is simply not tracked here (pair it with infra_map to see ' +
    'whether that node even has a live host publishing it). Amounts carry no currency in the ' +
    'API — they are whatever the operator typed. An empty answer is never reported as "we pay ' +
    'nothing": the tool separates "the routes are absent on this panel version" from "the ' +
    'routes answered and nobody has configured infra billing", and says which.',
  input: z.object({
    limit: z
      .number()
      .int()
      .default(DEFAULT_HISTORY)
      .describe('Billing history records to read, newest first; capped at 500 by the panel'),
  }),
  access: 'ro',
  risk: 'none',
  // Только human: это расходы компании и карта того, у какого провайдера что
  // арендовано. Ни один вопрос клиента этим не отвечается (§7.2).
  profiles: ['human'],
  backends: ['remna'],
  handler: async ({ limit }, ctx) => {
    assertHumanOnly(
      ctx,
      'infra_costs is available to the human profile only: it reports what the company pays and ' +
        'to which provider, plus which node is rented where. That is operator and finance ' +
        'knowledge, not an answer to a client question (§7.2).',
    );
    const degraded: Degraded[] = [];
    const warnings: ToolWarning[] = [];
    const suppressed: Suppression[] = [];
    const size = capLimit(limit, DEFAULT_HISTORY, MAX_HISTORY);

    const [providerRead, nodeBillingRead, historyRead, panelNodeRead] = await Promise.all([
      read(ctx.remna.get<unknown>(PROVIDERS)),
      read(ctx.remna.get<unknown>(BILLING_NODES)),
      read(ctx.remna.get<unknown>(BILLING_HISTORY, { size, start: 0 })),
      read(ctx.remna.get<unknown>(NODES)),
    ]);

    const billingReads = [providerRead, nodeBillingRead, historyRead];
    const answered = billingReads.filter((one) => one.ok).length;
    const missing = billingReads.filter((one) => !one.ok && one.status === 404).length;
    const availability =
      answered > 0 ? 'present' : missing === billingReads.length ? 'absent' : 'unknown';

    // Отсутствующий маршрут — не деградация источника, а факт о версии панели;
    // в degraded он не пишется, иначе «фичи нет» читалось бы как «панель легла».
    const noteRead = (result: Read<unknown>): void => {
      if (!result.ok && !(availability === 'absent' && result.status === 404)) {
        degraded.push({ system: 'remna', error: result.error });
      }
    };
    for (const one of billingReads) noteRead(one);
    const panelNodesValue = valueOf(panelNodeRead, degraded, 'remna', null);

    const providerBody = asRecord(valueOf(providerRead, [], 'remna', null));
    const billingBody = asRecord(valueOf(nodeBillingRead, [], 'remna', null));
    const historyBody = asRecord(valueOf(historyRead, [], 'remna', null));

    const providers = asArray(providerBody.providers).map(asRecord);
    const billingNodes = asArray(billingBody.billingNodes).map(asRecord);
    const availableNodes = asArray(billingBody.availableBillingNodes).map(asRecord);
    const historyRows = asArray(historyBody.records).map(asRecord);
    const panelNodes = asArray(panelNodesValue === null ? [] : (asRecord(panelNodesValue).nodes ?? panelNodesValue)).map(asRecord);

    const providerNames = new Map<string, string | null>();
    const mappedProviders = providers.map((row) => {
      const uuid = str(row.uuid) ?? '';
      providerNames.set(uuid, str(row.name));
      const history = asRecord(row.billingHistory);
      return {
        uuid,
        name: str(row.name),
        // Ссылка на кабинет провайдера — такой же адрес из значения, как host
        // сервера SHM: путь и query у неё отрезаются, потому что magic-link с
        // токеном внутри выглядит ровно так же, как обычный /login.
        loginUrl: safeEndpoint(row.loginUrl),
        totalBills: num(history.totalBills),
        totalAmount: num(history.totalAmount),
        nodes: asArray(row.billingNodes)
          .map(asRecord)
          .map((one) => ({
            name: str(one.name),
            nodeUuid: str(asRecord(one.details).nodeUuid),
            countryCode: str(asRecord(one.details).countryCode),
          })),
      };
    });

    const mappedBillingNodes = billingNodes.map((row) => {
      const node = asRecord(row.node);
      const due = isoAt(row.nextBillingAt);
      return {
        uuid: str(row.uuid) ?? '',
        nodeUuid: str(row.nodeUuid) ?? str(node.uuid),
        name: str(row.name) ?? str(node.name),
        countryCode: str(node.countryCode),
        providerUuid: str(row.providerUuid),
        providerName: str(asRecord(row.provider).name) ?? providerNames.get(str(row.providerUuid) ?? '') ?? null,
        nextBillingAt: due.iso,
        overdue: due.at !== null && due.at < ctx.now().getTime(),
      };
    });

    const panelByUuid = new Map(panelNodes.map((row) => [str(row.uuid) ?? '', row]));
    const panelUsable = panelNodeRead.ok && panelNodes.length > 0;

    const suppress = (gap: string, reason: string): null => {
      suppressed.push({ gap, reason });
      return null;
    };

    const billedNodesMissingFromPanel = panelUsable
      ? mappedBillingNodes
          .filter((one) => one.nodeUuid === null || !panelByUuid.has(one.nodeUuid))
          .map((one) => ({ uuid: one.uuid, name: one.name, nodeUuid: one.nodeUuid, providerName: one.providerName }))
      : suppress(
          'billedNodesMissingFromPanel',
          panelNodeRead.ok
            ? 'the panel returned no nodes at all, and against an empty set every billed node ' +
              'would look deleted'
            : 'the node listing did not answer, so a billed node cannot be matched to a live one',
        );

    /** Плата идёт, а ёмкости за ней нет: нода выключена, отвалилась или пуста. */
    const billedNodesIdle = panelUsable
      ? mappedBillingNodes
          .filter((one) => one.nodeUuid !== null && panelByUuid.has(one.nodeUuid))
          .map((one) => {
            const node = asRecord(panelByUuid.get(one.nodeUuid ?? ''));
            return {
              uuid: one.uuid,
              nodeUuid: one.nodeUuid,
              name: one.name ?? str(node.name),
              providerName: one.providerName,
              isDisabled: node.isDisabled === true,
              isConnected: node.isConnected === true,
              usersOnline: num(node.usersOnline),
            };
          })
          .filter((one) => one.isDisabled || !one.isConnected || one.usersOnline === 0)
      : suppress(
          'billedNodesIdle',
          panelNodeRead.ok
            ? 'the panel returned no nodes at all, so "nobody is on it" cannot be established'
            : 'the node listing did not answer',
        );

    const billedUuids = new Set(
      mappedBillingNodes.map((one) => one.nodeUuid).filter((one): one is string => one !== null),
    );
    const panelNodesWithoutBilling = panelUsable && nodeBillingRead.ok
      ? panelNodes
          .filter((row) => !billedUuids.has(str(row.uuid) ?? ''))
          .map((row) => ({
            uuid: str(row.uuid),
            name: str(row.name),
            countryCode: str(row.countryCode),
          }))
      : suppress(
          'panelNodesWithoutBilling',
          !nodeBillingRead.ok
            ? 'the billing-node listing did not answer, and against an empty set every panel node ' +
              'would look unbilled'
            : 'the node listing did not answer',
        );

    const billingOverdue = mappedBillingNodes
      .filter((one) => one.overdue)
      .map((one) => ({ uuid: one.uuid, name: one.name, providerName: one.providerName, nextBillingAt: one.nextBillingAt }));

    const historyTotal = num(historyBody.total, historyRows.length);
    const configured =
      num(providerBody.total, providers.length) > 0 ||
      num(billingBody.totalBillingNodes, billingNodes.length) > 0 ||
      historyTotal > 0;

    if (availability === 'absent') {
      warnings.push(
        warn(
          'infra_billing_absent',
          'The infra-billing routes are not on this panel: every one of them answered with the ' +
            'router 404, not with an empty list. Nothing here says anything about what the ' +
            'infrastructure costs — the feature is missing, and the answer below is empty for ' +
            'that reason and no other.',
        ),
      );
    } else if (availability === 'unknown') {
      warnings.push(
        warn(
          'infra_billing_absent',
          'None of the infra-billing routes answered, and not with a 404 either (see `degraded`), ' +
            'so whether this panel has the feature at all is unknown. Do not read the empty lists ' +
            'below as "nothing is billed".',
        ),
      );
    } else if (!configured) {
      warnings.push(
        warn(
          'infra_billing_unconfigured',
          'The infra-billing routes are present and answered, and there is nothing in them: no ' +
            'provider, no billed node, no payment record. That is "nobody has filled this in", ' +
            'not "the infrastructure is free" — the nodes are still rented somewhere and the ' +
            'bills still arrive, they are just tracked outside the panel.',
        ),
      );
    }
    if (historyTotal > historyRows.length) {
      warnings.push(
        warn(
          'truncated',
          `The billing history returned ${String(historyRows.length)} of ${String(historyTotal)} ` +
            'records. Totals computed from this window are about the window, not about the ' +
            'lifetime spend; per-provider `totalAmount` comes from the panel itself and is not.',
        ),
      );
    }
    if (billedNodesIdle !== null && billedNodesIdle.length > 0) {
      warnings.push(
        warn(
          'billed_node_idle',
          `${String(billedNodesIdle.length)} billed nodes are disabled, disconnected or carrying ` +
            'nobody right now. "Nobody online" is a snapshot, not a month — a node can be paid ' +
            'for legitimately and be empty at this minute, and a relay or bridge hop carries ' +
            'traffic without ever showing a user on it. Check the traffic and the hosts before ' +
            'cancelling anything.',
        ),
      );
    }
    if (
      nodeBillingRead.ok &&
      panelNodesWithoutBilling !== null &&
      availableNodes.length !== panelNodesWithoutBilling.length
    ) {
      warnings.push(
        warn(
          'unbilled_node_count_disagrees',
          `The panel reports ${String(availableNodes.length)} nodes available for billing while ` +
            `the node list yields ${String(panelNodesWithoutBilling.length)} without a billing ` +
            'record. The two are computed differently — take the panel number as authoritative ' +
            'for "what can be attached" and the list below for "which node is not paid for here".',
        ),
      );
    }
    if (degraded.length > 0) {
      warnings.push(
        warn(
          'partial_result',
          'A panel listing did not answer (see `degraded`). Every join that depended on it is ' +
            'null with a reason in `suppressed` rather than computed from what is left.',
        ),
      );
    }

    return {
      availability,
      configured,
      counts: {
        providers: mappedProviders.length,
        billingNodes: mappedBillingNodes.length,
        historyRecords: historyRows.length,
        // Серверные счётчики (§6.4) — не длина отданного куска.
        reported: {
          providers: num(providerBody.total, mappedProviders.length),
          billingNodes: num(billingBody.totalBillingNodes, mappedBillingNodes.length),
          availableForBilling: num(billingBody.totalAvailableBillingNodes, availableNodes.length),
          historyRecords: historyTotal,
        },
      },
      stats: {
        upcomingNodesCount: num(asRecord(billingBody.stats).upcomingNodesCount),
        currentMonthPayments: num(asRecord(billingBody.stats).currentMonthPayments),
        totalSpent: num(asRecord(billingBody.stats).totalSpent),
      },
      providers: mappedProviders,
      billingNodes: mappedBillingNodes,
      availableForBilling: availableNodes.map((row) => ({
        uuid: str(row.uuid),
        name: str(row.name),
        countryCode: str(row.countryCode),
      })),
      history: {
        windowTotal: historyRows.reduce((sum, row) => sum + num(row.amount), 0),
        records: historyRows.map((row) => ({
          uuid: str(row.uuid),
          providerUuid: str(row.providerUuid),
          providerName: str(asRecord(row.provider).name) ?? providerNames.get(str(row.providerUuid) ?? '') ?? null,
          amount: num(row.amount),
          billedAt: isoAt(row.billedAt).iso,
        })),
      },
      findings: {
        billedNodesMissingFromPanel,
        billedNodesIdle,
        panelNodesWithoutBilling,
        billingOverdue,
      },
      suppressed,
      warnings,
      degraded,
    };
  },
});
