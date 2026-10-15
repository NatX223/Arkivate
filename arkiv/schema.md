# Arkivate entity schema

All entities carry `project = "arkivate"` and `entity_type`. Attribute names are lowercase
snake_case. Trust comes from `$creator` (filter with `.createdBy(addr)`), never from `$owner`,
`project` or `entity_type`. Timestamps and block numbers are always `u64`.

See `docs/technical-plan.md` §3 for the full design; this file is filled in as each type ships.

## worker

## trigger

## sealed

## acceptance

## receipt

## reveal
