// A small Markdown renderer for model output. It covers what chat models write:
// fenced code, headings, lists (nested), quotes, tables, rules, and inline styles.
// Safety rule: every piece of source text goes through esc() before it reaches the output,
// and the only raw HTML is the tags this file writes. Do not add a path that skips esc().

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = line => line.match(/^\s*/)[0].length;
const startsBlock = (line, next) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTable(line, next);
const isTable = (line, next) => line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-');

export function renderMarkdown(src) {
  return blocks(src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

function blocks(lines) {
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      i++;
    } else if ((m = line.match(FENCE))) {
      // An open fence runs to the end of the text. This keeps code intact while it streams in.
      const [, pad, fence, lang] = m;
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++)
        body.push(lines[i].slice(Math.min(pad.length, indentOf(lines[i]))));
      i++;
      out += codeBlock(body.join('\n'), lang);
    } else if ((m = line.match(HEADING))) {
      out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
      i++;
    } else if (RULE.test(line)) {
      out += '<hr>';
      i++;
    } else if (QUOTE.test(line)) {
      const body = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''));
      out += `<blockquote>${blocks(body)}</blockquote>`;
    } else if (ITEM.test(line)) {
      const [html, next] = list(lines, i);
      out += html;
      i = next;
    } else if (isTable(line, lines[i + 1])) {
      const rows = [line];
      const sep = cells(lines[i + 1]);
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(lines[i]);
      out += table(rows, sep);
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1])); i++)
        para.push(lines[i].trim());
      out += `<p>${inline(para.join('\n'))}</p>`;
    }
  }
  return out;
}

function codeBlock(code, lang) {
  // The copy button is wired by one delegated click handler in app.js.
  return `<div class="code"><div class="code-head"><span>${esc(lang)}</span>` +
    `<button type="button" class="copy-code">Copy</button></div><pre><code>${esc(code)}</code></pre></div>`;
}

// Parses one list from lines[start]. Returns the HTML and the index after the list.
function list(lines, start) {
  const first = lines[start].match(ITEM);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(ITEM);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = base + m[2].length + 1;
    const body = [m[3]];
    for (i++; i < lines.length; ) {
      const l = lines[i];
      if (!l.trim()) {
        // A blank line ends the item unless indented content or a sibling item follows it.
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) > base) {
          for (; i < j; i++) body.push('');
          continue;
        }
        const sibling = j < lines.length && lines[j].match(ITEM);
        if (sibling && sibling[1].length === base) i = j;
        break;
      }
      if (indentOf(l) > base) {
        body.push(l.slice(Math.min(indentOf(l), contentIndent)));
        i++;
      } else if (startsBlock(l, lines[i + 1])) {
        break;
      } else {
        body.push(l.trim()); // A lazy continuation of the item's paragraph.
        i++;
      }
    }
    items.push(`<li>${blocks(body)}</li>`);
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && parseInt(first[2]) !== 1 ? ` start="${parseInt(first[2])}"` : '';
  return [`<${tag}${startAttr}>${items.join('')}</${tag}>`, i];
}

function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
}

function table(rows, sep) {
  const align = sep.map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
  const cell = (tag, text, n) => `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ''}>${inline(text)}</${tag}>`;
  const [head, ...body] = rows.map(cells);
  return `<div class="table"><table><thead><tr>${head.map((c, n) => cell('th', c, n)).join('')}</tr></thead>` +
    `<tbody>${body.map(r => `<tr>${head.map((_, n) => cell('td', r[n] ?? '', n)).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const safeUrl = url => /^(https?:|mailto:)/i.test(url);

function inline(text) {
  // Code spans and links go into a stash first, so the emphasis rules cannot change their insides.
  const stash = [];
  const keep = html => `\u0000${stash.push(html) - 1}\u0000`;
  let s = text.replace(/\u0000/g, '');
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) => keep(`<code>${esc(code)}</code>`));
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;.*?&quot;)?\)/g, (m, label, url) =>
    safeUrl(url) ? keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${emphasis(label)}</a>`) : m);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,:;'")\]])/g, (_, before, url) =>
    before + keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  s = emphasis(s).replace(/ {2,}\n|\\\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[n]);
}

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)__(?=\S)([\s\S]*?\S)__(?=\W|$)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([^*\n]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/(^|\W)_(?=[^\s_])([^_\n]*?[^\s_])_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}
