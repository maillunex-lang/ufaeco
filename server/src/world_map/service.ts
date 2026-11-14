import type { CompanyService } from '../companies/index.js';
import { ENTERPRISE_ZONES, type EnterpriseKind } from '../companies/catalog.js';
import { DomainError } from '../errors.js';
import { NPC } from '../economy/catalog.js';
import { withTransaction, type Db, type Queryable } from '../persistence/db.js';
import { generateCity } from './generator.js';

/** Стартовые города (этап 6 добавит остальные зоны Башкортостана). */
export const CITIES = [{ id: 'ufa', name: 'Уфа', seed: 20241114 }] as const;

export class MapService {
  constructor(private readonly companies: CompanyService) {}

  /** Генерирует и сохраняет города. Идемпотентно: существующий город не перезаписывается. */
  async bootstrap(db: Db): Promise<void> {
    for (const c of CITIES) {
      await withTransaction(db, async (tx) => {
        const city = generateCity(c.id, c.seed);
        const ins = await tx.query(
          'INSERT INTO cities (id, name, seed, width, height, tiles) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
          [c.id, c.name, c.seed, city.width, city.height, JSON.stringify(city.tiles)],
        );
        if (ins.rowCount === 0) return;
        for (const l of city.lots) {
          await tx.query(
            'INSERT INTO map_lots (id, city_id, x, y, w, h, zone, price_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [l.id, c.id, l.x, l.y, l.w, l.h, l.zone, l.price_cents],
          );
        }
      });
    }
  }

  async getCity(q: Queryable, cityId: string) {
    const c = (await q.query('SELECT id, name, width, height, tiles FROM cities WHERE id = $1', [cityId])).rows[0];
    if (!c) throw new DomainError('not_found');
    const lots = (
      await q.query(
        `SELECT l.id, l.x, l.y, l.w, l.h, l.zone, l.price_cents, l.owner_company_id, co.name AS owner_name,
                e.id AS b_id, e.kind AS b_kind, e.name AS b_name
           FROM map_lots l LEFT JOIN companies co ON co.id = l.owner_company_id
           LEFT JOIN enterprises e ON e.lot_id = l.id
          WHERE l.city_id = $1 ORDER BY l.x, l.y`,
        [cityId],
      )
    ).rows.map((r) => ({
      id: r.id as string, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number,
      zone: r.zone as string, price_cents: Number(r.price_cents),
      owner_company_id: (r.owner_company_id as string | null) ?? null, owner_name: (r.owner_name as string | null) ?? null,
      building: r.b_id ? { enterprise_id: r.b_id as string, kind: r.b_kind as string, name: r.b_name as string } : null,
    }));
    return { id: c.id as string, name: c.name as string, width: c.width as number, height: c.height as number, tiles: c.tiles as string[], lots };
  }

  /** Покупка участка: деньги → казна, владелец — компания. Гонка за один участок: выигрывает ровно один. */
  async buyLot(tx: Queryable, playerId: string, companyId: string, lotId: string) {
    const company = await this.companies.getOwned(tx, playerId, companyId, true);
    this.companies.assertActive(company);
    const lot = (await tx.query('SELECT id, zone, price_cents, owner_company_id FROM map_lots WHERE id = $1 FOR UPDATE', [lotId])).rows[0];
    if (!lot) throw new DomainError('not_found');
    if (lot.zone === 'park') throw new DomainError('lot_not_for_sale');
    if (lot.owner_company_id) throw new DomainError('lot_taken');
    const price = Number(lot.price_cents);
    const balance = await this.companies.debit(tx, companyId, price, 'land_purchase', playerId, { lot_id: lotId });
    await this.companies.credit(tx, NPC.treasury.id, price, 'land_purchase', null, { company_id: companyId, lot_id: lotId });
    await tx.query('UPDATE map_lots SET owner_company_id = $2, bought_at = now() WHERE id = $1', [lotId, companyId]);
    return { lot_id: lotId, price_cents: price, balance_cents: balance };
  }

  /** Постройка предприятия на своём участке: зонирование, один объект на участок, стоимость списывается. */
  async construct(tx: Queryable, playerId: string, companyId: string, lotId: string, kind: EnterpriseKind, name: string) {
    const company = await this.companies.getOwned(tx, playerId, companyId, true);
    this.companies.assertActive(company);
    const lot = (await tx.query('SELECT id, zone, owner_company_id FROM map_lots WHERE id = $1 FOR UPDATE', [lotId])).rows[0];
    if (!lot) throw new DomainError('not_found');
    if (lot.owner_company_id !== companyId) throw new DomainError('lot_not_owned');
    if (!ENTERPRISE_ZONES[kind].includes(lot.zone as string)) throw new DomainError('zoning_violation');
    const taken = await tx.query('SELECT 1 FROM enterprises WHERE lot_id = $1', [lotId]);
    if (taken.rowCount) throw new DomainError('lot_occupied');
    const enterprise = await this.companies.createEnterprise(tx, playerId, companyId, kind, name, lotId);
    return { enterprise, lot_id: lotId, zone: lot.zone as string };
  }
}
