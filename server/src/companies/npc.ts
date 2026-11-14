import { withTransaction, type Db } from '../persistence/db.js';

/** Служебная NPC-компания: получатель платежей за землю. Остальные NPC (банк и т.д.) появятся с этапом 14. */
export const NPC = {
  treasury: { id: '00000000-0000-4000-8000-000000000001', name: 'Казна Республики Башкортостан' },
} as const;

export async function ensureNpcCompanies(db: Db): Promise<void> {
  await withTransaction(db, async (tx) => {
    for (const n of Object.values(NPC)) {
      await tx.query('INSERT INTO companies (id, owner_player_id, name, is_npc) VALUES ($1, NULL, $2, true) ON CONFLICT (id) DO NOTHING', [n.id, n.name]);
    }
  });
}
