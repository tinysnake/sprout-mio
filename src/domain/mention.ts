/** 一处点名的落点：`start`/`end` 是 body 的字符下标，`end` 开区间，span 含 `@`。 */
export type MentionSpan = {
  memberKind: "agent" | "human";
  memberId: string;
  start: number;
  end: number;
};

/** 参与匹配的成员名。名字在全局唯一，这是下面不做词边界判断的前提。 */
export type MentionCandidate = {
  memberKind: "agent" | "human";
  memberId: string;
  name: string;
};

/**
 * 一条消息体里点名了谁。纯函数：只读 body 与调用点传入的成员名，不查库。
 *
 * 规则：
 * 1. 只在 `@` 之后找候选名，span 覆盖 `@名字`；
 * 2. 同一个 `@` 位置多个候选都能匹配时取最长名字，等长时取候选表里靠前的那个；
 * 3. 从左到右扫描，命中后跳过整个 span，因此 span 之间不重叠，同一个 `start` 只产出一条。
 *
 * 不做词边界判断：名字全局唯一，`@` 前缀已经把误报压得足够低，而成员名可以是中文、
 * 带空格或带标点，按字符类划边界反而会漏掉真实点名。名字按字面比较，用 `startsWith`
 * 而不是拼正则，名字里的 `.` 之类的元字符不会改变匹配结果，也不会在运行期炸。
 */
export function resolveMentions(body: string, candidates: MentionCandidate[]): MentionSpan[] {
  const spans: MentionSpan[] = [];
  if (body.length === 0) return spans;
  const named = candidates.filter((candidate) => candidate.name.length > 0);
  if (named.length === 0) return spans;

  let from = 0;
  for (;;) {
    const at = body.indexOf("@", from);
    if (at < 0) return spans;
    const matched = longestNameAt(body, at + 1, named);
    if (!matched) {
      from = at + 1;
      continue;
    }
    const end = at + 1 + matched.name.length;
    spans.push({
      memberKind: matched.memberKind,
      memberId: matched.memberId,
      start: at,
      end,
    });
    from = end;
  }
}

function longestNameAt(
  body: string,
  nameStart: number,
  named: readonly MentionCandidate[],
): MentionCandidate | undefined {
  let best: MentionCandidate | undefined;
  for (const candidate of named) {
    if (!body.startsWith(candidate.name, nameStart)) continue;
    if (!best || candidate.name.length > best.name.length) best = candidate;
  }
  return best;
}
