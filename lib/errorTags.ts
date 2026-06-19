import { ErrorTag } from "./types";

const TAG_ORDER: ErrorTag[] = [
  "tense_error",
  "missing_article",
  "wrong_article",
  "preposition_error",
  "clause_word_order",
  "subject_verb_agreement",
  "passive_voice_error",
  "relative_clause_error",
  "conjunction_error",
  "word_choice",
  "omission",
  "spelling_or_punctuation",
  "other"
];

const DIRECT_ALIASES: Record<string, ErrorTag> = {
  tense: "tense_error",
  tense_error: "tense_error",
  verb_tense: "tense_error",
  article_missing: "missing_article",
  missing_article: "missing_article",
  "article missing": "missing_article",
  article: "wrong_article",
  wrong_article: "wrong_article",
  preposition: "preposition_error",
  preposition_error: "preposition_error",
  word_order: "clause_word_order",
  clause_word_order: "clause_word_order",
  subject_verb_agreement: "subject_verb_agreement",
  sva: "subject_verb_agreement",
  passive: "passive_voice_error",
  passive_voice: "passive_voice_error",
  passive_voice_error: "passive_voice_error",
  relative_clause: "relative_clause_error",
  relative_clause_error: "relative_clause_error",
  conjunction: "conjunction_error",
  conjunction_error: "conjunction_error",
  word_choice: "word_choice",
  vocabulary: "word_choice",
  omission: "omission",
  missing_info: "omission",
  spelling: "spelling_or_punctuation",
  punctuation: "spelling_or_punctuation",
  spelling_or_punctuation: "spelling_or_punctuation",
  other: "other"
};

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagFor(raw: string): ErrorTag {
  const normalized = normalizeText(raw);
  const compact = normalized.replace(/\s+/g, "_");
  if (DIRECT_ALIASES[normalized]) return DIRECT_ALIASES[normalized];
  if (DIRECT_ALIASES[compact]) return DIRECT_ALIASES[compact];

  if (/时态|tense|verb form|动词形式/.test(normalized)) return "tense_error";
  if (/冠词.*(缺|漏)|缺.*冠词|漏.*冠词|missing.*article|article.*missing/.test(normalized)) return "missing_article";
  if (/冠词|article|限定词|determiner/.test(normalized)) return "wrong_article";
  if (/介词|preposition|搭配/.test(normalized)) return "preposition_error";
  if (/语序|word order|从句.*顺序|clause.*order/.test(normalized)) return "clause_word_order";
  if (/主谓一致|subject.?verb|三单|第三人称单数/.test(normalized)) return "subject_verb_agreement";
  if (/被动|passive/.test(normalized)) return "passive_voice_error";
  if (/定语从句|关系从句|relative clause|关系代词|who|which|that/.test(normalized)) return "relative_clause_error";
  if (/连接词|连词|conjunction|because|although|if|when/.test(normalized)) return "conjunction_error";
  if (/用词|词汇|word choice|vocabulary|表达不自然/.test(normalized)) return "word_choice";
  if (/遗漏|漏译|omission|missing info|信息缺失/.test(normalized)) return "omission";
  if (/拼写|标点|spelling|punctuation/.test(normalized)) return "spelling_or_punctuation";
  return "other";
}

export function normalizeErrorTags(raw: string[]): ErrorTag[] {
  const seen = new Set<ErrorTag>();
  for (const item of raw) {
    const text = typeof item === "string" ? item.trim() : "";
    if (!text) continue;
    seen.add(tagFor(text));
  }
  return TAG_ORDER.filter((tag) => seen.has(tag));
}
