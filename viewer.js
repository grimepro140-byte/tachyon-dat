const $ = id => document.getElementById(id);
const pageSize = 200;
const worker = new Worker('./search-worker.js');
const pending = new Map();
let requestId = 0, selection = 0, search = 0;
let manifest, kind = 'geosite', category = '', offset = 0;

function node(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}
function button(text, action) {
  const el = node('button', text);
  el.type = 'button';
  el.onclick = action;
  return el;
}
function copyButton(text, value) {
  const el = button(text, async () => {
    try { await navigator.clipboard.writeText(value); el.textContent = 'Скопировано'; }
    catch { el.textContent = 'Копирование недоступно'; }
    setTimeout(() => { el.textContent = text; }, 1200);
  });
  return el;
}
function request(options) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    worker.postMessage({id, files: manifest.data, ...options});
  });
}
worker.onmessage = ({data}) => {
  const result = pending.get(data.id);
  if (!result) return;
  pending.delete(data.id);
  if (data.error) result.reject(Error(data.error));
  else result.resolve(data);
};
worker.onerror = () => {
  for (const job of pending.values()) job.reject(Error('Ошибка поиска'));
  pending.clear();
};
function drawCategories() {
  for (const el of document.querySelectorAll('[data-kind]')) el.setAttribute('aria-pressed', el.dataset.kind === kind);
  const filter = $('filter').value.trim().toLowerCase();
  $('categories').replaceChildren(...Object.entries(manifest.categories[kind]).filter(([id, item]) =>
    (id + ' ' + item.title).toLowerCase().includes(filter)).map(([id, item]) => {
    const el = button(id.toUpperCase(), () => select(kind, id));
    el.className = 'category';
    el.setAttribute('aria-pressed', id === category);
    el.append(node('span', item.count.toLocaleString('ru-RU'), 'size'));
    if (['block', 'proxy', 'direct'].includes(item.action)) el.append(node('span', item.action.toUpperCase(), 'badge ' + item.action));
    if (item.title !== id) el.append(node('small', item.title));
    return el;
  }));
}
function select(nextKind, id = '', fromHash = false) {
  kind = nextKind;
  category = Object.hasOwn(manifest.categories[kind], id) ? id : '';
  offset = 0;
  $('entry-filter').value = '';
  if (!fromHash) history.replaceState(null, '', '#' + kind + (category ? ':' + category : ''));
  drawCategories();
  return drawEntries();
}
async function drawEntries() {
  const stamp = ++selection;
  const item = manifest.categories[kind][category];
  $('title').textContent = item ? category.toUpperCase() : 'Выберите категорию';
  $('tools').replaceChildren();
  $('entries').replaceChildren();
  $('entry-filter').hidden = !item;
  $('pager').hidden = true;
  $('count').textContent = item ? 'Загрузка категории…' : '';
  if (!item) return;
  const reference = kind + ':' + category;
  $('tools').append(copyButton('Копировать ' + reference, reference), copyButton('Ссылка на категорию', location.href));
  for (const [format, url] of Object.entries(item.sources)) {
    const link = node('a', '.' + format, 'file');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    $('tools').append(link);
  }
  try {
    const {values, total} = await request({kind, category, count: item.count, offset, limit: pageSize, filter: $('entry-filter').value.trim().toLowerCase()});
    if (stamp !== selection) return;
    $('entries').start = offset + 1;
    $('entries').replaceChildren(...values.map(value => {
      const row = node('li', '');
      row.append(node('code', value));
      return row;
    }));
    $('entries').scrollTop = 0;
    $('count').textContent = total ? total.toLocaleString('ru-RU') + ' записей' : 'Совпадений нет.';
    $('range').textContent = (offset + 1) + '–' + Math.min(total, offset + pageSize) + ' из ' + total;
    $('pager').hidden = total <= pageSize;
    $('prev').disabled = offset === 0;
    $('next').disabled = offset + pageSize >= total;
  } catch (error) {
    if (stamp === selection) $('count').textContent = error.message;
  }
}
async function download(type, file, el) {
  el.disabled = true;
  try {
    const response = await fetch(manifest.data[type]);
    if (!response.ok) throw Error('Не удалось скачать ' + file.name);
    const blob = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).blob();
    const link = node('a', '');
    link.href = URL.createObjectURL(blob);
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  } catch (error) { $('build').textContent = error.message; }
  finally { el.disabled = false; }
}
function readHash() {
  const [type, id] = location.hash.slice(1).split(':');
  select(type === 'geoip' ? 'geoip' : 'geosite', id, true);
}
async function start() {
  const response = await fetch('./build.json', {cache:'no-cache'});
  if (!response.ok) throw Error('Нет опубликованной сборки');
  manifest = await response.json();
  const date = new Date(manifest.imported_at).toLocaleString('ru-RU');
  $('build').textContent = 'Сборка ' + manifest.id.slice(0, 8) + ' · ' + date;
  for (const [type, file] of Object.entries(manifest.files)) {
    const row = node('div', '', 'download-row');
    const title = node('strong', file.name);
    const url = node('input', '', 'download-url');
    url.type = 'text';
    url.readOnly = true;
    url.value = file.release;
    url.setAttribute('aria-label', 'Постоянная HTTPS-ссылка для ' + file.name);
    url.addEventListener('click', () => url.select());
    const actions = node('div', '', 'controls download-actions');
    const save = button('Скачать файл', () => download(type, file, save));
    save.title = 'SHA-256 ' + file.sha256;
    save.setAttribute('aria-label', 'Скачать ' + file.name);
    const copy = copyButton('Копировать URL', file.release);
    copy.setAttribute('aria-label', 'Копировать URL для ' + file.name);
    actions.append(save, copy);
    row.append(title, url, actions);
    $('downloads').append(row);
  }
  $('download-menu').hidden = false;
  for (const el of document.querySelectorAll('[data-kind]')) el.onclick = () => select(el.dataset.kind);
  $('filter').oninput = drawCategories;
  $('entry-filter').oninput = () => { offset = 0; drawEntries(); };
  $('prev').onclick = () => { offset -= pageSize; drawEntries(); };
  $('next').onclick = () => { offset += pageSize; drawEntries(); };
  $('global').onsubmit = async event => {
    event.preventDefault();
    const id = ++search;
    $('notice').textContent = 'Поиск по опубликованной сборке…';
    $('matches').replaceChildren();
    try {
      const result = await request({query:$('query').value});
      if (id !== search) return;
      $('notice').textContent = result.matches.length ? 'Найдено категорий: ' + result.matches.length : 'Совпадений нет.';
      $('matches').replaceChildren(...result.matches.map(match => {
        const row = node('div', '');
        row.append(button(match.category.toUpperCase() + ' ↗', () => {
          $('filter').value = '';
          select(result.kind, match.category);
          $('categories').querySelector('[aria-pressed=true]')?.scrollIntoView({block:'nearest'});
          $('detail').scrollIntoView({block:'nearest'});
        }), node('small', '  Совпадений: ' + match.total), ...match.values.map(value => node('code', value)));
        return row;
      }));
    } catch (error) {
      if (id === search) $('notice').textContent = error.message;
    }
  };
  addEventListener('hashchange', readHash);
  readHash();
}
start().catch(error => { $('build').textContent = error.message; });
