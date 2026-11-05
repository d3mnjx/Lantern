// Tools that let the model read a file that is too large for its context.
// The file stays in the browser. The model asks for parts of it with tool calls,
// and only the results go into the context. This is how agent tools such as
// Claude Code work with large files: they read ranges and search instead of loading everything.

// One result must stay small: digit-heavy logs are about 1.3 characters per token,
// so 16,000 characters is about 12,000 tokens, and a long tool loop still fits.
const MAX_OUTPUT = 16000;
const MAX_LINE = 500;
const MAX_LINES = 200;

const linesCache = new WeakMap();
function linesOf(file) {
  let lines = linesCache.get(file);
  if (!lines) {
    lines = file.data.replace(/\r?\n$/, '').split(/\r?\n/);
    linesCache.set(file, lines);
  }
  return lines;
}

export function toolDefinitions(names) {
  const file = { type: 'string', enum: names, description: 'Name of the attached file.' };
  return [
    {
      type: 'function',
      function: {
        name: 'read_lines',
        description: 'Read a range of lines from an attached file. Line numbers start at 1. ' +
          'A negative start counts from the end: start -100 reads the last 100 lines. Returns at most 200 lines.',
        parameters: {
          type: 'object',
          properties: {
            file,
            start: { type: 'integer', description: 'First line (1-based), or negative to count from the end.' },
            count: { type: 'integer', description: 'Number of lines, 1 to 200. Default 50.' },
          },
          required: ['file', 'start'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search an attached file line by line with a JavaScript regular expression. ' +
          'Returns the total number of matching lines and the first matches with their line numbers. ' +
          'With count_by_group=true, the pattern needs one capture group, and the result is a table of how often ' +
          'each captured value occurs (top 100). Use this to count or group, for example by status code, IP, or hour.',
        parameters: {
          type: 'object',
          properties: {
            file,
            pattern: { type: 'string', description: 'JavaScript regular expression, without slashes.' },
            ignore_case: { type: 'boolean' },
            max_results: { type: 'integer', description: 'Matching lines to return, 1 to 200. Default 50.' },
            count_by_group: { type: 'boolean', description: 'Count the values of capture group 1 instead of listing lines.' },
          },
          required: ['file', 'pattern'],
        },
      },
    },
  ];
}

// The text that stands in for the file in the user message.
export function toolFileNote(file) {
  const lines = linesOf(file);
  const sample = lines.slice(0, 5).map(cut).join('\n');
  return `File: ${file.name} is too large to include (${lines.length.toLocaleString('en-US')} lines, about ` +
    `${file.tokens.toLocaleString('en-US')} tokens). Use the read_lines and grep tools to read it. First lines:\n` +
    '```\n' + sample + '\n```';
}

// Returns the result text for one tool call. Errors are text too: the model reads them and can try again.
export function runTool(files, call) {
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return 'Error: the arguments are not valid JSON.';
  }
  // A single file is unambiguous, so accept a wrong or missing name for it.
  const file = files.get(args.file) ?? (files.size === 1 ? [...files.values()][0] : null);
  if (!file) return `Error: unknown file "${args.file}". Files: ${[...files.keys()].join(', ')}`;
  const lines = linesOf(file);

  switch (call.function.name) {
    case 'read_lines': {
      const count = clamp(args.count ?? 50, 1, MAX_LINES);
      let start = Math.trunc(Number(args.start) || 1);
      if (start < 0) start = lines.length + start + 1;
      start = clamp(start, 1, lines.length);
      const out = lines.slice(start - 1, start - 1 + count).map((line, i) => `${start + i}: ${cut(line)}`);
      return limit(`Lines ${start}-${start + out.length - 1} of ${lines.length}:\n${out.join('\n')}`);
    }
    case 'grep': {
      let re;
      try {
        re = new RegExp(String(args.pattern ?? ''), args.ignore_case ? 'i' : '');
      } catch (e) {
        return `Error: invalid pattern: ${e.message}`;
      }
      if (args.count_by_group) {
        const counts = new Map();
        let total = 0;
        for (const line of lines) {
          const m = re.exec(line);
          if (!m) continue;
          total++;
          const key = m[1] ?? m[0];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 100);
        return limit(`${total} matching lines, ${counts.size} distinct values` +
          `${counts.size > top.length ? `, top ${top.length} shown` : ''}:\n` +
          top.map(([value, n]) => `${n}\t${cut(value)}`).join('\n'));
      }
      const max = clamp(args.max_results ?? 50, 1, MAX_LINES);
      const out = [];
      let total = 0;
      lines.forEach((line, i) => {
        if (!re.test(line)) return;
        total++;
        if (out.length < max) out.push(`${i + 1}: ${cut(line)}`);
      });
      return limit(`${total} matching lines of ${lines.length}` +
        `${total > out.length ? `, first ${out.length} shown` : ''}:\n${out.join('\n')}`);
    }
    default:
      return `Error: unknown tool "${call.function.name}".`;
  }
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, Math.trunc(Number(n)) || min));
}

function cut(line) {
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) + ' [line cut]' : line;
}

function limit(text) {
  return text.length > MAX_OUTPUT
    ? text.slice(0, MAX_OUTPUT) + '\n[Output cut. Ask for fewer lines or a narrower pattern.]'
    : text;
}
