import { renderMarkdown } from './markdown.js';
import { listChats, saveChat, deleteChat } from './store.js';

const $ = id => document.getElementById(id);
const els = {
  sidebar: $('sidebar'), chatList: $('chat-list'), messages: $('messages'), empty: $('empty'),
  model: $('model'), serverStatus: $('server-status'), composer: $('composer'), input: $('input'),
  attachments: $('attachments'), note: $('composer-note'), send: $('send'), fileInput: $('file-input'),
  settings: $('settings'), dropOverlay: $('drop-overlay'),
};

const MAX_TEXT_FILE = 2 * 1024 * 1024;
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
  const nodes = (current?.messages ?? []).map(messageNode);
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
  if (msg.error) {
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = msg.error;
    node.append(err);
  }
  if (msg !== running?.message) node.append(messageFooter(msg));
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
      current.messages.pop();
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
  current.messages.push({ role: 'user', content: text, files: pendingFiles });
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

async function generate() {
  const chat = current;
  const msg = { role: 'assistant', content: '', reasoning: '' };
  const request = {
    model: els.model.value,
    messages: apiMessages(chat),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (settings.temperature !== '') request.temperature = Number(settings.temperature);
  if (settings.maxTokens !== '') request.max_tokens = Number(settings.maxTokens);

  chat.messages.push(msg);
  running = { controller: new AbortController(), message: msg };
  setBusy(true);
  renderChatList();
  renderMessages();
  const node = els.messages.lastElementChild;

  const started = performance.now();
  let firstToken = null;
  let firstContent = null;
  let usage = null;
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
      const thought = delta?.reasoning ?? delta?.reasoning_content;
      if (thought || delta?.content) firstToken ??= performance.now();
      if (thought) msg.reasoning += thought;
      if (delta?.content) {
        if (msg.content === '' && delta.content.trim()) firstContent ??= performance.now();
        msg.content += delta.content;
      }
      if (chunk.usage) usage = chunk.usage;
      redraw();
    }
  } catch (e) {
    if (e.name === 'AbortError') msg.stopped = true;
    else msg.error = e.message;
  } finally {
    const ended = performance.now();
    if (frame) cancelAnimationFrame(frame);
    if (msg.reasoning && firstToken && firstContent) msg.thoughtSeconds = Math.round((firstContent - firstToken) / 1000);
    msg.stats = {
      model: request.model,
      tokens: usage?.completion_tokens,
      firstTokenSeconds: firstToken ? (firstToken - started) / 1000 : undefined,
      tokensPerSecond: usage && firstToken && ended > firstToken
        ? usage.completion_tokens / ((ended - firstToken) / 1000) : undefined,
    };
    running = null;
    setBusy(false);
    chat.updated = Date.now();
    await saveChat(chat).catch(e => (els.note.textContent = `Cannot save chat: ${e.message}`));
    chats.sort((a, b) => b.updated - a.updated);
    renderChatList();
    if (chat === current) renderMessages();
  }
}

function apiMessages(chat) {
  const out = [];
  if (settings.system.trim()) out.push({ role: 'system', content: settings.system });
  for (const m of chat.messages) {
    if (m.role === 'assistant') {
      // Earlier thinking is not sent back. Chat templates drop it, and it costs context.
      const { content } = splitThinking(m);
      if (content) out.push({ role: 'assistant', content });
      continue;
    }
    const files = m.files ?? [];
    const text = [...files.filter(f => f.kind === 'text').map(fileBlock), m.content].filter(Boolean).join('\n\n');
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
  return `File: ${file.name}\n${fence}\n${file.data}\n${fence}`;
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
        if (file.size > MAX_TEXT_FILE) throw new Error('file is larger than 2 MB');
        const text = await file.text();
        // A NUL character means binary content. Models cannot use it, and it wastes context.
        if (text.includes('\u0000')) throw new Error('not a text file');
        pendingFiles.push({ name: file.name, kind: 'text', data: text });
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

// About four characters per token. This is only a guide, so the user sees which file is too big.
const estimateTokens = text => Math.ceil(text.length / 4);

function renderAttachments() {
  els.attachments.replaceChildren(fileChips(pendingFiles, true));
  const tokens = pendingFiles.filter(f => f.kind === 'text').reduce((n, f) => n + estimateTokens(f.data), 0);
  if (contextLimit && tokens > contextLimit * 0.8)
    els.note.textContent = `Files are about ${tokens.toLocaleString()} tokens. The model context is ${contextLimit.toLocaleString()}.`;
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
    label.textContent = file.kind === 'text'
      ? `${file.name} (~${estimateTokens(file.data).toLocaleString()} tok)` : file.name;
    chip.append(label);
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
