# Arkivate

**"If this, then that" for Arkiv data, run by independent workers instead of one company's server.**
Arkiv data is public and queryable, but nothing *happens* when it changes, and expiry emits no
event at all. Arkivate is a shared, open-source trigger engine: you describe a condition
(a new entity appears, a trusted heartbeat goes silent, a filtered count crosses a threshold),
and any worker can watch for it and leave a public, burned receipt on Arkiv when it fires, so a
skipped job is provable. Sealed triggers keep your intent private: only a salted hash goes on
Arkiv, and you reveal it only if a worker censors you.

Built for the *Arkiv: Global Tour Stop* hackathon on the Tiramisu testnet. MIT licensed.

> Setup instructions coming soon. Design: [docs/technical-plan.md](docs/technical-plan.md).
