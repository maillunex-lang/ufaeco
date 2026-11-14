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
  limits: {
    display_name_min: number;
    display_name_max: number;
    auth_timeout_ms: number;
    login_min: number;
    login_max: number;
    password_min: number;
    password_max: number;
    company_name_min: number;
    company_name_max: number;
  };
}

const path = fileURLToPath(new URL('../../../protocol/protocol.json', import.meta.url));
export const SPEC: ProtocolSpec = JSON.parse(readFileSync(path, 'utf8')) as ProtocolSpec;

export type ErrorCode = string;
