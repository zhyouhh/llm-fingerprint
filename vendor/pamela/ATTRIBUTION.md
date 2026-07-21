# Attribution — vendored upstream code & data

Everything in this directory originates from the PAMELA project by **Tomáš Bruckner**
(Prague University of Economics and Business, ORCID 0000-0001-9120-556X).

## Software — MIT License

- **DOI**: [10.5281/zenodo.21278793](https://doi.org/10.5281/zenodo.21278793)
- **Title**: *Single-token output distributions as behavioral fingerprints of large
  language models — software*
- **License**: MIT

Vendored files:

| File | Upstream path | Modification |
|---|---|---|
| `config/prompts.json` | `config/prompts.json` | none (verbatim) |
| `stats/color-lexicon.json` | `stats/color-lexicon.json` | none (verbatim) |
| `stats/01-normalize.js.orig` | `stats/01-normalize.js` | none (verbatim, kept for diffing) |
| `normalize-core.js` | extracted from `stats/01-normalize.js` | module wrapper only; function bodies byte-identical |

## Data — CC-BY-4.0

- **DOI**: [10.5281/zenodo.21278557](https://doi.org/10.5281/zenodo.21278557)
- **Title**: *Single-token output distributions as behavioral fingerprints of large
  language models* (dataset)
- **License**: Creative Commons Attribution 4.0 International

Used for the reference fingerprint database (`refdb/`) and as golden-test fixtures.
Raw data lives in `data/upstream/` (gitignored, fetched via `npm run fetch-data`).

## Paper

Bruckner, T. (2026). *One Token Is Enough: Fingerprinting and Verifying Large Language
Models from Single-Token Output Distributions*. arXiv:2607.10252.

## Why verbatim

Answer canonicalisation (Arabic-Indic digit mapping, Chinese numerals, colour lexicon,
refusal detection) is where a reimplementation silently diverges. A different
normaliser produces a different distribution, which makes our fingerprints
incomparable with the published reference database — while every test still passes.
Copying beats rewriting here.
