import { randomUUID } from 'node:crypto';
import type { ServerMessageType } from './schemas.js';

export interface OutMessage {
  protocol_version: number;
  message_id: string;
  type: ServerMessageType;
  request_id?: string;
  payload: Record<string, unknown>;
}

export function makeMessage(
  protocolVersion: number,
  type: ServerMessageType,
  payload: Record<string, unknown>,
  requestId?: string,
): OutMessage {
  const msg: OutMessage = { protocol_version: protocolVersion, message_id: randomUUID(), type, payload };
  if (requestId) msg.request_id = requestId;
  return msg;
}

/** Тексты ошибок для логов (клиент показывает свои русские сообщения по коду). */
export const ERROR_MESSAGES_RU: Record<string, string> = {
  invalid_message: 'Некорректное сообщение',
  unsupported_protocol_version: 'Неподдерживаемая версия протокола',
  unknown_message_type: 'Неизвестный тип сообщения',
  unknown_command: 'Неизвестная команда',
  invalid_payload: 'Некорректные данные сообщения',
  not_authenticated: 'Сначала нужно пройти авторизацию',
  already_authenticated: 'Авторизация уже выполнена',
  auth_timeout: 'Время авторизации истекло',
  invalid_session: 'Сессия не найдена или токен неверен',
  session_expired: 'Сессия истекла',
  request_id_required: 'Для команды нужен request_id',
  request_id_conflict: 'request_id уже использован с другой командой',
  rate_limited: 'Слишком много запросов',
  message_too_large: 'Сообщение слишком большое',
  invalid_credentials: 'Неверный логин или пароль',
  login_taken: 'Этот логин уже занят',
  account_locked: 'Слишком много неудачных попыток входа. Подождите минуту',
  forbidden: 'Нет прав на эту компанию',
  not_found: 'Объект не найден',
  insufficient_funds: 'Недостаточно средств',
  limit_reached: 'Достигнут лимит компаний',
  company_name_taken: 'Название компании уже занято',
  enterprise_name_taken: 'Предприятие с таким названием уже есть',
  unknown_product: 'Неизвестный товар',
  insufficient_inventory: 'Недостаточно товара на складе',
  company_bankrupt: 'Компания обанкротилась',
  loan_limit_exceeded: 'Превышен лимит кредита',
  invalid_amount: 'Неверная сумма',
  internal_error: 'Внутренняя ошибка сервера',
};
