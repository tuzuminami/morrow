# Contributing

Thanks for considering a contribution to MORROW.

Before opening a pull request:

1. Run `pnpm run verify`.
2. Keep fixtures synthetic and free of real personal data, secrets, raw
   conversation exports, and private operator material.
3. Add or update tests for tenant isolation, consent, retention, audit, and
   fail-closed behavior when those areas change.
4. Do not add GPL or AGPL dependencies to core code paths.
