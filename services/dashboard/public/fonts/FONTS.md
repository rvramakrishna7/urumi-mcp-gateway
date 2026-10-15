# Fonts

Self-hosted, so the dashboard never asks another host for a font (the CSP has `font-src 'self'`).

All three families are licensed under the SIL Open Font License 1.1. The licence text with each copyright line is in `LICENSES/`. No Reserved Font Name is declared by any of the three copyright statements, and the files are the latin subset in woff2 format as packaged by Fontsource 5.3.0 (`@fontsource/bricolage-grotesque`, `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`, fetched with `npm pack`, not installed as dependencies).

| Family | Use | Copyright | Upstream |
|---|---|---|---|
| Bricolage Grotesque (700, 800) | display headings | 2022 The Bricolage Grotesque Project Authors | https://github.com/ateliertriay/bricolage |
| IBM Plex Sans (400, 500, 600) | body text | 2019 IBM Corp. | https://github.com/IBM/plex |
| IBM Plex Mono (400, 500) | labels, data, badges | 2017 IBM Corp. | https://github.com/IBM/plex |

SHA-256 of every file (`test/fonts.test.ts` checks them):

```text
4c373ce3c1cca41c864eb3e27c059a59fc6310547ab9c9b6cd780d387ba24206  bricolage-grotesque-latin-700-normal.woff2
3e1b5f0a56ee995b7c1445bc54e6ec98c5dffb585ef5c4baf86731cf68e27c61  bricolage-grotesque-latin-800-normal.woff2
08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7  ibm-plex-mono-latin-400-normal.woff2
01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22  ibm-plex-mono-latin-500-normal.woff2
3b646991d30055a93a4ecc499713d4347953a74a947ecab435ab72070cbdab0e  ibm-plex-sans-latin-400-normal.woff2
0717336fb31fcdcde4b8deb3675bb4a0f7f6d484864afcd6751ac29975962203  ibm-plex-sans-latin-500-normal.woff2
8960851d691c054ed38e259bdcf1a6190d157b4203ed5bb32c632a863fb8ec2f  ibm-plex-sans-latin-600-normal.woff2
```
