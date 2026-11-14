-- Детерминированный порядок обработки предприятий внутри компании (created_at одинаков в одной транзакции).
ALTER TABLE enterprises ADD COLUMN seq bigserial;
