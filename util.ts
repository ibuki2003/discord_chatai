const DEFAULT_LIMIT = 2000;

function extractFenceLang(text: string, start: number): string {
  const rest = text.slice(start);
  const lineBreak = rest.search(/[\r\n]/);
  const lang = lineBreak === -1 ? rest : rest.slice(0, lineBreak);
  return lang.trim();
}

type SplitCandidate = {
  index: number;
  inside: boolean;
  lang: string;
};

function buildSegment(
  content: string,
  prefix: string,
  candidate: SplitCandidate,
  limit: number,
): { segment: string; nextPrefix: string; used: number } | null {
  let used = candidate.index;
  let body = prefix + content.slice(0, used);

  if (candidate.inside) {
    const needsLeadingBreak = !body.endsWith("\n");
    const closingFence = `${needsLeadingBreak ? "\n" : ""}\`\`\``;
    const overflow = body.length + closingFence.length - limit;

    if (overflow > 0) {
      used = Math.max(1, used - overflow);
      body = prefix + content.slice(0, used);
    }

    const finalNeedsBreak = !body.endsWith("\n");
    const finalClosingFence = `${finalNeedsBreak ? "\n" : ""}\`\`\``;
    if (body.length + finalClosingFence.length > limit) return null;

    return {
      segment: body + finalClosingFence,
      nextPrefix: `\`\`\`${candidate.lang ? candidate.lang : ""}\n`,
      used,
    };
  }

  if (body.length > limit) {
    used = Math.max(1, used - (body.length - limit));
    body = prefix + content.slice(0, used);
    if (body.length > limit) return null;
  }

  return {
    segment: body,
    nextPrefix: "",
    used,
  };
}

export function splitForDiscord(
  content: string,
  limit: number = DEFAULT_LIMIT,
): string[] {
  if (content.length <= limit) return [content];

  const segments: string[] = [];
  let cursor = 0;
  let inside = false;
  let lang = "";
  let prefix = "";

  while (cursor < content.length) {
    const currentPrefix = prefix;
    prefix = "";

    const remaining = content.slice(cursor);
    if (currentPrefix.length + remaining.length <= limit) {
      segments.push(currentPrefix + remaining);
      break;
    }

    const availableLimit = limit - currentPrefix.length;
    if (availableLimit <= 0) {
      segments.push(currentPrefix.slice(0, limit));
      // cursor = cursor; // stay to avoid skipping original content
      continue;
    }

    let scanInside = inside;
    let scanLang = lang;
    let outsideCandidate: SplitCandidate | null = null;
    let insideCandidate: SplitCandidate | null = null;

    let i = 0;
    const reserve = inside ? 4 : 0; // space for closing fence when cutting inside code block
    const maxScan = Math.min(
      remaining.length,
      Math.max(1, availableLimit - reserve),
    );
    while (i < maxScan) {
      if (remaining.startsWith("```", i)) {
        if (scanInside) {
          scanInside = false;
          scanLang = "";
        } else {
          scanLang = extractFenceLang(remaining, i + 3);
          scanInside = true;
        }
        i += 3;
        continue;
      }

      if (remaining[i] === "\n") {
        const cand: SplitCandidate = {
          index: i + 1,
          inside: scanInside,
          lang: scanLang,
        };
        if (scanInside) {
          insideCandidate = cand;
        } else {
          outsideCandidate = cand;
        }
      }

      i += 1;
    }

    const fallback: SplitCandidate = {
      index: maxScan,
      inside: scanInside,
      lang: scanLang,
    };

    const pickOrder = [outsideCandidate, insideCandidate, fallback];
    let selected: { segment: string; nextPrefix: string; used: number } | null =
      null;
    for (const cand of pickOrder) {
      if (!cand) continue;
      selected = buildSegment(remaining, currentPrefix, cand, limit);
      if (selected) break;
    }

    if (!selected) {
      const forced: SplitCandidate = {
        index: Math.max(1, availableLimit - 4),
        inside: scanInside,
        lang: scanLang,
      };
      selected = buildSegment(remaining, currentPrefix, forced, limit);
      if (!selected) break;
    }

    segments.push(selected.segment);
    cursor += selected.used;
    prefix = selected.nextPrefix;
    inside = prefix.length > 0;
    lang = inside ? fallback.lang : "";
  }

  return segments;
}
