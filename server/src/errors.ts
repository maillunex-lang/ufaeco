/** Ожидаемая бизнес-ошибка: транзакция откатывается, клиент получает code. */
export class DomainError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
