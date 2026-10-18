# RUAccent dictionary snapshot

Local Russian word-form dictionaries from [RUAccent](https://github.com/Den4ikAI/ruaccent). No neural models or predicted `accents_nn.json.gz` dictionary are bundled. The application reads these gzip-compressed UTF-8 JSON files with Node's standard library; no Python or RUAccent runtime is required.

## Source and license

- Data repository: [`ruaccent/accentuator`](https://huggingface.co/ruaccent/accentuator), pinned revision **`b78ae5ea1e62beaf138bed1865cd8c3b0b5ca855`**.
- Directory: [dictionary at the pinned revision](https://huggingface.co/ruaccent/accentuator/tree/b78ae5ea1e62beaf138bed1865cd8c3b0b5ca855/dictionary).
- License: **MIT**. The [pinned Hugging Face model card](https://huggingface.co/ruaccent/accentuator/blob/b78ae5ea1e62beaf138bed1865cd8c3b0b5ca855/README.md) declares `license: mit` and states that the entire v1 system is transitioning to MIT.
- [`LICENSE`](./LICENSE) is the exact upstream license, copyright 2026 Denis Petrov, copied from [RUAccent commit `3ac0ad5f6508f6c1a4a604220042232c70a7baf9`](https://github.com/Den4ikAI/ruaccent/blob/3ac0ad5f6508f6c1a4a604220042232c70a7baf9/LICENSE). The Hugging Face repository has no separate license file in this snapshot.
- Retrieved and verified: 2026-10-18. Each data SHA-256 matches its pinned Hugging Face LFS object ID.

| Local file | Exact bytes | SHA-256 | Entries |
| --- | ---: | --- | ---: |
| [accents.json.gz](https://huggingface.co/ruaccent/accentuator/resolve/b78ae5ea1e62beaf138bed1865cd8c3b0b5ca855/dictionary/accents.json.gz) | 20,954,156 | `aa460ebba90de00fbbf3d41d121961f605b98667e45efb7920f127473b15515e` | 3,194,879 |
| [omographs.json.gz](https://huggingface.co/ruaccent/accentuator/resolve/b78ae5ea1e62beaf138bed1865cd8c3b0b5ca855/dictionary/omographs.json.gz) | 219,047 | `04a9e81c68d65f65ba493fe0110f99e79087548c2beeec3032e2b66e28706f36` | 19,741 |
| [yo_words.json.gz](https://huggingface.co/ruaccent/accentuator/resolve/b78ae5ea1e62beaf138bed1865cd8c3b0b5ca855/dictionary/yo_words.json.gz) | 548,914 | `a19fa89a964a0691d9fe4ee384783e3934904891843d8f59a1c480d67947a82a` | 85,568 |
| [yo_homographs.json.gz](https://huggingface.co/ruaccent/accentuator/resolve/b78ae5ea1e62beaf138bed1865cd8c3b0b5ca855/dictionary/yo_homographs.json.gz) | 5,747 | `c4ee777bbbab87f9eac838f370ad92974e079d02b21903e480c54b5f0c8c60d1` | 637 |
| LICENSE | 1,060 | `5ccb796d1fa25aeec0cc7d3ada4915963cec3b7cacfa2cb39ce00c65761e7ad6` | — |

## Native format and limits

- `accents.json.gz`: `Record<string, string>`, lowercase word form to the same form with `+` immediately **before** the stressed vowel: `"окно": "окн+о"`, `"тишина": "тишин+а"`. Uncompressed JSON is 175,538,625 bytes. Some entries have no `+`; these do not establish stress. Every inspected entry preserves the key's spelling after removing `+`.
- `omographs.json.gz`: `Record<string, string[]>`, e.g. `"замок": ["з+амок", "зам+ок"]` and `"дорога": ["дор+ога", "дорог+а"]`. Uncompressed JSON is 1,473,951 bytes. Check these alternatives before the single accent dictionary: 18,007 homograph keys also have a single entry there. Three keys contain only one alternative.
- `yo_words.json.gz`: `Record<string, string>`, unambiguous spelling restoration such as `"береза": "берёза"`, `"еще": "ещё"`, `"идет": "идёт"`. Uncompressed JSON is 4,585,826 bytes. It deliberately does not resolve every `е`/`ё` ambiguity; for example, `все` and `звезды` are absent.
- `yo_homographs.json.gz`: `Record<string, string>`, ambiguous `е`-form to its possible `ё` spelling: `"звезды": "звёзды"`, `"слезы": "слёзы"`, `"все": "всё"`. Uncompressed JSON is 24,951 bytes. These are candidates, not unconditional replacements; context must decide whether the `ё` spelling applies. For example, `accents["звезды"]` is `"звезд+ы"`, while `accents["звёзды"]` is `"зв+ёзды"`; `omographs["звезды"]` retains both `"зв+езды"` and `"звезд+ы"`.

This is word-form coverage, not context disambiguation or a claim of complete Russian vocabulary coverage. Inflected forms, names, and rare words are present, but missing or unmarked words need an explicit fallback. Homograph alternatives need contextual resolution before being treated as a definite stress.
