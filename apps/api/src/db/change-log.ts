import type { SqlClient } from './sql-client';

export interface ChangeInput {
  entityType: 'entry' | 'permit' | 'shift' | 'grounding';
  entityId: string;
  op: 'upsert' | 'delete';
  version: number | null;
  actorId?: string | null;
}

export async function appendChange(tx: SqlClient, input: ChangeInput): Promise<void> {
  await tx.query(
    `insert into change_log (entity_type, entity_id, op, version, actor_id)
     values ($1, $2, $3, $4, $5)`,
    [input.entityType, input.entityId, input.op, input.version, input.actorId ?? null],
  );
}
