const loaded = new Map();
const decoder = new TextDecoder();
function* fields(bytes) {
  let pos = 0;
  function readInt() {
    let value = 0;
    for (let scale = 1; pos < bytes.length && scale <= 2 ** 49; scale *= 128) {
      const byte = bytes[pos++];
      value += (byte & 127) * scale;
      if (byte < 128) return value;
    }
    throw Error('Повреждённый DAT');
  }
  while (pos < bytes.length) {
    const key = readInt(), wire = key % 8;
    if (wire === 0) yield [key >> 3, readInt()];
    else {
      const length = wire === 2 ? readInt() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (length < 0 || pos + length > bytes.length) throw Error('Повреждённый DAT');
      yield [key >> 3, bytes.subarray(pos, pos += length)];
    }
  }
}
function parseDAT(bytes) {
  const categories = new Map();
  for (const [field, value] of fields(bytes)) {
    if (field !== 1) continue;
    const header = fields(value).next().value;
    if (header?.[0] !== 1) throw Error('В DAT отсутствует имя категории');
    categories.set(decoder.decode(header[1]).toLowerCase(), value);
  }
  return categories;
}
function* entries(data, kind) {
  for (const [field, raw] of fields(data)) {
    if (field !== 2) continue;
    const entry = new Map(fields(raw));
    if (kind === 'geosite') {
      yield { type: ['keyword','regex','suffix','full'][entry.get(1) ?? 0], value: decoder.decode(entry.get(2)) };
    } else {
      const address = entry.get(1), bits = entry.get(2) || 0;
      const value = address.length === 4 ? address.join('.') :
        Array.from({length: 8}, (_, i) => ((address[i*2] << 8) | address[i*2+1]).toString(16)).join(':');
      yield { type: 'cidr', value: value + '/' + bits, address, bits };
    }
  }
}
function parseNetwork(input) {
  const [host, mask, extra] = input.split('/');
  if (extra !== undefined || (mask !== undefined && !/^\d+$/.test(mask))) return null;
  const v4 = s => {
    const parts = s.split('.');
    return parts.length <= 4 && parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p) && +p <= 255) ? parts.map(Number) : null;
  };
  const dotted = v4(host);
  if (dotted) {
    const bits = mask === undefined ? dotted.length * 8 : +mask;
    if (bits > 32 || (mask !== undefined && dotted.length !== 4)) return null;
    return {address: [...dotted, ...Array(4-dotted.length).fill(0)], bits};
  }
  if (!host.includes(':')) return null;
  const expanded = host.replace(/(?:\d+\.){3}\d+$/, ipv4 => {
    const octets = v4(ipv4);
    return octets ? [(octets[0]<<8)|octets[1], (octets[2]<<8)|octets[3]].map(n=>n.toString(16)).join(':') : ipv4;
  });
  const halves = expanded.split('::');
  if (halves.length > 2) return null;
  const parts = halves.map(half => half ? half.split(':') : []);
  const count = parts.flat().length, bits = mask === undefined ? 128 : +mask;
  if (bits > 128 || (halves.length === 1 ? count !== 8 : count >= 8) ||
      !parts.flat().every(part => /^[a-f\d]{1,4}$/i.test(part))) return null;
  const groups = halves.length === 1 ? parts[0] : [...parts[0], ...Array(8-count).fill('0'), ...parts[1]];
  return {address: groups.flatMap(part => { const n = parseInt(part,16); return [n >> 8, n & 255]; }), bits};
}
function overlaps(a, b) {
  if (a.address.length !== b.address.length) return false;
  const bits = Math.min(a.bits, b.bits);
  for (let i = 0; i < bits; i += 8) {
    if ((a.address[i/8] ^ b.address[i/8]) >> Math.max(0, 8 - (bits-i))) return false;
  }
  return true;
}
function domainMatcher(query) {
  return ({type, value}) => {
    const domain = value.toLowerCase().replace(/^\.+/, '');
    if (type === 'keyword') return query.includes(domain);
    if (type === 'regex') {
      try { return new RegExp(value).test(query); } catch { return false; }
    }
    return query === domain || (type === 'suffix' && query.endsWith('.'+domain)) ||
      (!query.includes('.') && domain.includes(query));
  };
}
function load(url) {
  if (!loaded.has(url)) {
    const pending = fetch(url).then(response => {
      if (!response.ok) throw Error('Не удалось загрузить данные сборки');
      return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }).then(buffer => parseDAT(new Uint8Array(buffer)));
    loaded.set(url, pending);
    pending.catch(() => loaded.delete(url));
  }
  return loaded.get(url);
}
self.onmessage = async ({data: request}) => {
  const {id, files} = request;
  try {
    if (request.query !== undefined) {
      let query = request.query.toLowerCase().trim().replace(/\.$/,'');
      const network = parseNetwork(query);
      const kind = network ? 'geoip' : 'geosite';
      if (!network) {
        if (!/^[\p{L}\p{N}_.-]+$/u.test(query)) throw Error('Введите домен, IP-адрес или CIDR');
        if (/[^\x00-\x7f]/.test(query)) query = new URL('http://' + query).hostname;
      }
      const match = network ? entry => overlaps(entry, network) : domainMatcher(query);
      const matches = [];
      for (const [category, data] of await load(files[kind])) {
        let total = 0;
        const values = [];
        for (const entry of entries(data, kind)) if (match(entry)) {
          if (++total <= 20) values.push(entry.value);
        }
        if (total) matches.push({category, total, values});
      }
      self.postMessage({id, kind, matches});
    } else {
      const {kind, category, filter, offset, limit} = request;
      const data = (await load(files[kind])).get(category);
      if (!data) throw Error('Категория отсутствует в сборке');
      const values = [];
      let total = 0;
      for (const {value} of entries(data, kind)) {
        if (filter && !value.toLowerCase().includes(filter)) continue;
        if (total >= offset && values.length < limit) values.push(value);
        total++;
        if (!filter && values.length === limit) break;
      }
      self.postMessage({id, values, total: filter ? total : request.count});
    }
  } catch (error) {
    self.postMessage({id, error: error.message});
  }
};
