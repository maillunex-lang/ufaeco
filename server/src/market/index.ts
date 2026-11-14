/** Интерфейс модуля рынка. НЕ РЕАЛИЗОВАНО: этап 4. */
export interface MarketService {
  placeBuyOrder(companyId: string, productId: string, quantity: number, unitPrice: number): Promise<{ orderId: string }>;
  placeSellOrder(companyId: string, productId: string, quantity: number, unitPrice: number): Promise<{ orderId: string }>;
}
