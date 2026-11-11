// Utilidades compartidas del tablero.

// Orden canónico de las clases (NTE INEN 176), igual que en el nodo y el servidor.
export const CLASES = ['fermentado', 'violeta', 'pizarroso', 'mohoso'];
export const NOMBRES = { fermentado: 'Fermentado', violeta: 'Violeta', pizarroso: 'Pizarroso', mohoso: 'Mohoso' };
// Clases cuyo color de relleno pide texto oscuro encima.
export const TEXTO_OSCURO = new Set(['pizarroso']);

// Límites de la NTE INEN 176, en % sobre 100 granos.
export const NTE = [
  { clase: 'fermentado', tipo: 'Fermentados', criterio: 'min', limites: [75, 65, 53] },
  { clase: 'violeta', tipo: 'Violetas', criterio: 'max', limites: [15, 21, 25] },
  { clase: 'pizarroso', tipo: 'Pizarrosos', criterio: 'max', limites: [9, 12, 18] },
  { clase: 'mohoso', tipo: 'Mohosos', criterio: 'max', limites: [1, 2, 4] },
  { clase: null, tipo: 'Defectuosos', criterio: 'max', limites: [0.5, 1.0, 3.0] },
];

export const colorClase = (clase) => `var(--clase-${clase})`;

/** Crea un elemento. Los textos se insertan con textContent (nunca HTML). */
export function el(etiqueta, atributos = {}, ...hijos) {
  const nodo = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(atributos ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') nodo.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(nodo.style, v);
    else if (k.startsWith('on') && typeof v === 'function') nodo.addEventListener(k.slice(2), v);
    else if (k in nodo && typeof v !== 'string') nodo[k] = v;
    else nodo.setAttribute(k, v === true ? '' : String(v));
  }
  for (const h of hijos.flat(Infinity)) {
    if (h === undefined || h === null || h === false) continue;
    nodo.append(h instanceof Node ? h : document.createTextNode(String(h)));
  }
  return nodo;
}

/** fetch a la API; lanza un Error con el mensaje del servidor si la respuesta no es 2xx. */
export async function api(ruta, opciones = {}) {
  const init = { ...opciones, headers: { ...(opciones.headers ?? {}) } };
  if (init.body !== undefined && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(ruta, init);
  const texto = await res.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { datos = null; }
  if (!res.ok) {
    const error = new Error(datos?.error ?? `Error ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return datos;
}

const nf = (d) => new Intl.NumberFormat('es-EC', { minimumFractionDigits: d, maximumFractionDigits: d });
/** Número con `d` decimales, o «—» si no hay dato. */
export function num(x, d = 0) {
  return x === null || x === undefined || !Number.isFinite(Number(x)) ? '—' : nf(d).format(Number(x));
}
export function fecha(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'medium', hour12: false });
}

export function mensaje(nodo, texto, tipo = '') {
  nodo.textContent = texto ?? '';
  nodo.dataset.tipo = tipo;
}

/** Indicador (stat tile): etiqueta, valor y detalle opcional. Devuelve { nodo, valor, detalle }. */
export function indicador(etiqueta, { clase = null, valor = '—', detalle = '' } = {}) {
  const v = el('div', { class: 'valor' }, valor);
  const d = el('div', { class: 'detalle' }, detalle);
  const nodo = el('div', { class: 'indicador' },
    el('div', { class: 'etiqueta' }, clase ? el('span', { class: 'muestra', style: { background: colorClase(clase) } }) : null, etiqueta),
    v, d);
  return { nodo, valor: v, detalle: d };
}

/** Barra segmentada (composición). `conteos` por clase; un segmento en 0 no se dibuja. */
export function barraSegmentada(conteos) {
  const total = CLASES.reduce((a, c) => a + (conteos?.[c] ?? 0), 0);
  const barra = el('div', { class: 'segmentada', role: 'img' });
  if (!total) {
    barra.append(el('div', { style: { flex: '1', background: 'var(--superficie-2)' } }));
    barra.setAttribute('aria-label', 'Sin detecciones');
    return barra;
  }
  const partes = [];
  for (const c of CLASES) {
    const n = conteos[c] ?? 0;
    if (!n) continue;
    const pct = (100 * n) / total;
    partes.push(`${NOMBRES[c]} ${num(pct, 1)} %`);
    const seg = el('div', { title: `${NOMBRES[c]}: ${n} (${num(pct, 1)} %)`, style: { flex: `${n} 1 0`, background: colorClase(c) } });
    if (TEXTO_OSCURO.has(c)) seg.classList.add('oscuro');
    if (pct >= 9) seg.textContent = `${num(pct, 0)} %`; // solo si cabe; el valor sigue en la tabla
    barra.append(seg);
  }
  barra.setAttribute('aria-label', `Composición: ${partes.join(', ')}`);
  return barra;
}

export function leyendaClases() {
  return el('div', { class: 'leyenda' },
    CLASES.map((c) => el('span', {}, el('span', { class: 'muestra', style: { background: colorClase(c) } }), NOMBRES[c])));
}

export function tabla(columnas, filas, { alPulsar } = {}) {
  const thead = el('thead', {}, el('tr', {}, columnas.map((c) => el('th', { class: c.num ? 'num' : '' }, c.titulo))));
  const tbody = el('tbody', {}, filas.map((f) => {
    const tr = el('tr', {}, columnas.map((c) => {
      const v = c.valor(f);
      return el('td', { class: c.num ? 'num' : '' }, v instanceof Node ? v : String(v ?? '—'));
    }));
    if (alPulsar) {
      tr.classList.add('enlace');
      tr.tabIndex = 0;
      tr.addEventListener('click', () => alPulsar(f));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') alPulsar(f); });
    }
    return tr;
  }));
  return el('div', { class: 'tabla-envoltura' }, el('table', {}, thead, tbody));
}

export function leerPreferencia(clave) {
  try { return localStorage.getItem(clave); } catch { return null; }
}
export function guardarPreferencia(clave, valor) {
  try { localStorage.setItem(clave, valor); } catch { /* almacenamiento no disponible */ }
}

export const variableCss = (nombre) => getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
