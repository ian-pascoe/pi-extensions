/** Translation abbreviations allowed in the offline Bible-reading pool. */
export type BibleTranslationAbbreviation = "WEB" | "BSB" | "ASV" | "DARBY" | "YLT" | "DRA" | "OEB";

export type BibleTranslationMetadata = {
  name: string;
  edition: string;
  license: "Public domain" | "CC0-1.0";
  staticEmbeddingAllowed: true;
  sourceUrl: string;
  rightsUrl: string;
  sourceArchiveSha256: string;
  provenanceNotice: string;
};

/** Rights and source provenance for every translation embedded in the verse pool. */
export const bibleTranslationMetadata = {
  WEB: {
    name: "World English Bible",
    edition: "2020 stable text, updated 66-book protocanon",
    license: "Public domain",
    staticEmbeddingAllowed: true,
    sourceUrl: "https://ebible.org/Scriptures/engwebp_usfx.zip",
    rightsUrl: "https://ebible.org/engwebp/copyright.htm",
    sourceArchiveSha256: "637c9293584788957d4d53f982c10518cc9042a7d2a805a38ad5b8dbacab94d1",
    provenanceNotice: "World English Bible (WEB), public domain.",
  },
  BSB: {
    name: "Berean Standard Bible",
    edition: "eBible.org source dated 2026-08-08",
    license: "Public domain",
    staticEmbeddingAllowed: true,
    sourceUrl: "https://ebible.org/Scriptures/engbsb_usfx.zip",
    rightsUrl: "https://ebible.org/engbsb/copyright.htm",
    sourceArchiveSha256: "7ec2e485d4127fa6b6f49a02dc1f1ab8faf7aca94294a0501cd338a66258577e",
    provenanceNotice: "Berean Standard Bible (BSB), public domain.",
  },
  ASV: {
    name: "American Standard Version",
    edition: "1901",
    license: "Public domain",
    staticEmbeddingAllowed: true,
    sourceUrl: "https://ebible.org/Scriptures/eng-asv_usfx.zip",
    rightsUrl: "https://ebible.org/asv/copyright.htm",
    sourceArchiveSha256: "365da92d6d9b09260f63b4d86e867cc06a54dc67a5a6a1342de7ab8fffa57961",
    provenanceNotice: "American Standard Version (ASV, 1901), public domain.",
  },
  DARBY: {
    name: "Darby Translation",
    edition: "1884",
    license: "Public domain",
    staticEmbeddingAllowed: true,
    sourceUrl: "https://ebible.org/Scriptures/engDBY_usfx.zip",
    rightsUrl: "https://ebible.org/engDBY/copyright.htm",
    sourceArchiveSha256: "24527bfdafd172e1b5236a30ae5420116229070145a22b24aff85a810cd05534",
    provenanceNotice: "Darby Translation (DARBY, 1884), public domain.",
  },
  YLT: {
    name: "Young's Literal Translation",
    edition: "1898",
    license: "Public domain",
    staticEmbeddingAllowed: true,
    sourceUrl: "https://ebible.org/Scriptures/engylt_usfx.zip",
    rightsUrl: "https://ebible.org/engylt/copyright.htm",
    sourceArchiveSha256: "a19fd36a6c1b24ecaf249b0f874fc8123eb6ba6d3aaf24dffb7394fcf8bbecf7",
    provenanceNotice: "Young's Literal Translation (YLT, 1898), public domain.",
  },
  DRA: {
    name: "Douay-Rheims American Edition",
    edition: "1899",
    license: "Public domain",
    staticEmbeddingAllowed: true,
    sourceUrl: "https://ebible.org/Scriptures/engDRA_usfx.zip",
    rightsUrl: "https://ebible.org/engDRA/copyright.htm",
    sourceArchiveSha256: "9dfbc526d699e9e461d0a8419c60dd12390e8618af7ac3e97083ae5e53e2ed29",
    provenanceNotice: "Douay-Rheims American Edition (DRA, 1899), public domain.",
  },
  OEB: {
    name: "Open English Bible",
    edition: "US spelling, eBible.org source dated 2026-08-08",
    license: "CC0-1.0",
    staticEmbeddingAllowed: true,
    sourceUrl: "https://ebible.org/Scriptures/engoebus_usfx.zip",
    rightsUrl: "https://openenglishbible.org/",
    sourceArchiveSha256: "377ecb124ca1153211a750a41ce30a308c9d62b708ba5457306b43a41aa0fdc6",
    provenanceNotice: "Open English Bible (OEB), dedicated to the public domain under CC0.",
  },
} as const satisfies Record<BibleTranslationAbbreviation, BibleTranslationMetadata>;
