---
name: nestjs-backend-conventions
description: Эталон backend-конвенций слоистого API-фреймворка (NestJS-подобный стек): DTO-цепочки Base→Create→Update→Response, FiltersDto с пагинацией и метаданными, контроллер=роутинг, сервис=логика+ownership, транзакции для многотабличных операций, события вместо прямых side-effects, лимиты через сервис, Swagger/OpenAPI, чеклист-перед-PR. Используй при создании или рефакторинге ЛЮБОГО backend-кода — модулей, сервисов, контроллеров, DTO, guards, фильтров. Обязателен при добавлении нового эндпоинта или изменении существующего API.
---

> **OPTIONAL stack-pack — включай для NestJS-подобного стека** (слоистый API-фреймворк с DI, декораторными контроллерами, DTO-валидацией). Не активен по умолчанию. Термины ORM/очереди/логгера отмечены как `{{STACK_TERMS}}` — подставь свои.

# Стандарты backend {{PROJECT_NAME}} (слоистый API-фреймворк)

## DTO-цепочки

Каждый ресурс имеет иерархию DTO. Не создавай монолитные DTO — разделяй по назначению: базовые общие поля, вход на создание, вход на обновление (все опциональны), форма ответа со служебными полями.

```typescript
export class BaseResourceDto {
  @IsString()
  title: string;

  @IsEnum(ResourceType)
  type: ResourceType;
}

export class CreateResourceDto extends BaseResourceDto {
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

export class UpdateResourceDto extends PartialType(BaseResourceDto) {}

export class ResourceResponseDto extends BaseResourceDto {
  id: string;
  status: ResourceStatus;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}
```

## FiltersDto для пагинации и поиска

```typescript
export class ResourcesFiltersDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(ResourceStatus)
  status?: ResourceStatus;
}
```

Список всегда возвращает метаданные пагинации — не голый массив:

```typescript
interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
```

---

## Контроллеры — только роутинг

Контроллер не содержит бизнес-логику. Только:
- Декораторы роутинга и OpenAPI
- Валидация входящих DTO (через `ValidationPipe` или Zod-pipe — `{{STACK_TERMS}}`)
- Вызов сервиса
- Возврат результата

```typescript
@Controller('resources')
@UseGuards(AuthGuard)
@ApiTags('resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Post()
  @ApiOperation({ summary: 'Create resource' })
  @ApiResponse({ type: ResourceResponseDto })
  create(
    @Body() dto: CreateResourceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ResourceResponseDto> {
    return this.resourcesService.create(dto, user.id);
  }
}
```

---

## Swagger / OpenAPI декораторы

Каждый публичный эндпоинт документирован:

```typescript
@ApiOperation({ summary: 'Краткое описание' })
@ApiResponse({ status: 200, type: ResponseDto })
@ApiResponse({ status: 400, description: 'Validation error' })
@ApiResponse({ status: 403, description: 'Forbidden' })
```

DTO-классы имеют `@ApiProperty()` на каждом поле.

---

## Сервисы — бизнес-логика

Сервис содержит всю бизнес-логику. Правила:

- Один публичный метод = одна операция
- Проверяй ownership / права доступа перед любой мутацией
- Кидай HTTP-исключения через `NotFoundException` / `ForbiddenException` / `HttpException`
- Не возвращай ORM-модели напрямую — маппи в ResponseDto

```typescript
async findById(id: string, userId: string): Promise<ResourceResponseDto> {
  const resource = await this.db.resource.findUnique({ where: { id } });

  if (!resource) throw new NotFoundException('Resource not found');
  if (resource.ownerId !== userId) throw new ForbiddenException();

  return this.toResponseDto(resource);
}
```

---

## Транзакции — атомарность многотабличных операций

Операции, затрагивающие несколько таблиц, всегда в транзакции (синтаксис ORM-специфичен — `{{STACK_TERMS}}`):

```typescript
await this.db.$transaction(async (tx) => {
  const resource = await tx.resource.create({ data: { ... } });
  await tx.member.create({ data: { resourceId: resource.id, ... } });
  await tx.activityLog.create({ data: { ... } });
});
```

Не выполняй несколько последовательных записей вне транзакции там, где нужна атомарность: частичный сбой оставит данные в противоречивом состоянии.

---

## Логирование

Через штатный `Logger` фреймворка (или ваш logger-сервис — `{{STACK_TERMS}}`):

```typescript
private readonly logger = new Logger(ResourcesService.name);

async create(dto: CreateResourceDto): Promise<ResourceResponseDto> {
  this.logger.log(`Creating resource type=${dto.type}`);
  try {
    // ...
  } catch (error) {
    this.logger.error('Failed to create resource', error.stack);
    throw error;
  }
}
```

Логируй: старт критических операций, ошибки со stack trace, значимые бизнес-события.

---

## События вместо прямых side-effects

Не вызывай побочные эффекты напрямую из сервиса-владельца операции. Испускай доменное событие, а обработку (нотификации, фоновая обработка, аналитика) вешай на подписчиков:

```typescript
this.eventEmitter.emit('resource.created', {
  resourceId: resource.id,
  ownerId: resource.ownerId,
});
```

Это разрывает связность: сервис не знает о всех потребителях, новый обработчик добавляется без правки исходного метода.

---

## Тяжёлые / внешние операции — через очередь, не синхронно

Ничего долгого или зависящего от внешнего сервиса не вызывай синхронно внутри HTTP-хендлера — ставь в очередь (`{{STACK_TERMS}}`), запрос отвечает сразу, воркер обрабатывает с ретраями:

```typescript
await this.jobsQueue.add('process-resource', { resourceId }, { attempts: 3 });
```

Синхронный вызов внешнего/долгого клиента прямо в цикле запроса — держит HTTP-соединение, ломает таймауты, роняет запрос при сбое зависимости.

---

## Лимиты и пороги — через сервис/конфиг, не хардкодом

Любой лимит, квоту или порог бери из сервиса лимитов / конфига, а не константой в коде:

```typescript
const limit = await this.limits.get(userId, 'resources_per_month');
if (currentCount >= limit) throw new ForbiddenException('Limit reached');
```

Магическое число (`if (currentCount >= 10)`) хардкодит политику в логику: её нельзя поменять без деплоя и она невидима для владельца продукта.

---

## Чеклист нового модуля (перед PR)

- [ ] DTO-цепочка: Base → Create → Update → Response
- [ ] FiltersDto с пагинацией, список возвращает метаданные
- [ ] Контроллер — только роутинг, без логики
- [ ] Swagger/OpenAPI-декораторы на всех эндпоинтах, `@ApiProperty()` на полях DTO
- [ ] Ownership / права доступа проверяются в сервисе перед мутацией
- [ ] Транзакции там, где нужна атомарность
- [ ] Логирование критических операций и ошибок со stack trace
- [ ] События вместо прямых side-effects
- [ ] Тяжёлые/внешние операции через очередь, не синхронно
- [ ] Лимиты через сервис/конфиг, не хардкодом
- [ ] `{{TYPECHECK_CMD}}` · `{{LINT_CMD}}` · `{{BUILD_CMD}}` · `{{TEST_CMD}}` — зелёные
