# Reference implementation

The code in this folder is a **reference implementation written from the
documented method** in [`../docs/IMPLEMENTATION.md`](../docs/IMPLEMENTATION.md).
The production app runs on a hosted platform whose source is not
exportable; these files re-implement the core mechanisms — the country
colour system, comet-particle arcs, the lighting rig and the tiered
data refresh — in plain, readable TypeScript so the design can be
studied and re-built elsewhere.

## Type-check the skeleton

```bash
npm install
npm run typecheck   # tsc --noEmit, strict
```
