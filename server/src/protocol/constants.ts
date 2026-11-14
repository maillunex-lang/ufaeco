import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Общие константы протокола: protocol/protocol.json (их же читает Godot-клиент). */
export interface ProtocolSpec {
  protocol_version: number;
  websocket_path: string;
  client_to_server: string[];
  server_to_client: string[];
  commands: string[];
  error_codes: string[];
  disconnect_reasons: string[];
  limits: { display_name_min: number; display_name_max: number; auth_timeout_ms: number };
}

const path = fileURLToPath(new URL('../../../protocol/protocol.json', import.meta.url));
export const SPEC: ProtocolSpec = JSON.parse(readFileSync(path, 'utf8')) as ProtocolSpec;

export type ErrorCode = string;
