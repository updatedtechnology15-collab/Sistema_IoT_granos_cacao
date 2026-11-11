// Página «Validación»: conteos de la experta (o CSV por posición fila, columna,
// clase_experta) frente al sistema. Muestra C, diferencias por clase y tasa de
// detección; con posiciones, también la matriz de confusión, la exactitud por
// mitad y el kappa de Cohen con su IC 95 %. Los cálculos los hace el servidor.
import { CLASES, NOMBRES, api, el, num, fecha, mensaje, tabla, colorClase } from './util.js';
import { listaInspecciones } from './detalle.js';

export async function mostrar(raiz, [id]) {
  if (!id) {
    raiz.append(await listaInspecciones('Elija la inspección que va a validar', (i) => `#/validacion/${encodeURIComponent(i.inspeccion_id)}`));
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
  const hayCuadricula = Array.isArray(ins.cuadricula);

  // ---------- formulario ----------
  const entradas = Object.fromEntries(CLASES.map((c) => [c, el('input', { type: 'number', min: 0, max: 100, step: 1, required: true, inputmode: 'numeric' })]));
  const suma = el('span', { class: 'tenue' }, 'Suma: 0 de 100');
  const archivo = el('input', { type: 'file', accept: '.csv,text/csv', disabled: !hayCuadricula });
  const infoArchivo = el('span', { class: 'tenue' },
    hayCuadricula ? 'Opcional. Columnas: fila, columna, clase_experta (100 filas).'
      : 'No disponible: la cuadrícula de esta inspección es «no asignable».');
  const aviso = el('div', { class: 'mensaje' });
  const resultado = el('div', { style: { display: 'grid', gap: '20px' } });
  let csvPosiciones = null;

  const actualizarSuma = () => {
    const s = CLASES.reduce((a, c) => a + (Number(entradas[c].value) || 0), 0);
    suma.textContent = `Suma: ${s} de 100${s === 100 ? '' : ' (debe sumar 100)'}`;
  };
  for (const c of CLASES) entradas[c].addEventListener('input', actualizarSuma);

  archivo.addEventListener('change', async () => {
    csvPosiciones = null;
    const f = archivo.files?.[0];
    if (!f) return;
    csvPosiciones = await f.text();
    // Vista previa local: los conteos de la experta salen del CSV.
    const conteo = Object.fromEntries(CLASES.map((c) => [c, 0]));
    let filas = 0;
    for (const linea of csvPosiciones.split(/\r?\n/).slice(1)) {
      const clase = linea.split(/[,;]/)[2]?.trim().toLowerCase();
      if (clase in conteo) { conteo[clase] += 1; filas += 1; }
    }
    for (const c of CLASES) entradas[c].value = conteo[c];
    actualizarSuma();
    infoArchivo.textContent = `${f.name}: ${filas} posiciones leídas; los conteos se tomaron del CSV.`;
  });

  const formulario = el('form', { novalidate: true, style: { display: 'grid', gap: '14px' } },
    el('div', { class: 'formulario' }, CLASES.map((c) => el('label', {},
      el('span', { class: 'clase-celda' }, el('span', { class: 'muestra', style: { background: colorClase(c) } }), NOMBRES[c]), entradas[c]))),
    suma,
    el('label', {}, 'CSV por posición', archivo),
    infoArchivo,
    el('div', { class: 'fila' }, el('button', { type: 'submit' }, 'Calcular y guardar la validación'),
      el('a', { class: 'boton secundario', href: `/api/export/validaciones.csv?inspeccion_id=${idUrl}`, download: `validacion_${ins.inspeccion_id}.csv` }, 'Exportar CSV')),
    aviso);

  raiz.append(
    el('section', { class: 'tarjeta' },
      el('header', {},
        el('div', {}, el('h2', {}, `Validación de ${ins.inspeccion_id}`),
          el('div', { class: 'tenue' }, `Lote ${ins.lote_id} · ${fecha(ins.inicio)} · ${ins.fuente ?? '—'}`)),
        el('a', { href: `#/inspeccion/${idUrl}` }, 'ver la inspección')),
      el('h3', {}, 'Sistema (mediana de la inspección)'),
      tabla([
        { titulo: '', valor: () => 'Sistema' },
        ...CLASES.map((c) => ({ titulo: NOMBRES[c], num: true, valor: () => num(ins.conteos?.[c]) })),
        { titulo: 'Total', num: true, valor: () => num(ins.total) },
      ], [ins]),
      el('h3', {}, 'Experta'),
      formulario),
    resultado,
  );

  // Precarga de los conteos de la experta para las pruebas existentes (mismo archivo que usa el benchmark).
  try {
    const precarga = await conteosPrecargados(ins.fuente);
    if (precarga) {
      for (const c of CLASES) entradas[c].value = precarga[c];
      mensaje(aviso, `Conteos de la experta precargados para la prueba ${precarga.prueba}. Revíselos antes de guardar.`);
    }
  } catch { /* sin precarga */ }
  actualizarSuma();

  // Validación ya guardada, si existe.
  try {
    const v = await api(`/api/validaciones/${idUrl}`);
    if (v) {
      for (const c of CLASES) entradas[c].value = v.conteos_experta?.[c] ?? '';
      actualizarSuma();
      mostrarResultado(resultado, v);
      mensaje(aviso, `Validación guardada el ${fecha(v.creado_en)}.`, 'bien');
    }
  } catch (e) {
    if (e.status !== 404) mensaje(aviso, e.message, 'error');
  }

  formulario.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cuerpo = { inspeccion_id: ins.inspeccion_id };
    if (csvPosiciones) cuerpo.csv_posiciones = csvPosiciones;
    else cuerpo.conteos_experta = Object.fromEntries(CLASES.map((c) => [c, Number(entradas[c].value)]));
    try {
      const v = await api('/api/validaciones', { method: 'POST', body: cuerpo });
      mostrarResultado(resultado, v);
      mensaje(aviso, 'Validación guardada.', 'bien');
    } catch (err) {
      mensaje(aviso, err.status === 404 && err.message === 'Ruta no encontrada'
        ? 'El cálculo de la validación se habilita en la Etapa 5.' : err.message, 'error');
    }
  });
}

async function conteosPrecargados(fuente) {
  if (!fuente) return null;
  const video = fuente.split(/[\\/]/).pop();
  const res = await fetch('/datos/conteos_experta.csv');
  if (!res.ok) return null;
  const [cabecera, ...filas] = (await res.text()).trim().split(/\r?\n/);
  const columnas = cabecera.split(',');
  for (const f of filas) {
    const valores = Object.fromEntries(f.split(',').map((v, i) => [columnas[i], v]));
    if (valores.video?.split('/').pop() === video) {
      return { prueba: valores.prueba, ...Object.fromEntries(CLASES.map((c) => [c, Number(valores[c])])) };
    }
  }
  return null;
}

function mostrarResultado(raiz, v) {
  raiz.replaceChildren();
  raiz.append(el('section', { class: 'tarjeta' },
    el('header', {}, el('h2', {}, 'Concordancia de conteos'), el('span', { class: 'tenue' }, 'C = (1 − Σ|nE − nS| / 100) × 100')),
    el('div', { class: 'indicadores' },
      el('div', { class: 'indicador' }, el('div', { class: 'etiqueta' }, 'Concordancia C'), el('div', { class: 'valor grande' }, `${num(v.C, 1)} %`)),
      el('div', { class: 'indicador' }, el('div', { class: 'etiqueta' }, 'Tasa de detección'), el('div', { class: 'valor' }, `${num(v.tasa_deteccion, 1)} %`),
        el('div', { class: 'detalle' }, 'detecciones del sistema / 100'))),
    tabla([
      { titulo: 'Clase', valor: (c) => el('span', { class: 'clase-celda' }, el('span', { class: 'muestra', style: { background: colorClase(c) } }), NOMBRES[c]) },
      { titulo: 'Experta', num: true, valor: (c) => num(v.conteos_experta?.[c]) },
      { titulo: 'Sistema', num: true, valor: (c) => num(v.conteos_sistema?.[c]) },
      { titulo: 'Diferencia (S − E)', num: true, valor: (c) => { const d = v.diferencias_por_clase?.[c]; return d == null ? '—' : `${d > 0 ? '+' : ''}${d}`; } },
    ], CLASES)));

  if (!v.matriz_confusion) return;
  const max = Math.max(1, ...v.matriz_confusion.flat());
  const paso = (n) => (n === 0 ? 0 : Math.min(6, 1 + Math.floor((5 * n) / max)));
  const thead = el('thead', {}, el('tr', {}, el('th', {}, 'Experta \\ Sistema'), CLASES.map((c) => el('th', { class: 'num' }, NOMBRES[c])), el('th', { class: 'num' }, 'Total')));
  const tbody = el('tbody', {}, CLASES.map((ce, i) => el('tr', {},
    el('th', {}, NOMBRES[ce]),
    CLASES.map((cs, j) => {
      const n = v.matriz_confusion[i][j];
      const s = paso(n);
      return el('td', { class: 'num', title: `Experta ${NOMBRES[ce]}, sistema ${NOMBRES[cs]}: ${n}`,
        style: { background: `var(--sec-${s})`, color: s >= 4 ? '#fff' : 'var(--tinta)' } }, String(n));
    }),
    el('td', { class: 'num' }, String(v.matriz_confusion[i].reduce((a, b) => a + b, 0))))));
  raiz.append(el('section', { class: 'tarjeta' },
    el('header', {}, el('h2', {}, 'Validación por posición'), el('span', { class: 'tenue' }, `${num(v.n_posiciones)} mitades`)),
    el('div', { class: 'indicadores' },
      el('div', { class: 'indicador' }, el('div', { class: 'etiqueta' }, 'Exactitud por mitad'), el('div', { class: 'valor' }, `${num(100 * v.exactitud_por_mitad, 1)} %`),
        el('div', { class: 'detalle' }, 'diagonal / N')),
      el('div', { class: 'indicador' }, el('div', { class: 'etiqueta' }, 'Kappa de Cohen'), el('div', { class: 'valor' }, num(v.kappa, 3)),
        el('div', { class: 'detalle' }, `IC 95 %: ${num(v.ic95_kappa?.[0], 3)} a ${num(v.ic95_kappa?.[1], 3)}`))),
    el('h3', {}, 'Matriz de confusión (filas: experta; columnas: sistema)'),
    el('div', { class: 'tabla-envoltura' }, el('table', { class: 'matriz' }, thead, tbody))));
}
