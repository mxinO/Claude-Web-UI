/**
 * Auto-close unclosed markdown elements in streaming text.
 *
 * During streaming, partial markdown (e.g. an unclosed ``` code block)
 * won't render correctly. This function detects unclosed elements and
 * appends closing markers so react-markdown can render them properly.
 *
 * Handles: code blocks (```), bold (**), inline code (`)
 * Skips: italic (*), strikethrough (~~), links — too ambiguous or low impact.
 */
export function completeMarkdown(text: string): string {
  // Step 1: Close unclosed code blocks
  let result = closeCodeBlocks(text);

  // Step 2: In regions outside code blocks, close ** and `
  result = closeInlineMarkers(result);

  return result;
}

/**
 * Count ``` fences. If odd, append a closing one.
 */
function closeCodeBlocks(text: string): string {
  // Match lines that are code fences: optional whitespace + ``` + optional language
  const fenceRegex = /^[ \t]*```/gm;
  let count = 0;
  while (fenceRegex.exec(text) !== null) count++;

  if (count % 2 === 1) {
    // Odd = unclosed code block. Append closing fence.
    // Ensure there's a newline before the closing fence.
    return text + (text.endsWith('\n') ? '' : '\n') + '```';
  }
  return text;
}

/**
 * Close unclosed ** and ` in regions outside of code blocks.
 */
function closeInlineMarkers(text: string): string {
  // Split text into code-block and non-code-block regions
  const parts = splitByCodeBlocks(text);
  let result = '';
  let suffix = '';

  for (const part of parts) {
    result += part.text;
    if (part.isCode) continue; // skip counting inside code blocks

    // Count ** in this non-code region
    const boldCount = countOccurrences(part.text, '**');
    if (boldCount % 2 === 1) {
      suffix += '**';
    }

    // Count single ` (not part of ```)
    const singleBacktickCount = countSingleBackticks(part.text);
    if (singleBacktickCount % 2 === 1) {
      suffix += '`';
    }
  }

  return result + suffix;
}

/**
 * Split text into alternating regions: outside code blocks and inside code blocks.
 */
function splitByCodeBlocks(text: string): Array<{ text: string; isCode: boolean }> {
  const parts: Array<{ text: string; isCode: boolean }> = [];
  const fenceRegex = /^[ \t]*```.*$/gm;
  let lastIdx = 0;
  let insideCode = false;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    // Text before this fence
    if (match.index > lastIdx) {
      parts.push({ text: text.slice(lastIdx, match.index), isCode: insideCode });
    }
    // The fence line itself — part of the code region
    parts.push({ text: match[0], isCode: true });
    lastIdx = match.index + match[0].length;
    insideCode = !insideCode;
  }

  // Remaining text after last fence
  if (lastIdx < text.length) {
    parts.push({ text: text.slice(lastIdx), isCode: insideCode });
  }

  return parts;
}

/**
 * Count non-overlapping occurrences of a substring.
 */
function countOccurrences(text: string, sub: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(sub, idx)) !== -1) {
    count++;
    idx += sub.length;
  }
  return count;
}

/**
 * Count single backticks that are NOT part of triple backticks.
 * We need to exclude ``` from the count.
 */
function countSingleBackticks(text: string): number {
  // Remove all ``` first (replace with placeholder), then count remaining `
  const withoutTriple = text.replace(/```/g, '');
  // Also remove `` (double backtick delimiters used for inline code containing backticks)
  const withoutDouble = withoutTriple.replace(/``/g, '');
  let count = 0;
  for (const ch of withoutDouble) {
    if (ch === '`') count++;
  }
  return count;
}
