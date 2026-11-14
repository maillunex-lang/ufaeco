import { DomainError } from '../errors.js';
import type { Queryable } from '../persistence/db.js';
import { ENTERPRISE_KINDS, MAX_COMPANIES_PER_PLAYER, PRODUCTS, STARTING_CAPITAL_CENTS, type EnterpriseKind } from './catalog.js';

export interface CompanyView {
  id: string;
  name: string;
  owner_player_id: string;
  balance_cents: number;
  status: string;
}

const unique = (e: unknown, code: string, byConstraint: Record<string, string> = {}) => {
  const err = e as { code?: string; constraint?: string };
  if (err.code === '23505') throw new DomainError(byConstraint[err.constraint ?? ''] ?? code);
  throw e;
};

/**
 * Компании, баланс (через журнал операций), инвентарь и предприятия.
 * Любое изменение денег/товаров идёт только через методы этого сервиса внутри транзакции команды.
 */
export class CompanyService {
  async create(tx: Queryable, playerId: string, name: string): Promise<CompanyView> {
    // Блокировка строки игрока сериализует создание компаний и делает лимит неуязвимым к гонкам.
    await tx.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    const n = (await tx.query<{ n: number }>('SELECT count(*)::int n FROM companies WHERE owner_player_id = $1', [playerId])).rows[0]!.n;
    if (n >= MAX_COMPANIES_PER_PLAYER) throw new DomainError('limit_reached');
    let id: string;
    try {
      id = (await tx.query<{ id: string }>('INSERT INTO companies (owner_player_id, name) VALUES ($1, $2) RETURNING id', [playerId, name])).rows[0]!.id;
    } catch (e) {
      return unique(e, 'company_name_taken');
    }
    await this.credit(tx, id, STARTING_CAPITAL_CENTS, 'starting_capital', playerId, {});
    return this.getOwned(tx, playerId, id);
  }

  /** Возвращает компанию только владельцу: чужая → forbidden, несуществующая → not_found. */
  async getOwned(tx: Queryable, playerId: string, companyId: string, lock = false): Promise<CompanyView> {
    const r = await tx.query<CompanyView & { balance_cents: string }>(
      `SELECT id, name, owner_player_id, balance_cents, status FROM companies WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [companyId],
    );
    const row = r.rows[0];
    if (!row) throw new DomainError('not_found');
    if (row.owner_player_id !== playerId) throw new DomainError('forbidden');
    return { ...row, balance_cents: Number(row.balance_cents) };
  }

  assertActive(c: CompanyView): void {
    if (c.status !== 'active') throw new DomainError('company_bankrupt');
  }

  async listOwned(tx: Queryable, playerId: string): Promise<CompanyView[]> {
    const r = await tx.query<CompanyView & { balance_cents: string }>(
      'SELECT id, name, owner_player_id, balance_cents, status FROM companies WHERE owner_player_id = $1 ORDER BY created_at, id',
      [playerId],
    );
    return r.rows.map((x) => ({ ...x, balance_cents: Number(x.balance_cents) }));
  }

  async credit(tx: Queryable, companyId: string, cents: number, reason: string, playerId: string | null, details: Record<string, unknown>): Promise<number> {
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('credit: сумма должна быть положительным целым');
    const r = await tx.query<{ balance_cents: string }>('UPDATE companies SET balance_cents = balance_cents + $2 WHERE id = $1 RETURNING balance_cents', [companyId, cents]);
    const after = Number(r.rows[0]!.balance_cents);
    await this.entry(tx, companyId, playerId, cents, after, reason, details);
    return after;
  }

  /** Атомарное списание: условие balance >= сумма проверяется в самом UPDATE. */
  async debit(tx: Queryable, companyId: string, cents: number, reason: string, playerId: string | null, details: Record<string, unknown>): Promise<number> {
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('debit: сумма должна быть положительным целым');
    const r = await tx.query<{ balance_cents: string }>(
      'UPDATE companies SET balance_cents = balance_cents - $2 WHERE id = $1 AND balance_cents >= $2 RETURNING balance_cents',
      [companyId, cents],
    );
    if (r.rowCount === 0) throw new DomainError('insufficient_funds');
    const after = Number(r.rows[0]!.balance_cents);
    await this.entry(tx, companyId, playerId, -cents, after, reason, details);
    return after;
  }

  private async entry(tx: Queryable, companyId: string, playerId: string | null, amount: number, after: number, reason: string, details: Record<string, unknown>) {
    await tx.query(
      'INSERT INTO ledger_entries (company_id, player_id, amount_cents, balance_after_cents, reason, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [companyId, playerId, amount, after, reason, JSON.stringify(details)],
    );
  }

  async journal(tx: Queryable, companyId: string, limit: number) {
    const r = await tx.query(
      `SELECT id, amount_cents, balance_after_cents, reason, details, created_at
         FROM ledger_entries WHERE company_id = $1 ORDER BY id DESC LIMIT $2`,
      [companyId, limit],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      amount_cents: Number(x.amount_cents),
      balance_after_cents: Number(x.balance_after_cents),
      reason: x.reason as string,
      details: x.details as Record<string, unknown>,
      created_at: (x.created_at as Date).toISOString(),
    }));
  }

  // ---- инвентарь (серверный API; клиентской команды «выдать товар» не существует)

  async inventory(tx: Queryable, companyId: string): Promise<Record<string, number>> {
    const r = await tx.query<{ product_id: string; quantity: string }>('SELECT product_id, quantity FROM inventory_items WHERE company_id = $1 AND quantity > 0 ORDER BY product_id', [companyId]);
    return Object.fromEntries(r.rows.map((x) => [x.product_id, Number(x.quantity)]));
  }

  async addInventory(tx: Queryable, companyId: string, productId: string, qty: number): Promise<void> {
    if (!(PRODUCTS as readonly string[]).includes(productId)) throw new DomainError('unknown_product');
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('addInventory: количество должно быть положительным целым');
    await tx.query(
      `INSERT INTO inventory_items (company_id, product_id, quantity) VALUES ($1,$2,$3)
       ON CONFLICT (company_id, product_id) DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity`,
      [companyId, productId, qty],
    );
  }

  async removeInventory(tx: Queryable, companyId: string, productId: string, qty: number): Promise<void> {
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('removeInventory: количество должно быть положительным целым');
    const r = await tx.query('UPDATE inventory_items SET quantity = quantity - $3 WHERE company_id = $1 AND product_id = $2 AND quantity >= $3', [companyId, productId, qty]);
    if (r.rowCount === 0) throw new DomainError('insufficient_inventory');
  }

  // ---- предприятия

  async createEnterprise(tx: Queryable, playerId: string, companyId: string, kind: EnterpriseKind, name: string, buildingId: string | null = null) {
    this.assertActive(await this.getOwned(tx, playerId, companyId, true)); // FOR UPDATE: сериализует списания компании
    let id: string;
    try {
      id = (await tx.query<{ id: string }>('INSERT INTO enterprises (company_id, kind, name, building_id) VALUES ($1,$2,$3,$4) RETURNING id', [companyId, kind, name, buildingId])).rows[0]!.id;
    } catch (e) {
      return unique(e, 'enterprise_name_taken');
    }
    const balance = await this.debit(tx, companyId, ENTERPRISE_KINDS[kind], 'enterprise_created', playerId, { enterprise_id: id, kind, name, building_id: buildingId });
    return { id, company_id: companyId, kind, name, building_id: buildingId, cost_cents: ENTERPRISE_KINDS[kind], balance_cents: balance };
  }

  async enterprises(tx: Queryable, companyId: string) {
    const r = await tx.query<{ id: string; kind: string; name: string; building_id: string | null; city_id: string | null; x: number | null; y: number | null }>(
      `SELECT e.id, e.kind, e.name, e.building_id, b.city_id, b.x, b.y FROM enterprises e LEFT JOIN buildings b ON b.id = e.building_id WHERE e.company_id = $1 ORDER BY e.seq`,
      [companyId],
    );
    return r.rows;
  }
}
