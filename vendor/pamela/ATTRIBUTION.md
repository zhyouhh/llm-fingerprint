# Attribution — vendored upstream code & data

Everything in this directory originates from the PAMELA project by **Tomáš Bruckner**
(Prague University of Economics and Business, ORCID 0000-0001-9120-556X).

## Software — MIT License

- **DOI**: [10.5281/zenodo.21278793](https://doi.org/10.5281/zenodo.21278793)
- **Title**: *Single-token output distributions as behavioral fingerprints of large
  language models — software*
- **License**: MIT — see [`LICENSE`](./LICENSE) in this directory
- **Copyright (c) 2026 Tomáš Bruckner**

> ⚠️ The upstream release archive ships **no** LICENSE file and no copyright line.
> MIT is established by the Zenodo record (`license.id = "mit-license"`) and by the
> upstream `package.json` (`"license": "MIT"`). The LICENSE file here is the standard
> MIT text with the copyright line filled in from the record's sole creator, added so
> that copies of this repository carry the notice MIT requires. See the provenance
> note at the bottom of that file.

Vendored files:

| File | Upstream path | Modification |
|---|---|---|
| `config/prompts.json` | `config/prompts.json` | none (verbatim) |
| `config/models.selected.json` | `config/models.selected.json` | none (verbatim) — the 176-model selection table; read directly by `test/golden/g1-jsd.test.js` |
| `stats/color-lexicon.json` | `stats/color-lexicon.json` | none (verbatim) |
| `stats/01-normalize.js.orig` | `stats/01-normalize.js` | none (verbatim, kept for diffing) |
| `normalize-core.js` | extracted from `stats/01-normalize.js` | module wrapper only; function bodies byte-identical |

> `config/models.selected.json` is a derivative of the CC-BY-4.0 dataset rather than of
> the MIT software, so the attribution requirements in the next section cover it too.

## Data — CC-BY-4.0

- **Creator**: Tomáš Bruckner
- **Title**: *Single-token output distributions as behavioral fingerprints of large
  language models* (dataset)
- **DOI**: [10.5281/zenodo.21278557](https://doi.org/10.5281/zenodo.21278557)
- **Copyright (c) 2026 Tomáš Bruckner**
- **License**: Creative Commons Attribution 4.0 International —
  <https://creativecommons.org/licenses/by/4.0/>
- **Changes made**: 🔴 **yes** — this project subsets and reorders the original data.
  Specifically: only the 10 paper-1 (Study A) tasks are used (the `coord-*`,
  `anticoord-*` and `secret-password` tasks belong to Study B and are excluded);
  per-cell records are re-aggregated into this project's own fingerprint layout; and
  `reference/genuine-*.json` combines the upstream normalisation pipeline with samples
  this project collected itself. No upstream measurement values were altered.

Used as golden-test fixtures and as the reference fingerprint database. Raw data lives
in `data/upstream/` (gitignored, fetched via `npm run fetch-data`); this project's own
reference fingerprints live in `reference/`.

Attribution text suitable for a UI footer or a citation line:

> 参考指纹库 © Tomáš Bruckner, CC BY 4.0 · DOI 10.5281/zenodo.21278557 ·
> 本项目对原始数据做了子集化与重排

## Paper

Bruckner, T. (2026). *One Token Is Enough: Fingerprinting and Verifying Large Language
Models from Single-Token Output Distributions*. arXiv:2607.10252.

## Why verbatim

Answer canonicalisation (Arabic-Indic digit mapping, Chinese numerals, colour lexicon,
refusal detection) is where a reimplementation silently diverges. A different
normaliser produces a different distribution, which makes our fingerprints
incomparable with the published reference database — while every test still passes.
Copying beats rewriting here.
