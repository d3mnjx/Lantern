import { renderMarkdown } from './markdown.js';
import { listChats, saveChat, deleteChat } from './store.js';
import { toolDefinitions, toolFileNote, runTool, MAX_OUTPUT } from './filetools.js';

const $ = id => document.getElementById(id);
const els = {
  sidebar: $('sidebar'), chatList: $('chat-list'), messages: $('messages'), empty: $('empty'),
  model: $('model'), serverStatus: $('server-status'), composer: $('composer'), input: $('input'),
  attachments: $('attachments'), note: $('composer-note'), send: $('send'), fileInput: $('file-input'),
  settings: $('settings'), dropOverlay: $('drop-overlay'),
};

// Big files are allowed because "Keep newest lines" can cut them down to fit the context.
const MAX_TEXT_FILE = 10 * 1024 * 1024;
// Above this size the exact count is slow and its reply (one number per token) is large, so estimate.
const MAX_EXACT_COUNT = 2 * 1024 * 1024;
// Room kept free for the reply when max tokens is not set. Reasoning models need a lot.
const OUTPUT_RESERVE = 8192;
const MAX_IMAGE_FILE = 20 * 1024 * 1024;

let chats = [];
let current = null;        // The open chat, or null for a new chat that has no messages yet.
let pendingFiles = [];     // Attachments for the next message.
let running = null;        // { controller, message } while a reply streams in.
let contextLimit = 0;      // max_model_len of the selected model, from /v1/models.

// --- Settings (per browser) ---

const settings = Object.assign({ system: '', temperature: '', maxTokens: '' }, readJson('lantern.settings'));

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)) ?? {}; } catch { return {}; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch { /* private mode */ }
}

$('open-settings').onclick = () => {
  $('set-system').value = settings.system;
  $('set-temperature').value = settings.temperature;
  $('set-max-tokens').value = settings.maxTokens;
  els.settings.showModal();
};
els.settings.addEventListener('close', () => {
  if (els.settings.returnValue !== 'save') return;
  settings.system = $('set-system').value;
  settings.temperature = $('set-temperature').value;
  settings.maxTokens = $('set-max-tokens').value;
  writeLocal('lantern.settings', settings);
});

// --- Models ---

let models = [];

async function loadModels() {
  try {
    const res = await fetch('api/models');
    if (!res.ok) throw new Error(await errorText(res));
    models = (await res.json()).data ?? [];
    let saved = '';
    try { saved = localStorage.getItem('lantern.model') ?? ''; } catch { }
    els.model.replaceChildren(...models.map(m => new Option(m.id, m.id, false, m.id === saved)));
    els.serverStatus.textContent = '';
    els.serverStatus.className = '';
    onModelChange();
  } catch (e) {
    els.serverStatus.textContent = 'Model server offline';
    els.serverStatus.className = 'bad';
    els.serverStatus.title = e.message;
    setTimeout(loadModels, 10000);
  }
}

function onModelChange() {
  contextLimit = models.find(m => m.id === els.model.value)?.max_model_len ?? 0;
  writeLocal('lantern.model', els.model.value);
  renderAttachments();
}
els.model.onchange = onModelChange;

// --- Sidebar ---

function renderChatList() {
  els.chatList.replaceChildren(...chats.map(chat => {
    const row = document.createElement('div');
    row.className = 'chat-row' + (chat === current ? ' active' : '');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-title';
    open.textContent = chat.title || 'Untitled';
    open.onclick = () => openChat(chat);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-delete';
    del.title = 'Delete chat';
    del.textContent = '×';
    del.onclick = async () => {
      if (!confirm(`Delete "${chat.title}"?`)) return;
      await deleteChat(chat.id);
      chats = chats.filter(c => c !== chat);
      if (chat === current) openChat(null);
      else renderChatList();
    };
    row.append(open, del);
    return row;
  }));
}

function openChat(chat) {
  if (running) running.controller.abort();
  current = chat;
  renderChatList();
  renderMessages();
  document.body.classList.remove('sidebar-open');
  els.input.focus();
}

$('new-chat').onclick = () => openChat(null);
$('toggle-sidebar').onclick = () => document.body.classList.toggle('sidebar-open');
$('scrim').onclick = () => document.body.classList.remove('sidebar-open');

// --- Messages ---

function renderMessages() {
  // Tool results show inside the assistant message that asked for them, not as their own messages.
  const nodes = (current?.messages ?? []).filter(m => m.role !== 'tool').map(messageNode);
  els.empty.hidden = nodes.length > 0;
  els.messages.replaceChildren(els.empty, ...nodes);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function messageNode(msg) {
  const node = document.createElement('article');
  node.className = `msg ${msg.role}`;
  node.message = msg;
  fillMessage(node);
  return node;
}

// Rebuilds the inside of one message element. Called on each streamed chunk for the live reply.
function fillMessage(node) {
  const msg = node.message;
  // Keep the thinking panel open across redraws if the user opened it during the stream.
  const thinkingOpen = node.querySelector('details.reasoning')?.open ?? false;
  node.replaceChildren();
  // A tool round is one step of a longer reply, so it sits close to the next step.
  node.classList.toggle('tool-round', Boolean(msg.tool_calls ?? msg.pendingCalls));

  if (msg.role === 'user') {
    if (msg.files?.length) node.append(fileChips(msg.files));
    if (msg.content) {
      const text = document.createElement('div');
      text.className = 'bubble';
      text.textContent = msg.content;
      node.append(text);
    }
    return;
  }

  const { reasoning, content } = splitThinking(msg);
  if (reasoning) {
    const details = document.createElement('details');
    details.className = 'reasoning';
    details.open = thinkingOpen;
    const summary = document.createElement('summary');
    summary.textContent = msg.thoughtSeconds != null ? `Thought for ${msg.thoughtSeconds} s`
      : (msg === running?.message && !content ? 'Thinking…' : 'Thoughts');
    const body = document.createElement('div');
    body.className = 'md';
    body.innerHTML = renderMarkdown(reasoning);
    details.append(summary, body);
    node.append(details);
  }
  if (content) {
    const body = document.createElement('div');
    body.className = 'md';
    body.innerHTML = renderMarkdown(content);
    node.append(body);
  } else if (msg === running?.message && !reasoning) {
    const dots = document.createElement('div');
    dots.className = 'typing';
    dots.textContent = '…';
    node.append(dots);
  }
  for (const call of msg.tool_calls ?? msg.pendingCalls ?? []) if (call) node.append(toolCallNode(call));
  if (msg.error) {
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = msg.error;
    node.append(err);
  }
  if (msg !== running?.message && !msg.tool_calls) node.append(messageFooter(msg));
}

// One line per tool call. It opens to show the exact result the model got.
function toolCallNode(call) {
  const details = document.createElement('details');
  details.className = 'tool-call';
  const summary = document.createElement('summary');
  let args = call.function.arguments;
  try {
    args = Object.entries(JSON.parse(args)).filter(([k]) => k !== 'file').map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
  } catch { /* still streaming: show the raw text */ }
  const result = current?.messages.find(m => m.role === 'tool' && m.tool_call_id === call.id)?.content;
  summary.textContent = `${call.function.name}(${args})` + (result ? ` \u2192 ${result.split('\n')[0]}` : ' \u2026');
  details.append(summary);
  if (result) {
    const pre = document.createElement('pre');
    pre.textContent = result;
    details.append(pre);
  }
  return details;
}

function messageFooter(msg) {
  const foot = document.createElement('div');
  foot.className = 'msg-foot';
  if (msg.stats) {
    const s = msg.stats;
    const parts = [];
    if (s.tokens != null) parts.push(`${s.tokens} tokens`);
    if (s.tokensPerSecond != null) parts.push(`${s.tokensPerSecond.toFixed(1)} tok/s`);
    if (s.firstTokenSeconds != null) parts.push(`first token ${s.firstTokenSeconds.toFixed(2)} s`);
    if (s.contextTokens != null && contextLimit) parts.push(`context ${fmt(s.contextTokens)} / ${fmt(contextLimit)}`);
    if (s.model) parts.push(s.model);
    if (msg.stopped) parts.push('stopped');
    const span = document.createElement('span');
    span.textContent = parts.join(' · ');
    foot.append(span);
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.onclick = () => copyText(splitThinking(msg).content, copy);
  foot.append(copy);
  if (current?.messages.at(-1) === msg) {
    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = 'Regenerate';
    again.onclick = () => {
      // A reply can be several messages (tool calls and results). Remove all of them.
      while (current.messages.at(-1)?.role !== 'user') current.messages.pop();
      generate();
    };
    foot.append(again);
  }
  return foot;
}

// vLLM sends thinking in delta.reasoning when it runs with a reasoning parser.
// Without the parser the model writes <think>...</think> into the content, so split that here too.
function splitThinking(msg) {
  let content = msg.content ?? '';
  let reasoning = msg.reasoning ?? '';
  const m = content.match(/^\s*<think>([\s\S]*?)(?:<\/think>|$)/);
  if (m) {
    reasoning += m[1];
    content = content.slice(m[0].length);
  }
  return { reasoning: reasoning.trim(), content: content.replace(/^\s+/, '') };
}

// --- Sending and streaming ---

els.composer.onsubmit = e => {
  e.preventDefault();
  if (running) {
    running.controller.abort();
    return;
  }
  const text = els.input.value.trim();
  if (!text && !pendingFiles.length) return;
  if (!els.model.value) {
    els.note.textContent = 'No model available.';
    return;
  }
  if (!current) {
    current = { id: newId(), title: (text || pendingFiles[0].name).slice(0, 60), updated: Date.now(), messages: [] };
    chats.unshift(current);
  }
  // A failed reply with no text adds nothing to the context, so drop it before the next turn.
  const last = current.messages.at(-1);
  if (last?.role === 'assistant' && last.error && !last.content) current.messages.pop();
  // The untrimmed copy is only for "Keep newest lines". Do not store it in the history.
  current.messages.push({ role: 'user', content: text, files: pendingFiles.map(({ original, ...f }) => f) });
  pendingFiles = [];
  els.input.value = '';
  autosize();
  renderAttachments();
  generate();
};

els.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});
els.input.addEventListener('input', autosize);
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 240) + 'px';
}

// The model may call file tools several times before it answers. Each round is one request.
const MAX_TOOL_ROUNDS = 20;

async function generate() {
  const chat = current;
  running = { controller: new AbortController(), message: null };
  setBusy(true);
  renderChatList();
  try {
    // Each tool round adds results to the context. Without a limit, a long loop fills the context,
    // and vLLM then cuts the model off in the middle of a tool call. So the loop ends with one
    // round without tools, in which the model must answer with what it found.
    let finalNote = null;
    for (let round = 0; ; round++) {
      const msg = await streamReply(chat, finalNote);
      if (!msg.tool_calls) break;
      const files = toolFiles(chat);
      // Results of one round may use at most half of the free room.
      const room = roomAfter(msg);
      const perCall = Math.floor(Math.min(MAX_OUTPUT, (room * CHARS_PER_TOKEN_MIN) / 2 / msg.tool_calls.length));
      let resultChars = 0;
      for (const call of msg.tool_calls) {
        const content = runTool(files, call, Math.max(500, perCall));
        resultChars += content.length;
        chat.messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
      if (round + 1 >= MAX_TOOL_ROUNDS)
        finalNote = `You used all ${MAX_TOOL_ROUNDS} tool rounds. Answer now with the information you have. Do not call tools.`;
      else if (roomAfter(msg, resultChars) < 0)
        finalNote = 'The context is almost full. Answer now with the information you have. Do not call tools.';
    }
  } finally {
    running = null;
    setBusy(false);
    chat.updated = Date.now();
    await saveChat(chat).catch(e => (els.note.textContent = `Cannot save chat: ${e.message}`));
    chats.sort((a, b) => b.updated - a.updated);
    renderChatList();
    if (chat === current) renderMessages();
  }
}

// Streams one model reply into a new assistant message and returns it.
// A reply that asks for tools gets msg.tool_calls. A stopped or failed reply never does,
// because a tool call without its result makes the next request invalid.
// With finalNote, the request has no tools, and the note goes in as a last user message.
// The note is not stored in the chat: it is an instruction for this one request.
async function streamReply(chat, finalNote = null) {
  const msg = { role: 'assistant', content: '', reasoning: '' };
  const request = {
    model: els.model.value,
    messages: apiMessages(chat),
    stream: true,
    stream_options: { include_usage: true },
  };
  const files = toolFiles(chat);
  if (finalNote) request.messages.push({ role: 'user', content: finalNote });
  else if (files.size) request.tools = toolDefinitions([...files.keys()]);
  if (settings.temperature !== '') request.temperature = Number(settings.temperature);
  if (settings.maxTokens !== '') request.max_tokens = Number(settings.maxTokens);

  chat.messages.push(msg);
  running.message = msg;
  if (chat === current) renderMessages();
  const node = els.messages.lastElementChild;

  const started = performance.now();
  const calls = [];
  let firstToken = null;
  let firstContent = null;
  let usage = null;
  let finish = null;
  let frame = 0;
  const redraw = () => {
    if (frame || chat !== current) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
      fillMessage(node);
      if (atBottom) els.messages.scrollTop = els.messages.scrollHeight;
    });
  };

  try {
    const res = await fetch('api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: running.controller.signal,
    });
    if (!res.ok) throw new Error(await errorText(res));
    for await (const chunk of readEvents(res.body)) {
      if (chunk.error) throw new Error(chunk.error.message ?? JSON.stringify(chunk.error));
      const delta = chunk.choices?.[0]?.delta;
      finish = chunk.choices?.[0]?.finish_reason ?? finish;
      const thought = delta?.reasoning ?? delta?.reasoning_content;
      if (thought || delta?.content || delta?.tool_calls) firstToken ??= performance.now();
      if (thought) msg.reasoning += thought;
      if (delta?.content) {
        if (msg.content === '' && delta.content.trim()) firstContent ??= performance.now();
        msg.content += delta.content;
      }
      // Tool calls arrive in pieces: the first piece has the id and name, later pieces add argument text.
      for (const part of delta?.tool_calls ?? []) {
        const call = (calls[part.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        msg.pendingCalls = calls;
      }
      if (chunk.usage) usage = chunk.usage;
      redraw();
    }
    if (finish === 'length') {
      // The reply was cut. A cut tool call has broken arguments, so it is not run.
      const used = usage ? usage.prompt_tokens + usage.completion_tokens : 0;
      msg.error = contextLimit && used >= contextLimit - 64
        ? `The reply stopped because the context is full (${fmt(used)} of ${fmt(contextLimit)} tokens). Start a new chat.`
        : 'The reply stopped at the Max tokens limit from Settings.';
    } else if (calls.length && !finalNote) {
      msg.tool_calls = calls.filter(Boolean);
    }
  } catch (e) {
    if (e.name === 'AbortError') msg.stopped = true;
    else msg.error = e.message;
  } finally {
    delete msg.pendingCalls;
    const ended = performance.now();
    if (frame) cancelAnimationFrame(frame);
    if (msg.reasoning && firstToken && firstContent) msg.thoughtSeconds = Math.round((firstContent - firstToken) / 1000);
    msg.stats = {
      model: request.model,
      tokens: usage?.completion_tokens,
      contextTokens: usage ? usage.prompt_tokens + usage.completion_tokens : undefined,
      firstTokenSeconds: firstToken ? (firstToken - started) / 1000 : undefined,
      tokensPerSecond: usage && firstToken && ended > firstToken
        ? usage.completion_tokens / ((ended - firstToken) / 1000) : undefined,
    };
  }
  return msg;
}

// Files in this chat that the model reads with tools instead of in the prompt. Later files win a name clash.
function toolFiles(chat) {
  const files = new Map();
  for (const m of chat.messages)
    for (const f of m.files ?? []) if (f.mode === 'tools') files.set(f.name, f);
  return files;
}

function apiMessages(chat) {
  const out = [];
  if (settings.system.trim()) out.push({ role: 'system', content: settings.system });
  for (const m of chat.messages) {
    if (m.role === 'assistant') {
      // Earlier thinking is not sent back. Chat templates drop it, and it costs context.
      const { content } = splitThinking(m);
      if (m.tool_calls) out.push({ role: 'assistant', content, tool_calls: m.tool_calls });
      else if (content) out.push({ role: 'assistant', content });
      continue;
    }
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
      continue;
    }
    const files = m.files ?? [];
    const textFiles = files.filter(f => f.kind === 'text').map(f => (f.mode === 'tools' ? toolFileNote(f) : fileBlock(f)));
    const text = [...textFiles, m.content].filter(Boolean).join('\n\n');
    const images = files.filter(f => f.kind === 'image');
    out.push({
      role: 'user',
      content: images.length
        ? [{ type: 'text', text }, ...images.map(f => ({ type: 'image_url', image_url: { url: f.data } }))]
        : text,
    });
  }
  return out;
}

// The fence is one backtick longer than any run inside the file, so file content cannot close it early.
function fileBlock(file) {
  const longest = Math.max(0, ...(file.data.match(/`+/g) ?? []).map(r => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const partial = file.partial ? ` (only the newest ${file.partial.kept} of ${file.partial.total} lines)` : '';
  return `File: ${file.name}${partial}\n${fence}\n${file.data}\n${fence}`;
}

async function* readEvents(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      yield JSON.parse(data);
    }
  }
}

async function errorText(res) {
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return json.error?.message ?? json.message ?? json.detail ?? text;
  } catch {
    return text || `${res.status} ${res.statusText}`;
  }
}

function setBusy(busy) {
  els.send.textContent = busy ? 'Stop' : 'Send';
  els.send.classList.toggle('stop', busy);
}

// --- Attachments ---

async function addFiles(list) {
  els.note.textContent = '';
  for (const file of list) {
    try {
      if (file.type.startsWith('image/')) {
        if (file.size > MAX_IMAGE_FILE) throw new Error('image is larger than 20 MB');
        pendingFiles.push({ name: file.name || 'pasted image', kind: 'image', data: await readDataUrl(file) });
      } else {
        if (file.size > MAX_TEXT_FILE) throw new Error('file is larger than 10 MB');
        const text = await file.text();
        // A NUL character means binary content. Models cannot use it, and it wastes context.
        if (text.includes('\u0000')) throw new Error('not a text file');
        const entry = { name: file.name, kind: 'text', data: text, ...(await countTokens(text)) };
        // A file that does not fit goes to tool mode: the model reads parts of it on request.
        if (entry.tokens > contextBudget() - textTokens(pendingFiles)) entry.mode = 'tools';
        pendingFiles.push(entry);
      }
    } catch (e) {
      els.note.textContent = `${file.name}: ${e.message}`;
    }
  }
  renderAttachments();
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Exact count from the vLLM tokenizer. A guess from the length is unsafe: prose is about
// 4 characters per token, but logs and CSV full of digits measure about 1.3.
async function countTokens(text) {
  if (text.length <= MAX_EXACT_COUNT) {
    try {
      const res = await fetch('api/tokenize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: els.model.value, prompt: text, add_special_tokens: false }),
      });
      if (res.ok) return { tokens: (await res.json()).count, exact: true };
    } catch { /* fall back to the estimate */ }
  }
  // Two characters per token overestimates most text. A false warning is better than a rejected prompt.
  return { tokens: Math.ceil(text.length / 2), exact: false };
}

// Only files that go into the prompt count. Files in tool mode cost nothing until the model reads them.
const textTokens = files => files.filter(f => f.kind === 'text' && f.mode !== 'tools').reduce((n, f) => n + f.tokens, 0);
const fmt = n => n.toLocaleString();

const outputReserve = () => (settings.maxTokens !== '' ? Number(settings.maxTokens) : OUTPUT_RESERVE);

// Tokens left for new files: the context, minus what the chat already uses, minus room for the reply.
function contextBudget() {
  if (!contextLimit) return Infinity;
  const used = current?.messages.findLast(m => m.stats?.contextTokens)?.stats.contextTokens ?? 0;
  return contextLimit - used - outputReserve();
}

// The worst case seen: digit-heavy logs. Text estimates use it, so they err on the safe side.
const CHARS_PER_TOKEN_MIN = 1.3;

// Free tokens after this reply and extraChars of new text, minus the room the next reply needs.
function roomAfter(msg, extraChars = 0) {
  if (!contextLimit || msg.stats?.contextTokens == null) return Infinity;
  return contextLimit - msg.stats.contextTokens - Math.ceil(extraChars / CHARS_PER_TOKEN_MIN) - outputReserve();
}

function renderAttachments() {
  els.attachments.replaceChildren(fileChips(pendingFiles, true));
  const need = textTokens(pendingFiles);
  const budget = contextBudget();
  if (need > budget)
    els.note.textContent = `Files need ${fmt(need)} tokens, but only ${fmt(Math.max(0, budget))} fit.`;
}

// Cuts the file to the newest lines that fit. Logs append at the end, so the tail matters most.
// A CSV or TSV keeps its first line, so the columns still have names.
async function keepNewest(file, button) {
  const allowed = contextBudget() - textTokens(pendingFiles.filter(f => f !== file));
  if (allowed < 1000) {
    els.note.textContent = 'The context has no room left. Start a new chat.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Trimming\u2026';
  const source = file.original ?? file.data;
  const lines = source.replace(/\n$/, '').split('\n');
  const header = /\.(csv|tsv)$/i.test(file.name) ? lines.shift() : null;
  // Start from the measured characters per token, then correct with each real count.
  let target = allowed * (file.data.length / file.tokens) * 0.95;
  for (let attempt = 0; attempt < 6; attempt++) {
    let size = header === null ? 0 : header.length + 1;
    let start = lines.length;
    while (start > 0 && size + lines[start - 1].length + 1 <= target) size += lines[--start].length + 1;
    const kept = lines.slice(start);
    const text = (header === null ? kept : [header, ...kept]).join('\n');
    const count = await countTokens(text);
    if (count.tokens <= allowed || kept.length === 0 || attempt === 5) {
      Object.assign(file, { data: text, original: source, ...count, partial: { kept: kept.length, total: lines.length } });
      delete file.mode;
      break;
    }
    target *= (allowed / count.tokens) * 0.97;
  }
  els.note.textContent = '';
  renderAttachments();
}

function fileChips(files, removable = false) {
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  files.forEach((file, index) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    if (file.kind === 'image') {
      const img = document.createElement('img');
      img.src = file.data;
      img.alt = file.name;
      chip.append(img);
    }
    const label = document.createElement('span');
    if (file.kind === 'text') {
      const tokens = file.tokens == null ? '' : ` (${file.exact ? '' : '~'}${fmt(file.tokens)} tok)`;
      const partial = file.partial ? `, newest ${fmt(file.partial.kept)} of ${fmt(file.partial.total)} lines` : '';
      const mode = file.mode === 'tools' ? ', read with tools' : '';
      label.textContent = file.name + tokens + partial + mode;
      if (mode) label.title = 'Too large for the context. The model searches and reads parts of it with tools.';
    } else {
      label.textContent = file.name;
    }
    chip.append(label);
    if (removable && file.kind === 'text' && (file.mode === 'tools' || textTokens(files) > contextBudget())) {
      const trim = document.createElement('button');
      trim.type = 'button';
      trim.className = 'trim';
      trim.textContent = 'Keep newest lines';
      trim.onclick = () => keepNewest(file, trim);
      chip.append(trim);
    }
    if (removable) {
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = 'Remove';
      x.onclick = () => {
        pendingFiles.splice(index, 1);
        els.note.textContent = '';
        renderAttachments();
      };
      chip.append(x);
    }
    wrap.append(chip);
  });
  return wrap;
}

els.fileInput.onchange = () => {
  addFiles([...els.fileInput.files]);
  els.fileInput.value = '';
};
els.input.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});

let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
});

// --- Helpers ---

els.messages.addEventListener('click', e => {
  const button = e.target.closest('.copy-code');
  if (button) copyText(button.closest('.code').querySelector('code').textContent, button);
});

// The page runs over plain HTTP on the LAN. That is not a secure context, so navigator.clipboard
// and crypto.randomUUID do not exist there. The fallbacks below are deliberate.
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  const label = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => (button.textContent = label), 1200);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// --- Start ---

chats = await listChats().catch(() => []);
renderChatList();
renderMessages();
loadModels();
els.input.focus();
