// Доступ к конфигурации и переменным окружения. Импортируется повсеместно.
import { LoggerService } from './logger.service.js';
export class ConfigService {
  constructor(private readonly logger: LoggerService) {}
  get(key: string): string { this.logger.log('read config ' + key); return process.env[key] ?? ''; }
}
