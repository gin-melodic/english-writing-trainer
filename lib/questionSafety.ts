function toText(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isLeakySkillLabel(label: string) {
  return (
    /[A-Za-z]/.test(label) ||
    /[+＝=<>]/.test(label) ||
    /(答案|参考|必须|使用|用于|表示|主句|从句|过去时间|完成时态|部分与整体|关系|搭配正确|变形|过去分词|动词原形)/.test(label)
  );
}

export function publicQuestionSkills(value: unknown) {
  const items = Array.isArray(value) ? value : [value];
  return [...new Set(items
    .map(toText)
    .filter((item) => item.length >= 2 && item.length <= 18)
    .filter((item) => !isLeakySkillLabel(item)))]
    .slice(0, 4);
}
