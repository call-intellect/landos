// Централизованный логгер приложения. Используется почти всеми сервисами.
export class LoggerService {
  log(message: string): void { console.log(message); }
  warn(message: string): void { console.warn(message); }
  error(message: string, err?: unknown): void { console.error(message, err); }
}
