# Wallets

Public addresses that create Arkivate entities on Tiramisu (chain ID 7738577). Public addresses
only: keys live in `.env` locally and in `/opt/arkivate/.env` (mode 600) on each worker VM, never in this repo.
Generate a fresh set with `pnpm wallets` (prints keys and addresses, writes nothing).

| Role | Address | Creates | Explorer |
|---|---|---|---|
| owner | `0xa81415E8Fa827099BbEb5eA11199533D2e2967eA` | public `trigger` entities and synthetic `demo_feed` data (CLI, `pnpm hello`) | [address](https://tiramisu.explorer.arkiv.network/address/0xa81415E8Fa827099BbEb5eA11199533D2e2967eA) |
| sealed_owner | `0xaC1d90510894d270b9096eB915A04B0AB7B43c7B` | `sealed` commitments and `reveal` entities. A separate wallet, so sealed triggers aren't linked to the owner's public activity | [address](https://tiramisu.explorer.arkiv.network/address/0xaC1d90510894d270b9096eB915A04B0AB7B43c7B) |
| worker-1 (`worker_a`) | `0xBd9d8aB464aBe5fC9e52911F2d30D9f8144C7a5c` | reference worker: `worker` registration, `receipt`, `acceptance`; Reactivate extensions | [address](https://tiramisu.explorer.arkiv.network/address/0xBd9d8aB464aBe5fC9e52911F2d30D9f8144C7a5c) |
| worker-2 (`worker_b`) | `0xDE94088D98368A81079a897a2278cc52BEeC3D1C` | reference worker: same entity types as worker-1, signed with its own key | [address](https://tiramisu.explorer.arkiv.network/address/0xDE94088D98368A81079a897a2278cc52BEeC3D1C) |

worker-1 and worker-2 are the two reference workers we run. Anyone can run another worker with
their own wallet; it appears on Arkiv as one more `worker` entity, created by that wallet.

Web-app users sign with their own wallet (MetaMask), so triggers they create carry their own
address as `$creator`, not one of the above.
