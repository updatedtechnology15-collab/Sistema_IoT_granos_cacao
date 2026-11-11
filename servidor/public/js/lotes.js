// Página «Lotes»: crear lotes y ver el historial de inspecciones de cada lote.
import { CLASES, NOMBRES, api, el, num, fecha, mensaje, tabla } from './util.js';

/** Enlaces de descarga de los tres CSV de la API, con un filtro opcional (?lote_id=). */
function enlacesCsv(consulta = '', sufijo = '') {
  const enlace = (archivo, texto) => el('a', { class: 'boton secundario', href: `/api/export/${archivo}${consulta}`,
    download: `${archivo.replace('.csv', '')}${sufijo}.csv` }, texto);
  return el('div', { class: 'fila' }, el('span', { class: 'tenue' }, 'Exportar CSV:'),
    enlace('inspecciones.csv', 'Inspecciones'), enlace('validaciones.csv', 'Validaciones'), enlace('iot.csv', 'Red IoT'));
}

export async function mostrar(raiz, [loteId]) {
  const campos = {
    lote_id: el('input', { name: 'lote_id', required: true, maxLength: 64, pattern: '[A-Za-z0-9._\\-]+', placeholder: 'L-001' }),
    origen: el('input', { name: 'origen', required: true, placeholder: 'Finca o centro de acopio' }),
    operador: el('input', { name: 'operador', placeholder: 'Nombre' }),
    descripcion: el('input', { name: 'descripcion', placeholder: 'Opcional' }),
  };
  const aviso = el('div', { class: 'mensaje' });
  const formulario = el('form', { class: 'formulario', novalidate: true },
    el('label', {}, 'Identificador del lote', campos.lote_id),
    el('label', {}, 'Origen', campos.origen),
    el('label', {}, 'Operador', campos.operador),
    el('label', {}, 'Descripción', campos.descripcion),
    el('div', {}, el('button', { type: 'submit' }, 'Crear lote')));

  const listado = el('div', {}, el('p', { class: 'vacio' }, 'Cargando…'));
  const historial = el('section', { class: 'tarjeta' });

  raiz.append(
    el('section', { class: 'tarjeta' }, el('header', {}, el('h2', {}, 'Nuevo lote')), formulario, aviso),
    el('section', { class: 'tarjeta' }, el('header', {}, el('h2', {}, 'Lotes registrados'), enlacesCsv()), listado),
    historial,
  );

  formulario.addEventListener('submit', async (e) => {
    e.preventDefault();
    const datos = Object.fromEntries(Object.entries(campos).map(([k, input]) => [k, input.value.trim()]));
    try {
      const lote = await api('/api/lotes', { method: 'POST', body: datos });
      mensaje(aviso, `Lote ${lote.lote_id} creado.`, 'bien');
      formulario.reset();
      location.hash = `#/lotes/${encodeURIComponent(lote.lote_id)}`;
    } catch (err) {
      mensaje(aviso, err.message, 'error');
    }
  });

  try {
    const [lotes, inspecciones] = await Promise.all([api('/api/lotes'), api('/api/inspecciones')]);
    const porLote = {};
    for (const i of inspecciones) porLote[i.lote_id] = (porLote[i.lote_id] ?? 0) + 1;
    listado.replaceChildren(lotes.length
      ? tabla([
        { titulo: 'Lote', valor: (l) => l.lote_id },
        { titulo: 'Origen', valor: (l) => l.origen },
        { titulo: 'Operador', valor: (l) => l.operador || '—' },
        { titulo: 'Descripción', valor: (l) => l.descripcion || '—' },
        { titulo: 'Creado', valor: (l) => fecha(l.creado_en) },
        { titulo: 'Inspecciones', num: true, valor: (l) => num(porLote[l.lote_id] ?? 0) },
      ], lotes, { alPulsar: (l) => { location.hash = `#/lotes/${encodeURIComponent(l.lote_id)}`; } })
      : el('p', { class: 'vacio' }, 'Todavía no hay lotes.'));
  } catch (err) {
    listado.replaceChildren(el('p', { class: 'mensaje', 'data-tipo': 'error' }, err.message));
  }

  if (!loteId) {
    historial.append(el('p', { class: 'vacio' }, 'Elija un lote para ver su historial de inspecciones.'));
    return;
  }
  try {
    const lote = await api(`/api/lotes/${encodeURIComponent(loteId)}`);
    historial.append(
      el('header', {}, el('h2', {}, `Historial del lote ${lote.lote_id}`),
        el('span', { class: 'tenue' }, `${lote.origen}${lote.operador ? ` · ${lote.operador}` : ''}`)),
      enlacesCsv(`?lote_id=${encodeURIComponent(lote.lote_id)}`, `_${lote.lote_id}`),
      lote.inspecciones.length
        ? tabla([
          { titulo: 'Inicio', valor: (i) => fecha(i.inicio) },
          { titulo: 'Inspección', valor: (i) => el('a', { href: `#/inspeccion/${encodeURIComponent(i.inspeccion_id)}` }, i.inspeccion_id) },
          { titulo: 'Modelo', valor: (i) => `${i.modelo} · ${i.dispositivo}` },
          { titulo: 'Total', num: true, valor: (i) => num(i.total) },
          ...CLASES.map((c) => ({ titulo: `% ${NOMBRES[c].toLowerCase()}`, num: true, valor: (i) => num(i.porcentajes?.[c], 1) })),
          { titulo: 'Latencia media (ms)', num: true, valor: (i) => num(i.latencia?.media_ms, 1) },
          { titulo: 'Pérdida (%)', num: true, valor: (i) => num(i.iot?.perdida_pct, 1) },
        ], lote.inspecciones, { alPulsar: (i) => { location.hash = `#/inspeccion/${encodeURIComponent(i.inspeccion_id)}`; } })
        : el('p', { class: 'vacio' }, 'Este lote todavía no tiene inspecciones.'),
    );
  } catch (err) {
    historial.append(el('p', { class: 'mensaje', 'data-tipo': 'error' }, err.message));
  }
}
