# example-python-app

A small, deliberately realistic Python backend used as a **golden test fixture**
for RepoBrain (a code-context engine). It is not meant to be installed or run;
its purpose is to provide a non-trivial import and call graph across several
packages so that "read the whole repo" is clearly wasteful.

## Layout

```
src/app/
  app.py            application factory (Flask-style)
  api.py            HTTP routes wired to the service layer
  common/           config, logging, in-memory db, validation helpers
  users/            user schema, phone normalization, create_user service
  invoices/         tax and total computation, invoice assembly
  leads/            lead schema, create_lead workflow, CRM client
tests/              pytest-style tests referencing the service functions
eval/tasks.yaml     RepoBrain evaluation tasks (see spec section 15)
```

## Notable call edges

- `users.service.create_user` calls `users.phone.normalize_phone`
- `invoices.calc_total.calc_total` calls `invoices.calc_tax.calc_tax`
- `leads.create_lead.create_lead` calls `leads.crm_client.send_lead_to_crm`
- Route handlers in `api.py` call the module-level service functions

## Tests

The tests under `tests/` exercise the public service functions so that
RepoBrain can infer `tested_by` edges. They are standard pytest modules.

All source code, identifiers, comments and docstrings are in English. The
Russian text lives only in `eval/tasks.yaml`, which drives the
cross-language retrieval evaluation.
