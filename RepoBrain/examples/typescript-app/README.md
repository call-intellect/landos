# @example/typescript-app

A small but realistic TypeScript backend used as a **golden test fixture** for
RepoBrain (a code-context engine). It is intentionally split across several
modules so that reading the whole repository to answer a single question is
clearly wasteful.

> This project is a fixture. It is not meant to be installed or run. Every
> `.ts` file is valid TypeScript that tree-sitter can parse, but dependencies
> are never installed.

## Layout

```
src/
  common/          Shared infrastructure (config, logger, db, http, validation)
  modules/
    leads/         Lead intake: schema, validation, creation, CRM hand-off
    crm/           CRM client and phone normalization
    orders/        Order pricing: discounts and totals
    users/         User entity and service
  app.ts           Builds the express router and wires routes to handlers
  server.ts        Boots the HTTP server
tests/             Vitest-style unit tests for the module functions
eval/tasks.yaml    RepoBrain evaluation tasks (cross-language)
```

## Dependency highlights

- `modules/leads/createLead.ts` imports `LeadInput` from `lead.schema.ts`,
  validates it with `validateLeadPayload`, and calls `sendLeadToCrm`.
- `modules/crm/crm-client.ts` exposes `sendLeadToCrm` and a `normalizePhone`
  helper that runs before the payload leaves the process.
- `modules/orders/calcTotal.ts` calls `applyDiscount` from `applyDiscount.ts`.
- `app.ts` wires `POST /leads` to `createLead` and `POST /orders` to a handler
  that computes the order total with `calcTotal`.

These real imports and calls give RepoBrain a non-trivial import/call graph and
`tested_by` edges from the files under `tests/`.
