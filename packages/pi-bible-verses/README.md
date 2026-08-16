# @ian-pascoe/pi-bible-verses

An offline Pi extension that shows a Bible passage in Pi's working-message area while a turn runs.

Requires Node `>=22.19.0` and Pi `>=0.84.1`.

## Install

```bash
pi install npm:@ian-pascoe/pi-bible-verses
pi -e ./src/index.ts
```

The extension has no settings, network access, or external data loading. Its **Offline Verse Pool** is a static set of 291 passages. A process-scoped **Recent Passage Window** excludes the 20 most recently selected passage objects, so a selected passage cannot repeat until it leaves that window.

At turn start, the extension sets Pi's **Working Message** to:

```text
${text} — ${reference} (${translation})
```

It clears the working message automatically at turn end.

## Translation provenance and rights

The MIT [LICENSE](LICENSE) applies to this package's code. The embedded translation text has its own rights status: WEB, BSB, ASV, DARBY, YLT, and DRA are public domain; OEB is dedicated to the public domain under CC0. The following **Translation Provenance** records are authoritative for the embedded text.

| Abbreviation | Name                          | Edition                                         | License       | Static embedding | Source                                          | Rights                                   | Source archive SHA-256                                             | Provenance notice                                                   |
| ------------ | ----------------------------- | ----------------------------------------------- | ------------- | ---------------- | ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| WEB          | World English Bible           | 2020 stable text, updated 66-book protocanon    | Public domain | Yes              | https://ebible.org/Scriptures/engwebp_usfx.zip  | https://ebible.org/engwebp/copyright.htm | `637c9293584788957d4d53f982c10518cc9042a7d2a805a38ad5b8dbacab94d1` | World English Bible (WEB), public domain.                           |
| BSB          | Berean Standard Bible         | eBible.org source dated 2026-08-08              | Public domain | Yes              | https://ebible.org/Scriptures/engbsb_usfx.zip   | https://ebible.org/engbsb/copyright.htm  | `7ec2e485d4127fa6b6f49a02dc1f1ab8faf7aca94294a0501cd338a66258577e` | Berean Standard Bible (BSB), public domain.                         |
| ASV          | American Standard Version     | 1901                                            | Public domain | Yes              | https://ebible.org/Scriptures/eng-asv_usfx.zip  | https://ebible.org/asv/copyright.htm     | `365da92d6d9b09260f63b4d86e867cc06a54dc67a5a6a1342de7ab8fffa57961` | American Standard Version (ASV, 1901), public domain.               |
| DARBY        | Darby Translation             | 1884                                            | Public domain | Yes              | https://ebible.org/Scriptures/engDBY_usfx.zip   | https://ebible.org/engDBY/copyright.htm  | `24527bfdafd172e1b5236a30ae5420116229070145a22b24aff85a810cd05534` | Darby Translation (DARBY, 1884), public domain.                     |
| YLT          | Young's Literal Translation   | 1898                                            | Public domain | Yes              | https://ebible.org/Scriptures/engylt_usfx.zip   | https://ebible.org/engylt/copyright.htm  | `a19fd36a6c1b24ecaf249b0f874fc8123eb6ba6d3aaf24dffb7394fcf8bbecf7` | Young's Literal Translation (YLT, 1898), public domain.             |
| DRA          | Douay-Rheims American Edition | 1899                                            | Public domain | Yes              | https://ebible.org/Scriptures/engDRA_usfx.zip   | https://ebible.org/engDRA/copyright.htm  | `9dfbc526d699e9e461d0a8419c60dd12390e8618af7ac3e97083ae5e53e2ed29` | Douay-Rheims American Edition (DRA, 1899), public domain.           |
| OEB          | Open English Bible            | US spelling, eBible.org source dated 2026-08-08 | CC0-1.0       | Yes              | https://ebible.org/Scriptures/engoebus_usfx.zip | https://openenglishbible.org/            | `377ecb124ca1153211a750a41ce30a308c9d62b708ba5457306b43a41aa0fdc6` | Open English Bible (OEB), dedicated to the public domain under CC0. |
