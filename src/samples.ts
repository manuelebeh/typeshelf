/** Sample texts used by the specimen and language views. */

export interface Language {
  name: string;
  sample: string;
  rtl?: boolean;
}

/** Traditional pangrams (or short typical sentences) per language. */
export const LANGUAGES: Language[] = [
  { name: "Français", sample: "Portez ce vieux whisky au juge blond qui fume." },
  { name: "Anglais", sample: "Sphinx of black quartz, judge my vow." },
  { name: "Allemand", sample: "Falsches Üben von Xylophonmusik quält jeden größeren Zwerg." },
  { name: "Espagnol", sample: "El veloz murciélago hindú comía feliz cardillo y kiwi." },
  { name: "Portugais", sample: "Gazeta, ânsia, fé, açúcar, órgão: palavras do português." },
  { name: "Italien", sample: "Pranzo d'acqua fa volti sghembi." },
  { name: "Néerlandais", sample: "Lynx c.q. vos prikt bh: dag zwemjuf!" },
  { name: "Catalan", sample: "Jove xef, porti whisky amb quinze glaçons d'hidrogen, coi!" },
  { name: "Suédois", sample: "Yxmördaren Julia Blomqvist på fäktning i Schweiz." },
  { name: "Danois & norvégien", sample: "Høj bly gom vandt fræk sexquiz på wc." },
  { name: "Polonais", sample: "Pchnąć w tę łódź jeża lub ośm skrzyń fig." },
  { name: "Tchèque", sample: "Příliš žluťoučký kůň úpěl ďábelské ódy." },
  { name: "Hongrois", sample: "Árvíztűrő tükörfúrógép." },
  { name: "Roumain", sample: "Înjurând pițigăiat, zoofobul comandă vexat whisky și tequila." },
  { name: "Turc", sample: "Pijamalı hasta yağız şoföre çabucak güvendi." },
  { name: "Vietnamien", sample: "Tiếng Việt có dấu: ă â ê ô ơ ư đ, sắc huyền hỏi ngã nặng." },
  { name: "Grec", sample: "Ξεσκεπάζω την ψυχοφθόρα βδελυγμία." },
  { name: "Russe", sample: "Съешь же ещё этих мягких французских булок, да выпей чаю." },
  { name: "Ukrainien", sample: "Чуєш їх, доцю, га? Кумедна ж ти, прощайся без ґольфів!" },
  { name: "Hébreu", sample: "דג סקרן שט בים מאוכזב ולפתע מצא חברה", rtl: true },
  { name: "Arabe", sample: "نص حكيم له سر قاطع وذو شأن عظيم", rtl: true },
  { name: "Hindi", sample: "ऋषियों को सताने वाले दुष्ट राक्षसों का राजा रावण" },
  { name: "Thaï", sample: "เป็นมนุษย์สุดประเสริฐเลิศคุณค่า" },
  { name: "Japonais", sample: "いろはにほへと ちりぬるを わかよたれそ" },
  { name: "Coréen", sample: "키스의 고유조건은 입술끼리 만나야 하고" },
  { name: "Chinois", sample: "天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。" },
];

/** Original text for the specimen tab. */
export const SPECIMEN = {
  title: "Le carnet des ateliers",
  alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 &@#%?!«»",
  paragraphs: [
    "Au bord du canal, l'imprimerie ouvre ses volets avant l'aube. On y compose encore quelques affiches à la main, lettre après lettre, pendant que le café refroidit sur l'établi.",
    "Chaque caractère a son tiroir et chaque tiroir son histoire. Les apprentis apprennent d'abord à reconnaître les formes au toucher : l'empattement d'un e, la boucle d'un g, la queue d'un Q.",
    "Le soir, les épreuves sèchent sur des fils tendus au-dessus des presses. Une virgule mal placée suffit pour tout recommencer ; personne ne s'en plaint vraiment.",
  ],
  figures: "0123456789 · 1 250,00 € · 48 % · 09:30–17:45 · n° 12 · ½ ¾",
};

/** Glyph categories for the character grid. */
export const GLYPH_GROUPS: [string, string, (cp: number) => boolean][] = [
  ["all", "Tout", () => true],
  ["upper", "Majuscules", (cp) => /\p{Lu}/u.test(String.fromCodePoint(cp))],
  ["lower", "Minuscules", (cp) => /\p{Ll}/u.test(String.fromCodePoint(cp))],
  ["digits", "Chiffres", (cp) => /\p{N}/u.test(String.fromCodePoint(cp))],
  ["punct", "Ponctuation", (cp) => /\p{P}/u.test(String.fromCodePoint(cp))],
  ["symbols", "Symboles", (cp) => /\p{S}/u.test(String.fromCodePoint(cp))],
  ["latin", "Latin étendu", (cp) => cp > 0x7f && /\p{Script=Latin}/u.test(String.fromCodePoint(cp))],
  [
    "other",
    "Autres écritures",
    (cp) => /\p{L}/u.test(String.fromCodePoint(cp)) && !/\p{Script=Latin}/u.test(String.fromCodePoint(cp)),
  ],
];
