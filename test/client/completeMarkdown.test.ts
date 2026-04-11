import { describe, it, expect } from 'vitest';
import { completeMarkdown } from '../../src/lib/completeMarkdown';

describe('completeMarkdown', () => {
  // --- Code blocks ---
  it('closes an unclosed code block', () => {
    const input = '```python\ndef hello():\n    print("hi")';
    const result = completeMarkdown(input);
    expect(result).toBe('```python\ndef hello():\n    print("hi")\n```');
  });

  it('leaves closed code blocks alone', () => {
    const input = '```python\ndef hello():\n```';
    expect(completeMarkdown(input)).toBe(input);
  });

  it('handles multiple code blocks, last unclosed', () => {
    const input = '```js\nfoo\n```\n\ntext\n\n```python\nbar';
    const result = completeMarkdown(input);
    expect(result).toContain('bar\n```');
  });

  it('handles code block with language tag', () => {
    const input = '```typescript\nconst x = 1;';
    const result = completeMarkdown(input);
    expect(result.endsWith('\n```')).toBe(true);
  });

  // --- Bold ---
  it('closes unclosed bold', () => {
    const input = 'Here is **bold text';
    const result = completeMarkdown(input);
    expect(result).toBe('Here is **bold text**');
  });

  it('leaves closed bold alone', () => {
    const input = 'Here is **bold** text';
    expect(completeMarkdown(input)).toBe(input);
  });

  it('does not close bold inside code blocks', () => {
    const input = '```\n**not bold\n```';
    expect(completeMarkdown(input)).toBe(input);
  });

  // --- Inline code ---
  it('closes unclosed inline code', () => {
    const input = 'Use the `git rebase';
    const result = completeMarkdown(input);
    expect(result).toBe('Use the `git rebase`');
  });

  it('leaves closed inline code alone', () => {
    const input = 'Use `git rebase` for this';
    expect(completeMarkdown(input)).toBe(input);
  });

  it('does not count triple backticks as single', () => {
    const input = '```python\ncode\n```\nUse `command';
    const result = completeMarkdown(input);
    // The code block is closed, but the inline ` is unclosed
    expect(result).toBe('```python\ncode\n```\nUse `command`');
  });

  // --- Combined ---
  it('handles code block + unclosed bold together', () => {
    const input = '```js\ncode\n```\n\n**Step 1:';
    const result = completeMarkdown(input);
    expect(result).toBe('```js\ncode\n```\n\n**Step 1:**');
  });

  it('handles empty text', () => {
    expect(completeMarkdown('')).toBe('');
  });

  it('handles text with no markdown', () => {
    const input = 'Hello world!';
    expect(completeMarkdown(input)).toBe(input);
  });

  // --- Edge cases ---
  it('handles bold inside unclosed code block (should not close bold)', () => {
    const input = '```\n**something';
    const result = completeMarkdown(input);
    // Code block gets closed, but ** inside it shouldn't be closed
    expect(result).toBe('```\n**something\n```');
    // Should NOT have extra ** appended
    expect(result).not.toContain('****');
  });
});
