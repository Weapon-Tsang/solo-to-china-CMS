# Stage 03 pinned consumer fixture

`stage03-pinned-contract.json` contains only public contract documents and their identity fields, copied read-only on 2026-09-28 from the previously authorized local disposable database. No article, account, credential or media inventory records were exported.

- Source repository: `Weapon-Tsang/solo-to-china`
- Frontend commit: `0c4b327287c016aee138f735a8a13eb2baa74542`
- Contract version: `1.4.1`
- Combined artifact SHA256: `9154dc68540d9922c11109e4cfe00aee871d850e61124fd7edb624ee20b2c422`
- Verification: SHA256 of `JSON.stringify([registry, pageSchema, publishPackageSchema])` must match that value. Tests assert the fixed commit as well.

The embedded documents are unchanged. This is a CMS consumer test dependency, not frontend implementation code, a new contract version, or evidence of a deployed WordPress receiver. The test receiver implements a limited local HTTP fixture and explicitly rejects unsupported fixture blocks.
