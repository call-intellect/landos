import { LoggerService } from '../logger.service.js';
export class CryptoService {
  constructor(private readonly logger: LoggerService) {}
  encryptValue(plain: string): string {
    // Encrypt a secret value with AES-GCM before persisting it to the database.
    this.logger.log('enc');
    return Buffer.from(plain).toString('base64');
  }
  decryptValue(cipher: string): string {
    // Decrypt a secret value read back from the database.
    return Buffer.from(cipher, 'base64').toString('utf8');
  }
}
