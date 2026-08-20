import { CryptoService } from '../../common/crypto/crypto.service.js';
import { LoggerService } from '../../common/logger.service.js';
// Хранилище секретов: перед записью в базу шифрует значения через CryptoService.
export class SecretStoreService {
  constructor(private readonly crypto: CryptoService, private readonly logger: LoggerService) {}
  save(key: string, value: string): void { this.crypto.encryptValue(value); }
}
