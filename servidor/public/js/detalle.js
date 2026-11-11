// Página «Detalle de inspección»: imagen anotada, conteos y porcentajes,
// comparación con la NTE INEN 176, rendimiento, entorno, red IoT y exportación.
import {
  CLASES, NOMBRES, NTE, TEXTO_OSCURO, api, el, num, fecha, tabla, indicador, barraSegmentada,
  leyendaClases, colorClase,
} from './util.js';

const AVISO_GRADO = 'Grado no asignado: el sistema no detecta la clase defectuoso';

export async function mostrar(raiz, [id]) {
  if (!id) {
    raiz.append(await listaInspecciones('Elija una inspección', (i) => `#/inspeccion/${encodeURIComponent(i.inspeccion_id)}`));
    return;
  }
  let ins;
  try {
    ins = await api(`/api/inspecciones/${encodeURIComponent(id)}`);
  } catch (e) {
    raiz.append(el('section', { class: 'tarjeta' }, el('p', { class: 'mensaje', 'data-tipo': 'error' }, e.message)));
    return;
  }
  const idUrl = encodeURIComponent(ins.inspeccion_id);

  // ---------- cabecera ----------
  raiz.append(el('section', { class: 'tarjeta' },
    el('header', {},
      el('div', {}, el('h2', {}, `Inspección ${ins.inspeccion_id}`),
        el('div', { class: 'tenue' }, 'Lote ', el('a', { href: `#/lotes/${encodeURIComponent(ins.lote_id)}` }, ins.lote_id),
          ` · ${fecha(ins.inicio)} · ${ins.fuente ?? '—'}`)),
      el('div', { class: 'fila' },
        el('a', { class: 'boton', href: `/api/export/inspecciones.csv?inspeccion_id=${idUrl}`, download: `inspeccion_${ins.inspeccion_id}.csv` }, 'Exportar CSV'),
        el('a', { class: 'boton secundario', href: `#/validacion/${idUrl}` }, 'Validar'))),
  ));

  // ---------- imagen y conteos ----------
  const imagen = ins.imagen_jpeg
    ? el('img', { src: `data:image/jpeg;base64,${ins.imagen_jpeg}`, alt: 'Cuadro representativo con las detecciones' })
    : el('span', { class: 'tenue' }, 'Sin imagen');
  const rep = ins.cuadro_representativo;
  raiz.append(el('div', { class: 'dos-col' },
    el('section', { class: 'tarjeta' },
      el('header', {}, el('h2', {}, 'Cuadro representativo'),
        el('span', { class: 'tenue' }, rep ? `cuadro ${rep.cuadro} · t = ${num(rep.t_s, 1)} s · distancia L1 a la mediana ${rep.distancia_l1}` : '')),
      el('div', { class: 'marco-imagen' }, imagen)),
    el('section', { class: 'tarjeta' },
      el('header', {}, el('h2', {}, 'Conteo de la inspección'),
        el('span', { class: 'tenue' }, `mediana por clase de ${ins.n_cuadros} cuadros`)),
      tabla([
        { titulo: 'Clase', valor: (c) => el('span', { class: 'clase-celda' }, el('span', { class: 'muestra', style: { background: colorClase(c) } }), NOMBRES[c]) },
        { titulo: 'Conteo', num: true, valor: (c) => num(ins.conteos?.[c]) },
        { titulo: '%', num: true, valor: (c) => num(ins.porcentajes?.[c], 1) },
      ], CLASES),
      el('div', { class: 'fila' }, el('span', { class: 'grande' }, num(ins.total)), el('span', { class: 'tenue' }, 'mitades detectadas en total')),
      barraSegmentada(ins.conteos),
      leyendaClases(),
      cuadriculaResumen(ins.cuadricula)),
  ));

  // ---------- NTE INEN 176 ----------
  raiz.append(el('section', { class: 'tarjeta' },
    el('header', {}, el('h2', {}, 'Comparación con la NTE INEN 176'),
      el('span', { class: 'tenue' }, `porcentajes sobre las ${num(ins.total)} mitades detectadas; límites en % sobre 100 granos`)),
    tablaNte(ins),
    el('div', { class: 'aviso', role: 'note' }, el('span', { 'aria-hidden': 'true' }, 'ⓘ'), AVISO_GRADO)));

  // ---------- rendimiento, entorno e IoT ----------
  const lat = ins.latencia ?? {};
  const rec = ins.recursos ?? {};
  const iot = ins.iot ?? {};
  const hw = ins.hardware ?? {};
  const ver = ins.versiones ?? {};
  raiz.append(el('div', { class: 'dos-col' },
    el('section', { class: 'tarjeta' },
      el('header', {}, el('h2', {}, 'Rendimiento del nodo'),
        el('span', { class: 'tenue' }, `${ins.n_cuadros_latencia ?? '—'} cuadros, sin calentamiento`)),
      el('div', { class: 'indicadores' },
        indicador('Latencia media', { valor: num(lat.media_ms, 1), detalle: `ms · DE ${num(lat.de_ms, 1)} ms` }).nodo,
        indicador('Percentil 95', { valor: num(lat.p95_ms, 1), detalle: 'ms' }).nodo,
        indicador('fps máximo', { valor: num(lat.fps_max, 2), detalle: '1000 / media' }).nodo,
        indicador('RSS máxima', { valor: num(rec.rss_max_mb, 0), detalle: 'MB' }).nodo,
        indicador('CPU media', { valor: num(rec.cpu_media_pct, 1), detalle: '% de todos los núcleos' }).nodo,
        indicador('Memoria GPU máx.', { valor: num(rec.gpu_mem_max_mb, 0), detalle: rec.gpu_mem_max_mb == null ? 'sin CUDA' : 'MB' }).nodo)),
    el('section', { class: 'tarjeta' },
      el('header', {}, el('h2', {}, 'Red IoT'), el('span', { class: 'tenue' }, 'medido por el servidor')),
      el('div', { class: 'indicadores' },
        indicador('Pérdida de mensajes', { valor: `${num(iot.perdida_pct, 1)} %`, detalle: `${num(iot.n_recibidos)} de ${num(iot.n_publicados)} recibidos` }).nodo,
        indicador('Latencia nodo → servidor', { valor: num(iot.lat_borde_servidor_media_ms, 1), detalle: `ms · DE ${num(iot.lat_borde_servidor_de_ms, 1)} · p95 ${num(iot.lat_borde_servidor_p95_ms, 1)}` }).nodo,
        indicador('Latencia del resultado', { valor: num(iot.lat_resultado_ms, 0), detalle: 'ms' }).nodo,
        indicador('Tiempo total', { valor: num(iot.t_total_inspeccion_s, 1), detalle: iot.t_total_inspeccion_s == null ? 's · iniciada por consola' : 's · comando → MongoDB' }).nodo),
      el('p', { class: 'tenue' }, 'La latencia nodo → servidor es válida porque ambos comparten reloj (mismo equipo).')),
  ));

  raiz.append(el('section', { class: 'tarjeta' },
    el('header', {}, el('h2', {}, 'Entorno')),
    el('dl', { class: 'datos' },
      ...par('Modelo', ins.modelo),
      ...par('Dispositivo', ins.dispositivo),
      ...par('Modo de inferencia', ins.modo_inferencia),
      ...par('CPU', hw.cpu),
      ...par('GPU', hw.gpu ?? 'sin GPU CUDA'),
      ...par('RAM', hw.ram_gb != null ? `${num(hw.ram_gb, 1)} GB` : null),
      ...par('Sistema operativo', hw.so),
      ...par('Versiones', `Python ${ver.python ?? '—'} · torch ${ver.torch ?? '—'} · ultralytics ${ver.ultralytics ?? '—'} · OpenCV ${ver.opencv ?? '—'}`),
      ...par('Ventana', `${num(ins.ventana_s, 0)} s · ${num(ins.fps_operacion, 0)} fps de operación · ${num(ins.n_cuadros)} cuadros`),
      ...par('Inicio / fin', `${fecha(ins.inicio)} → ${fecha(ins.fin)}`)),
    el('details', {}, el('summary', {}, 'Parámetros completos del nodo (config.yaml)'),
      el('dl', { class: 'datos', style: { marginTop: '10px' } },
        Object.entries(ins.parametros ?? {}).flatMap(([k, v]) => par(k, typeof v === 'object' ? JSON.stringify(v) : v))))));
}

function par(clave, valor) {
  return [el('dt', {}, clave), el('dd', {}, valor === null || valor === undefined || valor === '' ? '—' : String(valor))];
}

function tablaNte(ins) {
  const cumple = (fila, pct, limite) => (fila.criterio === 'min' ? pct >= limite : pct <= limite);
  const celda = (ok) => el('span', { class: ok ? 'cumple' : 'no-cumple' }, ok ? '✓ cumple' : '✗ no cumple');
  const thead = el('thead', {}, el('tr', {},
    el('th', {}, 'Tipo'), el('th', { class: 'num' }, 'Sistema (%)'),
    ['Grado 1', 'Grado 2', 'Grado 3'].map((g) => el('th', { class: 'num' }, g))));
  const filas = NTE.map((fila) => {
    const signo = fila.criterio === 'min' ? '≥' : '≤';
    if (!fila.clase) {
      return el('tr', {}, el('td', {}, `${fila.tipo}, máximo`), el('td', { class: 'num tenue' }, 'no detectado'),
        fila.limites.map((l) => el('td', { class: 'num' }, `${signo} ${num(l, 1)}`)));
    }
    const pct = ins.porcentajes?.[fila.clase];
    return el('tr', {},
      el('td', {}, el('span', { class: 'clase-celda' }, el('span', { class: 'muestra', style: { background: colorClase(fila.clase) } }),
        `${fila.tipo}, ${fila.criterio === 'min' ? 'mínimo' : 'máximo'}`)),
      el('td', { class: 'num' }, num(pct, 1)),
      fila.limites.map((l) => el('td', { class: 'num' }, `${signo} ${num(l, 0)}  `, pct == null ? '—' : celda(cumple(fila, pct, l)))));
  });
  return el('div', { class: 'tabla-envoltura' }, el('table', {}, thead, el('tbody', {}, filas)));
}

function cuadriculaResumen(cuadricula) {
  if (!Array.isArray(cuadricula)) {
    return el('p', { class: 'tenue' }, 'Cuadrícula: no asignable (el cuadro representativo no tiene exactamente 100 detecciones).');
  }
  const celdas = [...cuadricula].sort((a, b) => a.fila - b.fila || a.columna - b.columna).map((p) => {
    const d = el('div', { title: `Fila ${p.fila}, columna ${p.columna}: ${NOMBRES[p.clase]} (${num(p.conf, 2)})`,
      style: { background: colorClase(p.clase) } }, NOMBRES[p.clase][0]);
    if (TEXTO_OSCURO.has(p.clase)) d.classList.add('oscuro');
    return d;
  });
  return el('div', { style: { display: 'grid', gap: '8px' } },
    el('h3', {}, 'Cuadrícula asignada (fila 1 arriba, columna 1 a la izquierda)'),
    el('div', { class: 'cuadricula', role: 'img', 'aria-label': 'Cuadrícula de 10 por 10 con la clase de cada mitad' }, celdas));
}

/** Lista de inspecciones recientes (para elegir una cuando la ruta no trae identificador). */
export async function listaInspecciones(titulo, destino) {
  const tarjeta = el('section', { class: 'tarjeta' }, el('header', {}, el('h2', {}, titulo)));
  try {
    const lista = await api('/api/inspecciones');
    tarjeta.append(lista.length
      ? tabla([
        { titulo: 'Inicio', valor: (i) => fecha(i.inicio) },
        { titulo: 'Inspección', valor: (i) => el('a', { href: destino(i) }, i.inspeccion_id) },
        { titulo: 'Lote', valor: (i) => i.lote_id },
        { titulo: 'Modelo', valor: (i) => `${i.modelo} · ${i.dispositivo}` },
        { titulo: 'Total', num: true, valor: (i) => num(i.total) },
      ], lista, { alPulsar: (i) => { location.hash = destino(i); } })
      : el('p', { class: 'vacio' }, 'Todavía no hay inspecciones guardadas.'));
  } catch (e) {
    tarjeta.append(el('p', { class: 'mensaje', 'data-tipo': 'error' }, e.message));
  }
  return tarjeta;
}
