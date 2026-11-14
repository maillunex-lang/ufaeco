import { z } from 'zod';
import { SPEC } from './constants.js';
import { ENTERPRISE_KIND_IDS } from '../companies/catalog.js';

const uuid = z.uuid();

/** Конверт проверяется в два шага: сначала версия/тип, затем строгий payload. */
export const envelopeShape = {
  protocol_version: z.number().int(),
  message_id: uuid,
  type: z.string().min(1).max(64),
  request_id: uuid.optional(),
  payload: z.record(z.string(), z.unknown()),
};
export const envelopeSchema = z.strictObject(envelopeShape);
export type Envelope = z.infer<typeof envelopeSchema>;

export const displayName = z
  .string()
  .trim()
  .min(SPEC.limits.display_name_min)
  .max(SPEC.limits.display_name_max);

// ---- клиент → сервер ----
export const authPayload = z.strictObject({
  client_name: z.string().min(1).max(64),
  client_version: z.string().min(1).max(32),
  display_name: displayName.optional(),
});
const clientInfo = { client_name: z.string().min(1).max(64), client_version: z.string().min(1).max(32) };
export const loginName = z.string().regex(/^[A-Za-z0-9_]{3,24}$/);
export const password = z.string().min(SPEC.limits.password_min).max(SPEC.limits.password_max);
export const registerPayload = z.strictObject({ ...clientInfo, login: loginName, password, display_name: displayName.optional() });
export const loginPayload = z.strictObject({ ...clientInfo, login: loginName, password });
export const reconnectPayload = z.strictObject({
  session_id: uuid,
  resume_token: z.string().min(16).max(256),
});
export const heartbeatPayload = z.strictObject({ client_time: z.number() });
export const commandPayload = z.strictObject({
  name: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()),
});
export const clientDisconnectPayload = z.strictObject({ reason: z.literal('client_closing') });

export const clientPayloadSchemas = {
  auth: authPayload,
  register: registerPayload,
  login: loginPayload,
  reconnect: reconnectPayload,
  heartbeat: heartbeatPayload,
  command: commandPayload,
  disconnect: clientDisconnectPayload,
} as const;
export type ClientMessageType = keyof typeof clientPayloadSchemas;

const companyName = z.string().trim().min(SPEC.limits.company_name_min).max(SPEC.limits.company_name_max);

// ---- аргументы команд (strict: клиентский balance и т.п. отклоняются) ----
export const commandArgSchemas = {
  'session.get_profile': z.strictObject({}),
  'session.set_display_name': z.strictObject({ display_name: displayName }),
  'company.create': z.strictObject({ name: companyName }),
  'company.list': z.strictObject({}),
  'company.get': z.strictObject({ company_id: uuid }),
  'company.journal': z.strictObject({ company_id: uuid, limit: z.number().int().min(1).max(100).optional() }),
  'enterprise.create': z.strictObject({ company_id: uuid, kind: z.enum(ENTERPRISE_KIND_IDS), name: companyName }),
} as const;
export type CommandName = keyof typeof commandArgSchemas;

// ---- сервер → клиент ----
export const serverPayloadSchemas = {
  hello: z.strictObject({
    server_name: z.string(),
    protocol_version: z.number().int(),
    heartbeat_interval_ms: z.number().int(),
    auth_timeout_ms: z.number().int(),
    max_message_size: z.number().int(),
  }),
  auth_ok: z.strictObject({
    player_id: uuid,
    session_id: uuid,
    resume_token: z.string(),
    display_name: z.string(),
    server_tick: z.number().int(),
    heartbeat_interval_ms: z.number().int(),
    reconnect_timeout_s: z.number().int(),
    resumed: z.boolean(),
  }),
  heartbeat: z.strictObject({
    client_time: z.number(),
    server_time: z.number(),
    server_tick: z.number().int(),
  }),
  world_snapshot: z.strictObject({
    world_id: z.string(),
    server_tick: z.number().int(),
    server_time: z.number(),
    players_online: z.number().int(),
    players: z.array(z.strictObject({ player_id: uuid, display_name: z.string() })),
  }),
  command_result: z.strictObject({
    name: z.string(),
    ok: z.boolean(),
    duplicate: z.boolean(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  }),
  error: z.strictObject({ code: z.string(), message: z.string() }),
  disconnect: z.strictObject({ reason: z.string() }),
} as const;
export type ServerMessageType = keyof typeof serverPayloadSchemas;

/** Полное серверное сообщение (для тестов клиента и контроля исходящих сообщений). */
export const serverMessageSchema = z.discriminatedUnion(
  'type',
  (Object.keys(serverPayloadSchemas) as ServerMessageType[]).map((t) =>
    z.strictObject({
      ...envelopeShape,
      type: z.literal(t),
      payload: serverPayloadSchemas[t],
    }),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
);
