// Chat history lives only in this browser's IndexedDB. The server keeps no state.
// One record per chat: { id, title, updated, messages: [...] }.

const db = new Promise((resolve, reject) => {
  const req = indexedDB.open('lantern', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('chats', { keyPath: 'id' });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function run(mode, action) {
  const tx = (await db).transaction('chats', mode);
  const req = action(tx.objectStore('chats'));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const listChats = async () => (await run('readonly', s => s.getAll())).sort((a, b) => b.updated - a.updated);
export const saveChat = chat => run('readwrite', s => s.put(chat));
export const deleteChat = id => run('readwrite', s => s.delete(id));
