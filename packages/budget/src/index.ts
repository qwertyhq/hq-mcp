export class BudgetExceededError extends Error {
  readonly key: string;
  readonly resetAt: Date;

  constructor(key: string, resetAt: Date, message: string) {
    super(message);
    this.name = 'BudgetExceededError';
    this.key = key;
    this.resetAt = resetAt;
  }
}

interface Bucket {
  count: number;
  resetAt: number;
  blocked: boolean;
}

export interface KeyLimit {
  limit: number;
  windowMs: number;
}

/**
 * Отдельные счётчики SHM (§6.14) — те, которые SHM ведёт у себя и по которым
 * блокирует. Ключи ТОЧНЫЕ и включают метод, а не подстрочные: до правки
 * здесь стояли внутренние имена счётчиков SHM ('user-auth', 'user-reg',
 * 'usobject-create'), которых в ключе ведра нет и быть не может — докстринг
 * рядом сам показывал ключ 'shm:POST:/user/auth', в котором подстрока
 * 'user-auth' не встречается. Ни одно правило не срабатывало никогда.
 *
 * Подстрока здесь не годится и по существу: нужный маршрут регистрации — это
 * PUT /user (v1.cgi:75-81, метод reg_api_safe), и подстрока '/user' накрыла бы
 * заодно весь /user/* и половину админского API.
 *
 * Соответствие маршрутам и окнам взято из самих вызовов
 * set_user_fail_attempt: Core/User.pm:243 'auth_api_safe', 180 — POST /user/auth
 * (v1.cgi:95-99); Core/User.pm:765 'reg_api_safe', 3600 — PUT /user;
 * Core/USObject.pm:1024 'create_for_api_safe', 600 — PUT /service/order
 * (v1.cgi:409-411).
 *
 * reg инкрементируется на УСПЕХЕ, поэтому «5 в час» — это буквально пять
 * успешных регистраций, а не пять попыток.
 */
export const SHM_PER_KEY_LIMITS: Record<string, KeyLimit> = {
  'shm:POST:/user/auth': { limit: 5, windowMs: 180_000 },
  'shm:PUT:/user': { limit: 5, windowMs: 3_600_000 },
  'shm:PUT:/service/order': { limit: 5, windowMs: 600_000 },
};

/**
 * Маршруты, которые читаются ЦЕЛИКОМ, а не по одной строке. Общий гейт (30
 * запросов в минуту, packages/env/src/index.ts:171-172) откалиброван под
 * поштучные чтения инструментов «про одного клиента»; батчевой сверке он
 * запрещает даже начать. На установке с тысячами клиентов и тысячами услуг
 * полная вычитка — это десятки страниц по 500 строк на таблицу (500 — максимум
 * одного запроса SHM, packages/shm/src/client.ts:16), то есть по нескольку
 * десятков запросов на каждый из двух ключей против общего лимита в 30.
 * Инструмент, который не может дочитать то, что сверяет, отдаёт честный и
 * бесполезный ответ.
 *
 * Лимит здесь — это потолок МАРШРУТА, а не квота инструмента: бэкенду
 * безразлично, кто его позвал, и правильная гранулярность защиты — «сколько
 * раз в минуту этот путь можно дёрнуть». Для панели 300/60с — ровно то, что
 * разрешает собственный темп §7.6: пауза 200 мс между страницами физически не
 * даёт больше пяти запросов в секунду.
 *
 * Ключи сопоставляются ТОЧНО (exactKeyLimits), а не по вхождению подстроки:
 * 'shm:GET:/admin/user' как подстрока накрыл бы и /admin/user/pay, и
 * /admin/user/bonus, и /admin/user/search, молча раздав батчевый потолок
 * половине админского API.
 */
export const BATCH_LIST_LIMITS: Record<string, KeyLimit> = {
  'shm:GET:/admin/user': { limit: 120, windowMs: 60_000 },
  'shm:GET:/admin/user/service': { limit: 120, windowMs: 60_000 },
  'remna:GET:/api/users': { limit: 300, windowMs: 60_000 },
};

/**
 * Локальный гейт запросов. Держит нас ниже порогов SHM/Remnawave, не дожидаясь 429.
 *
 * Ведро rate-limit в SHM — одно на весь сервис: ключ считается по IP, а весь трафик
 * Mini App приходит с одного mesh-адреса ingress, и счётчики не декрементируются
 * (§6.14, случившийся инцидент: 5 неудач ОДНОГО пользователя обернулись сотнями
 * отказов 429 у всех остальных).
 * Поэтому получив 429 мы не ретраим вообще: вызывающий обязан дождаться окна.
 */
export class Budget {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => Date;
  private readonly perKeyLimits: Record<string, KeyLimit>;
  private readonly exactKeyLimits: Record<string, KeyLimit>;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: {
    limit: number;
    windowMs: number;
    now?: () => Date;
    perKeyLimits?: Record<string, KeyLimit>;
    /** Правила по ТОЧНОМУ ключу ведра; проверяются раньше подстрочных. */
    exactKeyLimits?: Record<string, KeyLimit>;
  }) {
    if (opts.limit <= 0) throw new Error('Budget limit must be positive');
    if (opts.windowMs <= 0) throw new Error('Budget windowMs must be positive');
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? (() => new Date());
    this.perKeyLimits = opts.perKeyLimits ?? {};
    this.exactKeyLimits = opts.exactKeyLimits ?? {};
  }

  /**
   * Точное правило (BATCH_LIST_LIMITS) важнее подстрочного (§6.14): подстрока
   * — удобный способ накрыть семейство маршрутов одним словом, но именно
   * поэтому она не годится, когда потолок поднимается ровно для одного пути.
   * `Object.hasOwn`, а не `!== undefined`: ключ ведра приходит извне, и
   * 'toString' нашёлся бы в прототипе как «настроенный лимит».
   */
  private limitsFor(key: string): KeyLimit {
    if (Object.hasOwn(this.exactKeyLimits, key)) {
      const exact = this.exactKeyLimits[key];
      if (exact !== undefined) return exact;
    }
    for (const [needle, limits] of Object.entries(this.perKeyLimits)) {
      if (key.includes(needle)) return limits;
    }
    return { limit: this.limit, windowMs: this.windowMs };
  }

  take(key: string): void {
    const t = this.now().getTime();
    const limits = this.limitsFor(key);
    const bucket = this.buckets.get(key);
    if (bucket === undefined || t >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: t + limits.windowMs, blocked: false });
      return;
    }
    const resetAt = new Date(bucket.resetAt);
    if (bucket.blocked) {
      throw new BudgetExceededError(
        key,
        resetAt,
        `"${key}" is locked until ${resetAt.toISOString()}: the backend already answered 429. ` +
          'The rate-limit bucket is shared by the whole service and does not decay, ' +
          'so the request is refused instead of being repeated.',
      );
    }
    if (bucket.count >= limits.limit) {
      throw new BudgetExceededError(
        key,
        resetAt,
        `Local request budget for "${key}" is spent (${limits.limit} per ${limits.windowMs} ms). ` +
          `Wait until ${resetAt.toISOString()}: the rate-limit bucket is shared by the whole ` +
          'service and real clients get 429 when we burn it.',
      );
    }
    bucket.count += 1;
  }

  note429(key: string): void {
    const t = this.now().getTime();
    const limits = this.limitsFor(key);
    this.buckets.set(key, { count: limits.limit, resetAt: t + limits.windowMs, blocked: true });
  }

  state(): Record<string, { count: number; resetAt: string }> {
    const t = this.now().getTime();
    const out: Record<string, { count: number; resetAt: string }> = {};
    for (const [key, bucket] of this.buckets) {
      if (t >= bucket.resetAt) {
        this.buckets.delete(key);
        continue;
      }
      out[key] = { count: bucket.count, resetAt: new Date(bucket.resetAt).toISOString() };
    }
    return out;
  }
}
