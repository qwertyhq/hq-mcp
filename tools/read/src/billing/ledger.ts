import { defineTool } from '@hq/registry';
import { z } from 'zod';
import type { Degraded, ToolWarning } from '@hq/types';
import {
  EMPTY_LIST,
  asRecord,
  capLimit,
  listOut,
  noteOnce,
  num,
  readShmRows,
  settle,
  take,
  warn,
} from '../kit.js';
import type { PagedRows } from '../kit.js';

const MAX_LIMIT = 200;

/**
 * СКОЛЬКО СТРОК ЧИТАЕТСЯ ДЛЯ СВЕРКИ — И ПОЧЕМУ ЭТО НЕ `limit`.
 *
 * `limit` управляет ОКНОМ ПОКАЗА, и поднять его было нельзя: две сотни строк
 * этого инструмента на активном клиенте — это под сто тысяч символов ответа,
 * то есть окно упирается не в SHM, а в контекст вызывающего. Сверка же требует
 * ВСЕХ строк: `balance.computed` — это Σ платежей минус Σ оплаченных списаний,
 * и посчитанная по срезу она не «менее точна», а бессмысленна.
 *
 * Насколько бессмысленна: у клиента, чьи списания в окно не помещаются, два
 * разных `limit` дают дельты, отличающиеся и порядком, и ЗНАКОМ, а бонусная
 * сверка на меньшем окне выдумывает расхождение, которого нет. Обе — ложные
 * тревоги, и ни одно значение `limit` не превращает их в настоящую сверку:
 * пока список списаний длиннее окна показа, сверять нечего.
 *
 * Поэтому строки для сверки вычитываются постранично до полного покрытия
 * `items`, а наружу по-прежнему уезжает окно. 20 000 — потолок этого чтения,
 * а не ожидаемый размер. Упёрлись в него — сверка не выполняется вовсе
 * (`matches: null`), а не выполняется по огрызку.
 */
const RECONCILE_CAP = 20_000;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sum(rows: Record<string, unknown>[], keys: string[]): number {
  return round2(
    rows.reduce((acc, row) => {
      for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null) return acc + num(row[key]);
      }
      return acc;
    }, 0),
  );
}

interface Identity {
  recorded: number;
  /** Сумма по ПРОЧИТАННЫМ строкам. При `complete: false` — сумма среза. */
  computed: number;
  /**
   * `null` — сверка не проводилась. Это НЕ «расхождения нет» и не «расхождение
   * есть»: посчитать было не из чего, и число здесь означало бы утверждение,
   * которого никто не делал.
   */
  delta: number | null;
  matches: boolean | null;
  /** Покрыли ли прочитанные строки всю выборку, из которой считается `computed`. */
  complete: boolean;
}

function reconcile(recorded: number, computed: number, complete: boolean): Identity {
  const r = round2(recorded);
  const c = round2(computed);
  if (!complete) return { recorded: r, computed: c, delta: null, matches: null, complete: false };
  const delta = round2(r - c);
  return { recorded: r, computed: c, delta, matches: delta === 0, complete: true };
}

/**
 * Постранично прочитанный список — наружу окном, внутрь целиком.
 *
 * `items` берётся из ответа сервера (FOUND_ROWS), а не из длины прочитанного:
 * подмена первого вторым — это ровно то, как «показаны две сотни списаний из
 * тысячи» превращается в «у клиента две сотни списаний». Предупреждение об усечении ставит
 * `listOut` — по ОКНУ, потому что усечено именно оно; суммы при этом считаются
 * по полному набору строк и от окна не зависят.
 */
function pagedOut(
  paged: PagedRows,
  cap: number,
  warnings: ToolWarning[],
  label: string,
  degraded: Degraded[],
): { items: number; limit: number; offset: number; data: Record<string, unknown>[] } {
  if (paged.error !== null) noteOnce(degraded, 'shm', paged.error);
  return listOut(
    {
      items: paged.items ?? paged.rows.length,
      limit: cap,
      offset: 0,
      data: paged.rows.slice(0, cap),
    },
    warnings,
    label,
  );
}

/**
 * `Core::Withdraw::sum` — the method `User::recash` reconciles through —
 * counts only rows with `withdraw_date` set (Withdraw.pm:271:
 * `$args{where}{withdraw_date} ||= {'!=' => undef}`). The admin route this
 * tool reads applies no such filter, so unpaid rows arrive mixed in. An
 * unpaid row's `total` is `calc_withdraw`'s GROSS pre-bonus figure
 * (Billing.pm:229 `$wd{total} -= $wd{bonus}` runs against `bonus => 0` at
 * creation — `add_withdraw_next`, Billing.pm:186), never the money-only
 * quantity a paid row's `total` becomes once `is_pay` overwrites it — so
 * summing both together adds apples to oranges. Four shapes count as
 * "not settled" here: `null`, the key absent, `''`, and the MySQL
 * zero-date `'0000-00-00…'`.
 *
 * The last two deliberately over-exclude relative to SHM. Under
 * `Core::Withdraw::sum`'s SQL predicate a zero-date row is `IS NOT NULL`,
 * i.e. settled, and `Core::Withdraw::paid` (Withdraw.pm:182-185) is a plain
 * Perl truthiness test, under which `'0000-00-00 00:00:00'` is likewise
 * paid. Neither value can reach us — the column is `datetime DEFAULT NULL`
 * (shm_structure.sql:261), every insert path strips `withdraw_date` before
 * writing (`add_withdraw`, Billing.pm:172; `switch_to_next_service`,
 * Billing.pm:445), and MySQL 5.7+ `NO_ZERO_DATE` rejects the literal — so
 * the guard is unreachable belt-and-braces, not a correction to SHM. Do not
 * "fix" it into an inclusive check without re-deriving both predicates.
 */
function isSettled(row: Record<string, unknown>): boolean {
  const raw = row.withdraw_date;
  if (raw === null || raw === undefined) return false;
  const value = String(raw).trim();
  return value !== '' && !value.startsWith('0000-00-00');
}

export const billingLedger = defineTool({
  name: 'billing_ledger',
  description:
    'Money of one client: payments, bonuses, service withdraws and two independent ' +
    'reconciliations — money (users.balance against pays minus the money part of SETTLED ' +
    'withdraws) and bonus (users.bonus against the bonus ledger) — because SHM tracks them as ' +
    'two distinct ' +
    'columns with two distinct update paths (User::set_balance / set_bonus). A non-zero delta on ' +
    'either is a real finding: SHM does not recompute balance or bonus when a payment, bonus ' +
    'grant or withdraw row is deleted. THE TWO RECONCILIATIONS ARE COMPUTED OVER THE WHOLE ' +
    'LEDGER, NOT OVER THE ROWS RETURNED: each list is paged to completeness first, and `limit` ' +
    'controls only how many rows are printed. Where that paging could not cover the list, ' +
    '`delta` and `matches` come back null with `complete: false` — a balance computed from a ' +
    'slice says nothing about the client, and its delta changes sign with the size of the slice ' +
'(two different limits on the same client can yield deltas of opposite signs, and both are ' +
    'meaningless). `total` next to each list is the sum over everything ' +
    'read, `read` is how ' +
    'many rows that was, and `rows` is the printed window. `withdraws.total` counts settled rows ' +
    'only, mirroring ' +
    'SHM\'s own Core::Withdraw::sum; pending charges are reported separately as ' +
    '`withdraws.unsettled`, whose gross_total is an upper bound on the coming balance drop ' +
    'because part of it may be covered from bonus at payment time. One field is renamed on the ' +
    "way out: a payment's `uniq_key` (the payment-system transaction id SHM dedupes on) is " +
    'returned as `uniq_id` — under its own name the redaction rule for secrets, which matches on ' +
    'the field name and claims anything containing "key", replaced the value with <redacted>.',
  input: z.object({
    shm_user_id: z.number().int().positive(),
    limit: z.number().int().default(50).describe('Rows per list, capped at 200'),
  }),
  access: 'ro',
  risk: 'low',
  profiles: ['human', 'bot'],
  backends: ['shm'],
  handler: async ({ shm_user_id, limit }, ctx) => {
    const cap = capLimit(limit, 50, MAX_LIMIT);
    const warnings: ToolWarning[] = [];
    const degraded: Degraded[] = [];

    // Три ленты читаются ДО КОНЦА (RECONCILE_CAP), а не окном `cap`: суммы, из
    // которых складывается сверка, считаются по всем строкам клиента, и только
    // показ ограничен окном. readShmRows не бросает — неудача приезжает полем
    // `error` вместе с тем, что успели прочитать до неё.
    const [user, pays, bonuses, withdraws] = await Promise.all([
      settle(ctx.shm.list<Record<string, unknown>>('/admin/user', { user_id: shm_user_id, limit: 1 })),
      readShmRows(ctx.shm, '/admin/user/pay', { user_id: shm_user_id }, RECONCILE_CAP),
      readShmRows(ctx.shm, '/admin/user/bonus', { user_id: shm_user_id }, RECONCILE_CAP),
      readShmRows(ctx.shm, '/admin/user/service/withdraw', { user_id: shm_user_id }, RECONCILE_CAP),
    ]);

    // items наружу (§6.4): показанное окно — это окно, а не клиент, и
    // предупреждение об этом обязано быть в ответе.
    const payList = pagedOut(pays, cap, warnings, 'payments', degraded);
    const bonusList = pagedOut(bonuses, cap, warnings, 'bonuses', degraded);
    const withdrawList = pagedOut(withdraws, cap, warnings, 'withdraws', degraded);
    const payRows = pays.rows;
    const bonusRows = bonuses.rows;
    const withdrawRows = withdraws.rows;
    const userRow = asRecord(take(user, 'shm', degraded, EMPTY_LIST).data[0]);

    const paid = sum(payRows, ['money', 'total']);
    const bonusGranted = sum(bonusRows, ['bonus', 'money', 'total']);
    // Verified against SHM source (shm-fork-from-orig): a withdraw row's
    // `total` is NOT "gross cost, of which `bonus` is a part". Core::Billing
    // ::is_pay splits the original cost via calc_payment and OVERWRITES
    // `total` with only the money part at the moment of payment
    // (app/lib/Core/Billing.pm, calc_payment L264-269, is_pay L279-306 with
    // the overwriting `$wd->set` at L300-304):
    //   if ( $bonus >= $total ) { $bonus = $total; $total = 0 }
    //   else { $total -= $bonus }
    //   ...
    //   $wd->set( bonus => $bonus, total => $total, withdraw_date => now );
    // `total` and `bonus` on a paid row are disjoint and sum to the original
    // cost — never total-inclusive-of-bonus. So the money identity sums
    // `total` alone; subtracting `bonus` again would double-give it back.
    // But only for SETTLED rows — see isSettled().
    const settledRows = withdrawRows.filter(isSettled);
    const unsettledRows = withdrawRows.filter((row) => !isSettled(row));
    const spentMoney = sum(settledRows, ['total', 'cost', 'money']);
    const unsettledGross = sum(unsettledRows, ['total', 'cost', 'money']);
    // Every bonus-funded withdraw already writes its own negative row to
    // bonus_history through User::set_bonus, called from the same is_pay
    // (Billing.pm ~L297: `set_bonus( bonus => -$bonus, comment => {
    // withdraw_id => $wd->id } )`) — so summing bonus_history alone already
    // nets out bonus spent on withdraws. Subtracting withdraw.bonus again
    // would double-count it. User::recash (User.pm ~L1038-1057) makes the
    // same call deliberately: it computes `bonus_total - wd_bonus`, then
    // discards it in favour of plain `bonus_total`, with a comment warning
    // that bonus_history "also contains withdraws data".
    const bonusComputed = bonusGranted;

    // Gated per identity, not on the aggregate `degraded`: the money
    // identity is fed by user/pays/withdraws, the bonus identity by
    // user/bonuses alone. A failed bonus fetch must not silence a real
    // money mismatch, and a failed pay/withdraw fetch must not silence a
    // real bonus mismatch — each finding stands on its own inputs.
    //
    // ПОЛНОТА ЗДЕСЬ — ЭТО ПОКРЫТИЕ, А НЕ «ЗАПРОС НЕ УПАЛ». Прежняя проверка
    // читалась как второе (`pays.ok && withdraws.ok`) и пропускала ровно тот
    // случай, ради которого вообще существует: все запросы успешны, а строк
    // прочитано меньше, чем их есть. `complete` у readShmRows — это
    // `items !== null && прочитано >= items`, то есть сверка объявляется
    // сделанной только там, где сервер сам назвал размер выборки и мы его
    // покрыли.
    const moneyComplete = user.ok && pays.complete && withdraws.complete;
    const bonusComplete = user.ok && bonuses.complete;

    const balance = reconcile(num(userRow.balance), paid - spentMoney, moneyComplete);
    const bonus = reconcile(num(userRow.bonus), bonusComputed, bonusComplete);

    if (balance.matches === false) {
      warnings.push(
        warn(
          'balance_mismatch',
          `Stored balance ${String(balance.recorded)} does not match the money ledger ` +
            `${String(balance.computed)} (delta ${String(balance.delta)}). The usual cause is ` +
            'deleting a payment or a withdraw: DELETE /admin/user/pay or DELETE ' +
            '/admin/user/service/withdraw is a plain DELETE FROM the ledger table and never ' +
            'touches users.balance, so history and balance drift apart permanently. This is a ' +
            'finding about every payment and every settled withdraw the client has, not about ' +
            'the rows shown below: the ledger was paged to completeness before comparing, and ' +
            'the window only limits what is printed.',
        ),
      );
    }
    if (bonus.matches === false) {
      warnings.push(
        warn(
          'bonus_mismatch',
          `Stored bonus ${String(bonus.recorded)} does not match the bonus ledger ` +
            `${String(bonus.computed)} (delta ${String(bonus.delta)}). The usual cause is ` +
            'deleting a bonus grant: DELETE /admin/user/bonus is a plain DELETE FROM ' +
            'bonus_history and never touches users.bonus, so history and the bonus balance drift ' +
            'apart permanently. Computed over the whole bonus ledger, not over the window below.',
        ),
      );
    }
    /**
     * Сверка НЕ СДЕЛАНА — и это отдельный факт, у которого своё имя.
     *
     * Раньше на этом месте выдавался вердикт: суммы считались по окну, а
     * `matches: false` печатался как утверждение. На клиенте, чьи списания не
     * помещаются в окно, это давало два разных ответа с разными знаками про
     * один и тот же баланс — оба неверные. Пустая ветка молчания
     * здесь была бы не лучше: «предупреждений нет» читается как «сверено и
     * сошлось».
     */
    const unreconciled: string[] = [];
    if (!moneyComplete && user.ok) unreconciled.push('money');
    if (!bonusComplete && user.ok) unreconciled.push('bonus');
    if (unreconciled.length > 0 && degraded.length === 0) {
      warnings.push(
        warn(
          'reconciliation_incomplete',
          `Not reconciled: ${unreconciled.join(' and ')}. The ledger rows behind ` +
            `${unreconciled.length === 1 ? 'that identity' : 'those identities'} could not be read ` +
            `to completeness (ceiling ${String(RECONCILE_CAP)} rows per list; payments ` +
            `${String(pays.rows.length)}/${pays.items === null ? '?' : String(pays.items)}, ` +
            `bonuses ${String(bonuses.rows.length)}/` +
            `${bonuses.items === null ? '?' : String(bonuses.items)}, withdraws ` +
            `${String(withdraws.rows.length)}/` +
            `${withdraws.items === null ? '?' : String(withdraws.items)}), so `+
            '`delta` and `matches` are null. Null is not "no mismatch" and not "mismatch" — a ' +
            'balance computed from part of the ledger carries no information about the whole of ' +
            'it, and the sign of such a delta flips with the size of the slice.',
        ),
      );
    }
    if (degraded.length > 0) {
      const skipped: string[] = [];
      if (!moneyComplete) skipped.push('the money reconciliation');
      if (!bonusComplete) skipped.push('the bonus reconciliation');
      warnings.push(
        warn(
          'partial_result',
          'One of the systems needed for this ledger did not answer (see `degraded`); its rows ' +
            `and totals are empty rather than wrong. Skipped for the same reason: ` +
            `${skipped.join(', ')} — comparing a full recorded value against a partial ledger ` +
            'would manufacture a mismatch that is not really there.',
        ),
      );
    }

    // `total` считается по ВСЕМ прочитанным строкам, `rows` — окно показа.
    // Числа намеренно разной природы, и путать их нельзя: сумма по окну — это
    // и есть та ложная сверка, ради устранения которой инструмент теперь
    // страничает. `read` рядом с каждым списком говорит, сколько строк стоит
    // за суммой, чтобы «total по видимой части списка» нельзя было прочитать
    // как итог по клиенту.
    return {
      balance,
      bonus,
      payments: {
        total: paid,
        items: payList.items,
        limit: payList.limit,
        read: payRows.length,
        rows: payList.data,
      },
      bonuses: {
        total: bonusGranted,
        items: bonusList.items,
        limit: bonusList.limit,
        read: bonusRows.length,
        rows: bonusList.data,
      },
      withdraws: {
        total: spentMoney,
        items: withdrawList.items,
        limit: withdrawList.limit,
        read: withdrawRows.length,
        rows: withdrawList.data,
        // Factual, not a warning: a pending charge is normal operation, but
        // the operator asking "why is his balance about to drop" needs the
        // number somewhere. `gross_total` is an upper bound on that drop,
        // not the drop itself — calc_payment (Billing.pm:264-269) may cover
        // part of it from bonus when the row is finally paid.
        unsettled: { rows: unsettledRows.length, gross_total: unsettledGross },
      },
      warnings,
      degraded,
    };
  },
});
