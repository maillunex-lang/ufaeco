import type { AccountService } from '../accounts/index.js';
import type { CompanyService } from '../companies/index.js';
import { ENTERPRISE_KINDS } from '../companies/catalog.js';
import type { Queryable } from '../persistence/db.js';
import type { CommandName } from '../protocol/schemas.js';
import type { EconomyService } from '../economy/service.js';
import { catalogView } from '../economy/service.js';
import type { MapService } from '../world_map/service.js';
import type { World } from '../world/index.js';

export interface Services {
  accounts: AccountService;
  companies: CompanyService;
  economy: EconomyService;
  map: MapService;
  world: World;
}

export interface CommandContext {
  tx: Queryable;
  playerId: string;
  services: Services;
  /** Выполняется только после успешного коммита и только при первом (не повторном) выполнении. */
  afterCommit(fn: () => void): void;
}

type Args = Record<string, any>;
type Handler = (ctx: CommandContext, args: Args) => Promise<Record<string, unknown>>;

export const commandHandlers: Record<CommandName, Handler> = {
  'session.get_profile': async ({ tx, playerId, services }) => {
    const p = await services.accounts.getPlayer(tx, playerId);
    return { player_id: playerId, display_name: p?.displayName ?? '', login: p?.login ?? null, is_guest: p?.login == null };
  },

  'session.set_display_name': async ({ tx, playerId, services, afterCommit }, args) => {
    await services.accounts.setDisplayName(tx, playerId, args.display_name);
    afterCommit(() => services.world.rename(playerId, args.display_name));
    return { player_id: playerId, display_name: args.display_name };
  },

  'company.create': async ({ tx, playerId, services }, args) => ({
    company: await services.companies.create(tx, playerId, args.name),
  }),

  'company.list': async ({ tx, playerId, services }) => ({
    companies: await services.companies.listOwned(tx, playerId),
  }),

  'company.get': async ({ tx, playerId, services }, args) => {
    const company = await services.companies.getOwned(tx, playerId, args.company_id);
    return {
      company,
      inventory: await services.companies.inventory(tx, company.id),
      enterprises: await services.companies.enterprises(tx, company.id),
    };
  },

  'company.journal': async ({ tx, playerId, services }, args) => {
    const company = await services.companies.getOwned(tx, playerId, args.company_id);
    return { company_id: company.id, entries: await services.companies.journal(tx, company.id, args.limit ?? 50) };
  },

  'enterprise.create': async ({ tx, playerId, services }, args) => ({
    enterprise: await services.companies.createEnterprise(tx, playerId, args.company_id, args.kind, args.name),
    cost_cents: ENTERPRISE_KINDS[args.kind as keyof typeof ENTERPRISE_KINDS],
  }),

  'economy.get_catalog': async () => ({ ...catalogView() }),

  'economy.get_prices': async ({ tx, services }) => ({
    economy_day: await services.economy.currentDay(tx),
    prices: await services.economy.getPrices(tx),
  }),

  'economy.trade': async ({ tx, playerId, services }, args) => ({
    trade: await services.economy.trade(tx, playerId, args.company_id, args.product_id, args.side, args.quantity),
  }),

  'bank.get_loan': async ({ tx, playerId, services }, args) => {
    const c = await services.companies.getOwned(tx, playerId, args.company_id);
    return { company_id: c.id, loan_cents: await services.economy.getLoan(tx, c.id) };
  },

  'bank.take_loan': async ({ tx, playerId, services }, args) => ({
    loan: await services.economy.takeLoan(tx, playerId, args.company_id, args.amount_cents),
  }),

  'bank.repay_loan': async ({ tx, playerId, services }, args) => ({
    loan: await services.economy.repayLoan(tx, playerId, args.company_id, args.amount_cents),
  }),

  'map.get_city': async ({ tx, services }, args) => ({ city: await services.map.getCity(tx, args.city_id) }),

  'map.buy_lot': async ({ tx, playerId, services }, args) => ({
    purchase: await services.map.buyLot(tx, playerId, args.company_id, args.lot_id),
  }),
};
