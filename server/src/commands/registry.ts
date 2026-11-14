import type { AccountService } from '../accounts/index.js';
import type { CompanyService } from '../companies/index.js';
import { ENTERPRISE_KINDS } from '../companies/catalog.js';
import type { Queryable } from '../persistence/db.js';
import type { CommandName } from '../protocol/schemas.js';
import { DomainError } from '../errors.js';
import { catalogView } from '../companies/catalog.js';
import type { MapService } from '../world_map/service.js';
import type { RegionService } from '../region/service.js';
import type { World } from '../world/index.js';

export interface Services {
  accounts: AccountService;
  companies: CompanyService;
  map: MapService;
  region: RegionService;
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

  'enterprise.create': async ({ tx, playerId, services }, args) => {
    const cost_cents = ENTERPRISE_KINDS[args.kind as keyof typeof ENTERPRISE_KINDS];
    if (args.lot_id) {
      const r = await services.map.construct(tx, playerId, args.company_id, args.lot_id, args.kind, args.name);
      return { enterprise: r.enterprise, cost_cents };
    }
    return { enterprise: await services.companies.createEnterprise(tx, playerId, args.company_id, args.kind, args.name), cost_cents };
  },

  'catalog.get': async () => ({ ...catalogView() }),

  'map.get_city': async ({ tx, services }, args) => ({ city: await services.map.getCity(tx, args.city_id) }),

  'map.buy_lot': async ({ tx, playerId, services }, args) => ({
    purchase: await services.map.buyLot(tx, playerId, args.company_id, args.lot_id),
  }),

  'region.get': async ({ tx, services }) => ({ region: await services.region.getRegion(tx) }),

  'region.freight_quote': async ({ services }, args) => {
    try {
      return { quote: services.region.network.quote(args.from_city, args.to_city, args.tonnes ?? 1) };
    } catch {
      throw new DomainError('not_found');
    }
  },

  'city.get_stats': async ({ tx, services }, args) => {
    const stats = await services.region.cityStats(tx, args.city_id, args.months ?? 24);
    if (!stats) throw new DomainError('not_found');
    return { stats };
  },
};
