/** Интерфейс модуля компаний. НЕ РЕАЛИЗОВАНО: этап 2 (таблица companies уже есть в схеме). */
export interface CompanyService {
  createCompany(ownerPlayerId: string, name: string): Promise<{ companyId: string }>;
  getCompany(companyId: string): Promise<{ id: string; name: string; ownerPlayerId: string } | null>;
}
