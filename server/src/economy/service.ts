import { CompanyService } from '../companies/index.js';
import { ENTERPRISE_KINDS, ENTERPRISE_ZONES, PRODUCTS, type EnterpriseKind, type ProductId } from '../companies/catalog.js';
import { DomainError } from '../errors.js';
import { writeAudit } from '../persistence/audit.js';
import { withTransaction, type Db, type Queryable } from '../persistence/db.js';
import {
  BASE_PRICES_CENTS, BASELINE_UNITS, INSOLVENCY_DAYS, LOAN_RATE_BPS_PER_DAY, MAX_LOAN_CENTS, MAX_TRADE_UNITS,
  MISSED_WAGE_DAYS_LIMIT, NPC, NPC_MIN_FUNDS_CENTS, NPC_SPREAD_BPS, RECIPES, RESIDENT_BREAD_DEMAND, SALES_TAX_BPS,
  SHOP_CAPACITY_UNITS, WAGES_CENTS,
} from './catalog.js';
import { nextPrice } from './pricing.js';

const DAY_LOCK = 727_003;

export interface PriceRow {
  product_id: string;
  price_cents: number;
  base_price_cents: number;
  last_supply: number;
  last_demand: number;
}

export interface DaySummary {
  day: number;
  produced: Record<string, number>;
  consumed: Record<string, number>;
  wages_paid_cents: number;
  idle_enterprises: number;
  retail_units_sold: number;
  retail_revenue_cents: number;
  taxes_cents: number;
  interest_accrued_cents: number;
  bankruptcies: string[];
  prices: Record<string, number>;
}

const add = (m: Record<string, number>, k: string, v: number) => (m[k] = (m[k] ?? 0) + v);

export class EconomyService {
  constructor(private readonly companies: CompanyService) {}

  /** Создаёт NPC-компании и начальные цены. Идемпотентно. */
  async bootstrap(db: Db): Promise<void> {
    await withTransaction(db, async (tx) => {
      for (const n of Object.values(NPC)) {
        await tx.query(
          'INSERT INTO companies (id, owner_player_id, name, is_npc) VALUES ($1, NULL, $2, true) ON CONFLICT (id) DO NOTHING',
          [n.id, n.name],
        );
      }
      for (const p of PRODUCTS) {
        await tx.query(
          'INSERT INTO market_prices (product_id, base_price_cents, price_cents) VALUES ($1, $2, $2) ON CONFLICT (product_id) DO NOTHING',
          [p, BASE_PRICES_CENTS[p]],
        );
      }
    });
  }

  async currentDay(q: Queryable): Promise<number> {
    return Number((await q.query<{ d: string | null }>('SELECT max(day) d FROM economy_days WHERE finished_at IS NOT NULL')).rows[0]!.d ?? 0);
  }

  async getPrices(q: Queryable): Promise<PriceRow[]> {
    const r = await q.query('SELECT product_id, price_cents, base_price_cents, last_supply, last_demand FROM market_prices ORDER BY product_id');
    return r.rows.map((x) => ({
      product_id: x.product_id, price_cents: Number(x.price_cents), base_price_cents: Number(x.base_price_cents),
      last_supply: Number(x.last_supply), last_demand: Number(x.last_demand),
    }));
  }

  private async price(tx: Queryable, product: string): Promise<number> {
    const r = await tx.query<{ price_cents: string }>('SELECT price_cents FROM market_prices WHERE product_id = $1', [product]);
    if (!r.rows[0]) throw new DomainError('unknown_product');
    return Number(r.rows[0].price_cents);
  }

  /** Страховка ликвидности NPC: при нехватке средств зачисляет «эмиссию» через журнал. */
  private async ensureNpcFunds(tx: Queryable, id: string): Promise<void> {
    const bal = Number((await tx.query<{ b: string }>('SELECT balance_cents b FROM companies WHERE id = $1 FOR UPDATE', [id])).rows[0]!.b);
    if (bal < NPC_MIN_FUNDS_CENTS / 2) await this.companies.credit(tx, id, NPC_MIN_FUNDS_CENTS, 'npc_endowment', null, {});
  }

  // ------------------------------------------------------------------ торговля с NPC

  /** Сделка с региональным торговым домом (NPC) по текущей цене ± спред. Это НЕ рынок игроков (этап 4). */
  async trade(tx: Queryable, playerId: string, companyId: string, product: ProductId, side: 'buy' | 'sell', qty: number) {
    if (qty < 1 || qty > MAX_TRADE_UNITS) throw new DomainError('invalid_payload');
    const company = await this.companies.getOwned(tx, playerId, companyId, true);
    this.companies.assertActive(company);
    const price = await this.price(tx, product);
    await this.ensureNpcFunds(tx, NPC.trader.id);
    if (side === 'buy') {
      const unit = Math.ceil((price * (10_000 + NPC_SPREAD_BPS)) / 10_000);
      const total = unit * qty;
      const balance = await this.companies.debit(tx, companyId, total, 'npc_trade_buy', playerId, { product, qty, unit_price_cents: unit });
      await this.companies.credit(tx, NPC.trader.id, total, 'npc_trade_buy', null, { company_id: companyId, product, qty });
      await this.companies.addInventory(tx, companyId, product, qty);
      await tx.query('UPDATE market_prices SET demand_today = demand_today + $2 WHERE product_id = $1', [product, qty]);
      return { side, product_id: product, quantity: qty, unit_price_cents: unit, total_cents: total, balance_cents: balance };
    }
    const unit = Math.floor((price * (10_000 - NPC_SPREAD_BPS)) / 10_000);
    const total = unit * qty;
    await this.companies.removeInventory(tx, companyId, product, qty);
    const balance = await this.companies.credit(tx, companyId, total, 'npc_trade_sell', playerId, { product, qty, unit_price_cents: unit });
    await this.companies.debit(tx, NPC.trader.id, total, 'npc_trade_sell', null, { company_id: companyId, product, qty });
    await tx.query('UPDATE market_prices SET supply_today = supply_today + $2 WHERE product_id = $1', [product, qty]);
    return { side, product_id: product, quantity: qty, unit_price_cents: unit, total_cents: total, balance_cents: balance };
  }

  // ------------------------------------------------------------------ кредиты

  async getLoan(tx: Queryable, companyId: string): Promise<number> {
    const r = await tx.query<{ b: string }>('SELECT balance_cents b FROM loans WHERE company_id = $1', [companyId]);
    return Number(r.rows[0]?.b ?? 0);
  }

  async takeLoan(tx: Queryable, playerId: string, companyId: string, amount: number) {
    const c = await this.companies.getOwned(tx, playerId, companyId, true);
    this.companies.assertActive(c);
    const current = await this.getLoan(tx, companyId);
    if (amount <= 0 || current + amount > MAX_LOAN_CENTS) throw new DomainError('loan_limit_exceeded');
    await this.ensureNpcFunds(tx, NPC.bank.id);
    await tx.query(
      'INSERT INTO loans (company_id, balance_cents) VALUES ($1, $2) ON CONFLICT (company_id) DO UPDATE SET balance_cents = loans.balance_cents + $2',
      [companyId, amount],
    );
    await this.companies.debit(tx, NPC.bank.id, amount, 'loan_issued', null, { company_id: companyId });
    const balance = await this.companies.credit(tx, companyId, amount, 'loan_received', playerId, {});
    return { loan_cents: current + amount, balance_cents: balance, max_loan_cents: MAX_LOAN_CENTS };
  }

  async repayLoan(tx: Queryable, playerId: string, companyId: string, amount: number) {
    const c = await this.companies.getOwned(tx, playerId, companyId, true);
    const current = await this.getLoan(tx, companyId);
    if (amount <= 0 || amount > current) throw new DomainError('invalid_amount');
    const balance = await this.companies.debit(tx, companyId, amount, 'loan_repayment', playerId, {});
    await this.companies.credit(tx, NPC.bank.id, amount, 'loan_repayment', null, { company_id: c.id });
    await tx.query('UPDATE loans SET balance_cents = balance_cents - $2 WHERE company_id = $1', [companyId, amount]);
    return { loan_cents: current - amount, balance_cents: balance, max_loan_cents: MAX_LOAN_CENTS };
  }

  // ------------------------------------------------------------------ экономический день

  /**
   * Один экономический день в одной транзакции: зарплаты → производство → розница → налоги →
   * проценты по кредитам → проверка банкротств → пересчёт цен. Сериализуется advisory-локом.
   * `scope.companyIds` сужает набор обрабатываемых компаний (для тестов); цены считаются всегда глобально.
   */
  async runDay(db: Db, scope: { companyIds?: string[] } = {}): Promise<DaySummary> {
    return withTransaction(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [DAY_LOCK]);
      const day = Number((await tx.query<{ d: string | null }>('SELECT max(day) d FROM economy_days')).rows[0]!.d ?? 0) + 1;
      await tx.query('INSERT INTO economy_days (day) VALUES ($1)', [day]);

      const priceRows = (await tx.query('SELECT product_id, base_price_cents, price_cents, supply_today, demand_today FROM market_prices ORDER BY product_id FOR UPDATE')).rows;
      const price: Record<string, number> = {};
      const supply: Record<string, number> = {};
      const demand: Record<string, number> = {};
      for (const r of priceRows) {
        price[r.product_id] = Number(r.price_cents);
        supply[r.product_id] = Number(r.supply_today);
        demand[r.product_id] = Number(r.demand_today);
      }

      const sum: DaySummary = {
        day, produced: {}, consumed: {}, wages_paid_cents: 0, idle_enterprises: 0, retail_units_sold: 0,
        retail_revenue_cents: 0, taxes_cents: 0, interest_accrued_cents: 0, bankruptcies: [], prices: {},
      };

      const filter = scope.companyIds ? 'AND c.id = ANY($1::uuid[])' : '';
      const cs = (await tx.query<{ id: string }>(
        `SELECT c.id FROM companies c WHERE NOT c.is_npc AND c.status = 'active' ${filter}
            AND (EXISTS (SELECT 1 FROM enterprises e WHERE e.company_id = c.id)
              OR EXISTS (SELECT 1 FROM loans l WHERE l.company_id = c.id AND l.balance_cents > 0))
          ORDER BY c.id FOR UPDATE OF c`,
        scope.companyIds ? [scope.companyIds] : [],
      )).rows.map((r) => r.id);

      const shops: { companyId: string; stock: number }[] = [];
      const missed = new Set<string>();

      for (const companyId of cs) {
        const inv = await this.companies.inventory(tx, companyId);
        const ents = (await tx.query<{ kind: EnterpriseKind }>('SELECT kind FROM enterprises WHERE company_id = $1 ORDER BY seq', [companyId])).rows;
        let paidAll = true;
        for (const e of ents) {
          const wage = WAGES_CENTS[e.kind];
          let operating = true;
          try {
            await this.companies.debit(tx, companyId, wage, 'wages', null, { kind: e.kind, day });
            sum.wages_paid_cents += wage;
          } catch (err) {
            if (!(err instanceof DomainError)) throw err;
            operating = false;
            paidAll = false;
            sum.idle_enterprises += 1;
          }
          if (!operating) continue;
          const recipe = RECIPES[e.kind];
          if (recipe) {
            const ok = Object.entries(recipe.inputs).every(([p, q]) => (inv[p] ?? 0) >= (q ?? 0));
            if (!ok) { sum.idle_enterprises += 1; continue; }
            for (const [p, q] of Object.entries(recipe.inputs)) {
              await this.companies.removeInventory(tx, companyId, p, q!);
              inv[p] = (inv[p] ?? 0) - q!;
              add(sum.consumed, p, q!); add(demand, p, q!);
            }
            for (const [p, q] of Object.entries(recipe.outputs)) {
              await this.companies.addInventory(tx, companyId, p, q!);
              inv[p] = (inv[p] ?? 0) + q!;
              add(sum.produced, p, q!); add(supply, p, q!);
            }
          }
          if (e.kind === 'shop') shops.push({ companyId, stock: inv.bread ?? 0 });
        }
        if (!paidAll) missed.add(companyId);
      }

      // Розница: жители покупают хлеб; доля магазина пропорциональна его предложению.
      add(demand, 'bread', RESIDENT_BREAD_DEMAND);
      const offers = new Map<string, number>(); // companyId -> единиц хлеба на продажу (все магазины компании)
      for (const s of shops) offers.set(s.companyId, (offers.get(s.companyId) ?? 0) + Math.min(s.stock, SHOP_CAPACITY_UNITS));
      const stockOf = new Map<string, number>(shops.map((s) => [s.companyId, s.stock]));
      const offered = [...offers.values()].reduce((a, b) => a + b, 0);
      add(supply, 'bread', offered);
      for (const [companyId, off] of offers) {
        const sold = Math.min(Math.min(off, stockOf.get(companyId) ?? 0), offered <= RESIDENT_BREAD_DEMAND ? off : Math.floor((off * RESIDENT_BREAD_DEMAND) / offered));
        if (sold <= 0) continue;
        const revenue = sold * price.bread!;
        const tax = Math.floor((revenue * SALES_TAX_BPS) / 10_000);
        await this.companies.removeInventory(tx, companyId, 'bread', sold);
        await this.companies.credit(tx, companyId, revenue, 'retail_sales', null, { units: sold, unit_price_cents: price.bread, day });
        if (tax > 0) {
          await this.companies.debit(tx, companyId, tax, 'sales_tax', null, { day });
          await this.companies.credit(tx, NPC.treasury.id, tax, 'sales_tax', null, { company_id: companyId, day });
        }
        sum.retail_units_sold += sold; sum.retail_revenue_cents += revenue; sum.taxes_cents += tax;
      }

      // Проценты, платёжеспособность, банкротства.
      for (const companyId of cs) {
        const c = (await tx.query<{ balance_cents: string; missed_wage_days: number; insolvent_days: number }>(
          'SELECT balance_cents, missed_wage_days, insolvent_days FROM companies WHERE id = $1', [companyId])).rows[0]!;
        let loan = await this.getLoan(tx, companyId);
        if (loan > 0) {
          const interest = Math.floor((loan * LOAN_RATE_BPS_PER_DAY) / 10_000);
          if (interest > 0) {
            await tx.query('UPDATE loans SET balance_cents = balance_cents + $2 WHERE company_id = $1', [companyId, interest]);
            loan += interest; sum.interest_accrued_cents += interest;
          }
        }
        const inv = await this.companies.inventory(tx, companyId);
        const assets = Number(c.balance_cents) + Object.entries(inv).reduce((a, [p, q]) => a + q * (price[p] ?? 0), 0);
        const insolvent = loan > 0 && loan > assets ? c.insolvent_days + 1 : 0;
        const missedDays = missed.has(companyId) ? c.missed_wage_days + 1 : 0;
        await tx.query('UPDATE companies SET insolvent_days = $2, missed_wage_days = $3 WHERE id = $1', [companyId, insolvent, missedDays]);
        if (insolvent >= INSOLVENCY_DAYS || missedDays >= MISSED_WAGE_DAYS_LIMIT) {
          await this.declareBankrupt(tx, companyId, day, price, supply);
          sum.bankruptcies.push(companyId);
        }
      }

      // Новые цены; счётчики дня обнуляются.
      for (const r of priceRows) {
        const p = r.product_id as string;
        const s = (supply[p] ?? 0) + BASELINE_UNITS;
        const d = (demand[p] ?? 0) + BASELINE_UNITS;
        const np = nextPrice(price[p]!, Number(r.base_price_cents), s, d);
        sum.prices[p] = np;
        await tx.query(
          'UPDATE market_prices SET price_cents = $2, last_supply = $3, last_demand = $4, supply_today = 0, demand_today = 0, updated_day = $5 WHERE product_id = $1',
          [p, np, s, d, day],
        );
      }

      await tx.query('UPDATE economy_days SET finished_at = now(), summary = $2 WHERE day = $1', [day, JSON.stringify(sum)]);
      await writeAudit(tx, { eventType: 'economy_day', details: { day, bankruptcies: sum.bankruptcies.length } });
      return sum;
    });
  }

  /** Ликвидация: инвентарь продаётся NPC по цене со спредом, долг гасится из средств, остаток списывается. */
  private async declareBankrupt(tx: Queryable, companyId: string, day: number, price: Record<string, number>, supply: Record<string, number>) {
    const inv = await this.companies.inventory(tx, companyId);
    for (const [p, q] of Object.entries(inv)) {
      if (q <= 0) continue;
      const unit = Math.floor(((price[p] ?? 0) * (10_000 - NPC_SPREAD_BPS)) / 10_000);
      await this.companies.removeInventory(tx, companyId, p, q);
      if (unit * q > 0) {
        await this.ensureNpcFunds(tx, NPC.trader.id);
        await this.companies.credit(tx, companyId, unit * q, 'liquidation_sale', null, { product: p, qty: q, day });
        await this.companies.debit(tx, NPC.trader.id, unit * q, 'liquidation_sale', null, { company_id: companyId, product: p, qty: q });
      }
      add(supply, p, q);
    }
    const loan = await this.getLoan(tx, companyId);
    const bal = Number((await tx.query<{ b: string }>('SELECT balance_cents b FROM companies WHERE id = $1', [companyId])).rows[0]!.b);
    const pay = Math.min(loan, bal);
    if (pay > 0) {
      await this.companies.debit(tx, companyId, pay, 'bankruptcy_repayment', null, { day });
      await this.companies.credit(tx, NPC.bank.id, pay, 'bankruptcy_repayment', null, { company_id: companyId, day });
    }
    await tx.query('UPDATE loans SET balance_cents = 0 WHERE company_id = $1', [companyId]);
    await tx.query("UPDATE companies SET status = 'bankrupt', bankrupt_day = $2 WHERE id = $1", [companyId, day]);
    await writeAudit(tx, { eventType: 'company_bankrupt', details: { company_id: companyId, day, debt_cents: loan, repaid_cents: pay, written_off_cents: loan - pay } });
  }
}

export const catalogView = () => ({
  products: PRODUCTS.map((p) => ({ product_id: p, base_price_cents: BASE_PRICES_CENTS[p] })),
  enterprise_kinds: (Object.keys(ENTERPRISE_KINDS) as EnterpriseKind[]).map((k) => ({
    kind: k, cost_cents: ENTERPRISE_KINDS[k], zones: ENTERPRISE_ZONES[k], wage_cents_per_day: WAGES_CENTS[k], recipe: RECIPES[k] ?? null,
    retail_capacity_units: k === 'shop' ? SHOP_CAPACITY_UNITS : null,
  })),
  params: { sales_tax_bps: SALES_TAX_BPS, npc_spread_bps: NPC_SPREAD_BPS, loan_rate_bps_per_day: LOAN_RATE_BPS_PER_DAY, max_loan_cents: MAX_LOAN_CENTS },
});
