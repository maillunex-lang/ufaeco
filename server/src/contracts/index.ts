/** Интерфейс модуля контрактов. НЕ РЕАЛИЗОВАНО: этап 5. */
export interface ContractService {
  createSupplyContract(sellerId: string, buyerId: string, productId: string, quantity: number, unitPrice: number): Promise<{ contractId: string }>;
}
