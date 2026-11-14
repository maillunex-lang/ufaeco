/** Интерфейс модуля недвижимости. НЕ РЕАЛИЗОВАНО: этап 7. */
export interface RealEstateService {
  rentRetailUnit(companyId: string, buildingId: string, unitId: string): Promise<{ leaseId: string }>;
}
