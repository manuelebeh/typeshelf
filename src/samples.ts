import { N_, t } from "./i18n";

/** Sample texts used by the specimen and language views. */

export interface Language {
  name: string;
  sample: string;
  rtl?: boolean;
}

/** Traditional pangrams (or short typical sentences) per language. */
export const LANGUAGES: Language[] = [
  { name: N_("French"), sample: "Portez ce vieux whisky au juge blond qui fume." },
  { name: N_("English"), sample: "Sphinx of black quartz, judge my vow." },
  { name: N_("German"), sample: "Falsches Üben von Xylophonmusik quält jeden größeren Zwerg." },
  { name: N_("Spanish"), sample: "El veloz murciélago hindú comía feliz cardillo y kiwi." },
  { name: N_("Portuguese"), sample: "Gazeta, ânsia, fé, açúcar, órgão: palavras do português." },
  { name: N_("Italian"), sample: "Pranzo d'acqua fa volti sghembi." },
  { name: N_("Dutch"), sample: "Lynx c.q. vos prikt bh: dag zwemjuf!" },
  { name: N_("Catalan"), sample: "Jove xef, porti whisky amb quinze glaçons d'hidrogen, coi!" },
  { name: N_("Swedish"), sample: "Yxmördaren Julia Blomqvist på fäktning i Schweiz." },
  { name: N_("Danish & Norwegian"), sample: "Høj bly gom vandt fræk sexquiz på wc." },
  { name: N_("Polish"), sample: "Pchnąć w tę łódź jeża lub ośm skrzyń fig." },
  { name: N_("Czech"), sample: "Příliš žluťoučký kůň úpěl ďábelské ódy." },
  { name: N_("Hungarian"), sample: "Árvíztűrő tükörfúrógép." },
  { name: N_("Romanian"), sample: "Înjurând pițigăiat, zoofobul comandă vexat whisky și tequila." },
  { name: N_("Turkish"), sample: "Pijamalı hasta yağız şoföre çabucak güvendi." },
  { name: N_("Vietnamese"), sample: "Tiếng Việt có dấu: ă â ê ô ơ ư đ, sắc huyền hỏi ngã nặng." },
  { name: N_("Greek"), sample: "Ξεσκεπάζω την ψυχοφθόρα βδελυγμία." },
  { name: N_("Russian"), sample: "Съешь же ещё этих мягких французских булок, да выпей чаю." },
  { name: N_("Ukrainian"), sample: "Чуєш їх, доцю, га? Кумедна ж ти, прощайся без ґольфів!" },
  { name: N_("Hebrew"), sample: "דג סקרן שט בים מאוכזב ולפתע מצא חברה", rtl: true },
  { name: N_("Arabic"), sample: "نص حكيم له سر قاطع وذو شأن عظيم", rtl: true },
  { name: N_("Hindi"), sample: "ऋषियों को सताने वाले दुष्ट राक्षसों का राजा रावण" },
  { name: N_("Thai"), sample: "เป็นมนุษย์สุดประเสริฐเลิศคุณค่า" },
  { name: N_("Japanese"), sample: "いろはにほへと ちりぬるを わかよたれそ" },
  { name: N_("Korean"), sample: "키스의 고유조건은 입술끼리 만나야 하고" },
  { name: N_("Chinese"), sample: "天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。" },
];

/** Original text for the specimen tab. */
export const specimen = () => ({
  title: t("The Workshop Notebook"),
  alphabet: t("ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 &@#%?!"),
  paragraphs: [
    t("By the canal, the print shop opens its shutters before dawn. A few posters are still set by hand, letter after letter, while the coffee goes cold on the workbench."),
    t("Every character has its drawer and every drawer its story. Apprentices first learn to recognize shapes by touch: the serif of an e, the loop of a g, the tail of a Q."),
    t("In the evening, the proofs dry on lines strung above the presses. One misplaced comma is enough to start over; nobody really complains."),
  ],
  figures: t("0123456789 · $1,250.00 · 48% · 09:30–17:45 · No. 12 · ½ ¾"),
});

/** Glyph categories for the character grid. */
export const GLYPH_GROUPS: [string, string, (cp: number) => boolean][] = [
  ["all", N_("All characters"), () => true],
  ["upper", N_("Uppercase"), (cp) => /\p{Lu}/u.test(String.fromCodePoint(cp))],
  ["lower", N_("Lowercase"), (cp) => /\p{Ll}/u.test(String.fromCodePoint(cp))],
  ["digits", N_("Digits"), (cp) => /\p{N}/u.test(String.fromCodePoint(cp))],
  ["punct", N_("Punctuation"), (cp) => /\p{P}/u.test(String.fromCodePoint(cp))],
  ["symbols", N_("Symbols"), (cp) => /\p{S}/u.test(String.fromCodePoint(cp))],
  ["latin", N_("Extended Latin"), (cp) => cp > 0x7f && /\p{Script=Latin}/u.test(String.fromCodePoint(cp))],
  [
    "other",
    N_("Other scripts"),
    (cp) => /\p{L}/u.test(String.fromCodePoint(cp)) && !/\p{Script=Latin}/u.test(String.fromCodePoint(cp)),
  ],
];
