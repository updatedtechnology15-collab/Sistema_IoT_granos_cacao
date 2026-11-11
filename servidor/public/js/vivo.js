// Página «En vivo»: cuadro en vivo con sus cajas, conteo por clase, confianza
// media, latencia y fps del nodo, e inicio de una inspección con barra de progreso.
import { escuchar, estado } from './mqtt_tablero.js';
import {
  CLASES, NOMBRES, api, el, num, mensaje, indicador, barraSegmentada, leyendaClases,
  leerPreferencia, guardarPreferencia, variableCss,
} from './util.js';

let quitarOyente = null;
let grafico = null;
let esperaResultado = null;

// Inspección que se está mostrando (la que inició el tablero o la que el nodo esté procesando).
const actual = { id: null, ventanaS: 30, latencias: [], ultimoCuadro: -1 };

export function mostrar(raiz) {
  // ---------- controles ----------
  const selector = el('select', { 'aria-label': 'Lote' });
  const boton = el('button', { type: 'button' }, 'Iniciar inspección de 30 s');
  const barra = el('div');
  const progreso = el('div', { class: 'progreso', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Progreso de la inspección' }, barra);
  const textoProgreso = el('span', { class: 'tenue' }, 'Sin inspección en curso');
  const aviso = el('div', { class: 'mensaje' });

  // ---------- imagen ----------
  const imagen = el('img', { alt: 'Cuadro en vivo del nodo con las detecciones' });
  const marco = el('div', { class: 'marco-imagen' }, el('span', { class: 'tenue' }, 'Esperando el cuadro en vivo…'));

  // ---------- indicadores ----------
  const porClase = Object.fromEntries(CLASES.map((c) => [c, indicador(NOMBRES[c], { clase: c })]));
  const total = indicador('Total detectado');
  const confianza = indicador('Confianza media');
  const latencia = indicador('Latencia del cuadro', { detalle: 'ms' });
  const fps = indicador('fps del nodo', { detalle: '1000 / latencia media' });
  const composicion = el('div', {}, barraSegmentada(null));

  const lienzo = el('canvas', { role: 'img', 'aria-label': 'Latencia por cuadro de la inspección en curso' });

  raiz.append(
    el('section', { class: 'tarjeta' },
      el('header', {}, el('h2', {}, 'Iniciar inspección'), el('span', { class: 'tenue' }, 'Ventana de 30 s; el nodo debe estar listo')),
      el('div', { class: 'fila' }, el('label', { style: { flex: '1 1 220px' } }, 'Lote', selector), el('div', { style: { alignSelf: 'end' } }, boton)),
      progreso,
      textoProgreso,
      aviso),
    el('div', { class: 'vivo-grid' },
      el('section', { class: 'tarjeta' },
        el('header', {}, el('h2', {}, 'Cuadro en vivo'), el('span', { class: 'tenue', id: 'vivo-ref' }, '')),
        marco),
      el('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '20px', minWidth: '0' } },
        el('section', { class: 'tarjeta' },
          el('header', {}, el('h2', {}, 'Conteo del cuadro')),
          el('div', { class: 'indicadores' }, CLASES.map((c) => porClase[c].nodo), total.nodo, confianza.nodo),
          composicion,
          leyendaClases()),
        el('section', { class: 'tarjeta' },
          el('header', {}, el('h2', {}, 'Rendimiento del nodo')),
          el('div', { class: 'indicadores' }, latencia.nodo, fps.nodo),
          el('h3', {}, 'Latencia por cuadro (ms), sin los cuadros de calentamiento'),
          el('div', { class: 'grafico' }, lienzo)))),
  );

  grafico = crearGrafico(lienzo);
  temaOscuro.addEventListener('change', recolorearGrafico);

  // ---------- lotes ----------
  cargarLotes(selector, boton);
  selector.addEventListener('change', () => { guardarPreferencia('lote', selector.value); actualizarBoton(); });

  function actualizarBoton() {
    const listo = estado.nodo?.estado === 'listo' && estado.conectado;
    boton.disabled = !selector.value || !listo;
    boton.title = !selector.value ? 'Elija un lote' : listo ? '' : 'El nodo no está listo';
  }

  function ponerProgreso(fraccion, texto) {
    const pct = Math.max(0, Math.min(100, Math.round(fraccion * 100)));
    barra.style.width = `${pct}%`;
    progreso.setAttribute('aria-valuenow', String(pct));
    textoProgreso.textContent = texto;
  }

  function nuevaInspeccion(id, ventanaS) {
    actual.id = id;
    actual.ventanaS = ventanaS ?? estado.config?.ventanaS ?? 30;
    actual.latencias = [];
    actual.ultimoCuadro = -1;
    clearInterval(esperaResultado);
    grafico.data.datasets[0].data = [];
    grafico.options.scales.x.max = actual.ventanaS;
    grafico.update('none');
  }

  boton.addEventListener('click', async () => {
    boton.disabled = true;
    mensaje(aviso, 'Enviando el comando de inicio…');
    try {
      const comando = await api('/api/inspecciones', { method: 'POST', body: { lote_id: selector.value } });
      nuevaInspeccion(comando.inspeccion_id, comando.ventana_s);
      ponerProgreso(0, `Inspección ${comando.inspeccion_id} · esperando el primer cuadro…`);
      mensaje(aviso, `Comando enviado (lote ${comando.lote_id}).`, 'bien');
    } catch (e) {
      mensaje(aviso, e.message, 'error');
      actualizarBoton();
    }
  });

  // ---------- mensajes MQTT ----------
  quitarOyente = escuchar((tipo, d) => {
    if (tipo === 'estado' || tipo === 'conexion') actualizarBoton();

    if (tipo === 'cuadro') {
      imagen.src = `data:image/jpeg;base64,${d.jpeg_b64}`;
      if (imagen.parentNode !== marco) marco.replaceChildren(imagen);
      document.getElementById('vivo-ref').textContent = `${d.inspeccion_id} · cuadro ${d.cuadro} · ${d.ancho}×${d.alto}`;
    }

    if (tipo === 'detecciones') {
      if (d.inspeccion_id !== actual.id) nuevaInspeccion(d.inspeccion_id); // p. ej., iniciada por consola
      if (d.cuadro <= actual.ultimoCuadro) return; // QoS 0: puede llegar desordenado
      actual.ultimoCuadro = d.cuadro;

      let suma = 0;
      for (const c of CLASES) {
        porClase[c].valor.textContent = num(d.conteos?.[c] ?? 0);
        suma += d.conteos?.[c] ?? 0;
      }
      total.valor.textContent = num(suma);
      total.detalle.textContent = `cuadro ${d.cuadro}`;
      const confs = (d.detecciones ?? []).map((x) => x.conf);
      confianza.valor.textContent = confs.length ? num(confs.reduce((a, b) => a + b, 0) / confs.length, 2) : '—';
      confianza.detalle.textContent = `${confs.length} detecciones`;
      composicion.replaceChildren(barraSegmentada(d.conteos));

      latencia.valor.textContent = num(d.latencia_ms, 1);
      const calentamiento = estado.config?.calentamiento ?? 20;
      if (d.cuadro >= calentamiento) {
        actual.latencias.push(d.latencia_ms);
        grafico.data.datasets[0].data.push({ x: d.t_video_s, y: d.latencia_ms });
        grafico.update('none');
        const media = actual.latencias.reduce((a, b) => a + b, 0) / actual.latencias.length;
        fps.valor.textContent = num(1000 / media, 1);
        latencia.detalle.textContent = `ms · media ${num(media, 1)} ms`;
      } else {
        latencia.detalle.textContent = `ms · calentamiento (${d.cuadro + 1}/${calentamiento})`;
      }
      ponerProgreso(d.t_video_s / actual.ventanaS, `Inspección ${d.inspeccion_id} · t = ${num(d.t_video_s, 1)} s de ${num(actual.ventanaS, 0)} s`);
    }

    if (tipo === 'inspeccion' && d.inspeccion_id === actual.id) {
      ponerProgreso(1, `Inspección ${d.inspeccion_id} terminada · guardando en la base de datos…`);
      esperarGuardado(d.inspeccion_id);
    }
  });

  function esperarGuardado(id) {
    let intentos = 0;
    clearInterval(esperaResultado);
    esperaResultado = setInterval(async () => {
      intentos += 1;
      try {
        await api(`/api/inspecciones/${encodeURIComponent(id)}`);
        clearInterval(esperaResultado);
        textoProgreso.replaceChildren(`Inspección ${id} guardada · `, el('a', { href: `#/inspeccion/${encodeURIComponent(id)}` }, 'ver detalle'));
      } catch {
        if (intentos >= 30) {
          clearInterval(esperaResultado);
          textoProgreso.textContent = `Inspección ${id}: el servidor no confirmó el guardado en 30 s`;
        }
      }
    }, 1000);
  }

  actualizarBoton();
}

export function salir() {
  quitarOyente?.();
  quitarOyente = null;
  clearInterval(esperaResultado);
  temaOscuro.removeEventListener('change', recolorearGrafico);
  grafico?.destroy();
  grafico = null;
}

const temaOscuro = window.matchMedia('(prefers-color-scheme: dark)');

// Los colores del gráfico salen de las variables CSS; se vuelven a leer si cambia el modo claro/oscuro.
function coloresGrafico() {
  return { tinta: variableCss('--tinta-2'), linea: variableCss('--linea'), eje: variableCss('--eje'),
    serie: variableCss('--acento'), superficie: variableCss('--superficie') };
}

function recolorearGrafico() {
  if (!grafico) return;
  const c = coloresGrafico();
  const ds = grafico.data.datasets[0];
  ds.borderColor = c.serie;
  ds.backgroundColor = c.serie;
  ds.pointHoverBorderColor = c.superficie;
  const { x, y } = grafico.options.scales;
  x.grid.color = c.linea; y.grid.color = c.linea;
  x.border.color = c.eje;
  x.ticks.color = c.tinta; y.ticks.color = c.tinta; x.title.color = c.tinta;
  grafico.update('none');
}

async function cargarLotes(selector, boton) {
  try {
    const lotes = await api('/api/lotes');
    if (!lotes.length) {
      selector.append(el('option', { value: '' }, 'No hay lotes: créelos en la pestaña Lotes'));
      boton.disabled = true;
      return;
    }
    selector.append(el('option', { value: '' }, 'Elija un lote…'), ...lotes.map((l) => el('option', { value: l.lote_id }, `${l.lote_id} · ${l.origen}`)));
    const previo = leerPreferencia('lote');
    if (previo && lotes.some((l) => l.lote_id === previo)) selector.value = previo;
    selector.dispatchEvent(new Event('change'));
  } catch (e) {
    selector.append(el('option', { value: '' }, `Error al cargar lotes: ${e.message}`));
  }
}

// Línea de una sola serie (sin leyenda: el título la nombra), 2 px, cruz con tooltip.
function crearGrafico(lienzo) {
  const { tinta, linea, eje, serie, superficie } = coloresGrafico();
  const cruz = {
    id: 'cruz',
    afterDatasetsDraw(chart) {
      const activo = chart.tooltip?.getActiveElements?.() ?? [];
      if (!activo.length) return;
      const { ctx, chartArea } = chart;
      const x = activo[0].element.x;
      ctx.save();
      ctx.strokeStyle = variableCss('--eje');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };
  return new window.Chart(lienzo, {
    type: 'line',
    data: { datasets: [{ label: 'Latencia (ms)', data: [], borderColor: serie, backgroundColor: serie, borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: superficie,
      tension: 0, borderJoinStyle: 'round', borderCapStyle: 'round' }] },
    options: {
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => `t = ${num(items[0].parsed.x, 1)} s`,
            label: (item) => `${num(item.parsed.y, 1)} ms`,
          },
        },
      },
      scales: {
        x: { type: 'linear', min: 0, max: 30, title: { display: true, text: 't (s)', color: tinta },
          grid: { color: linea }, border: { color: eje }, ticks: { color: tinta } },
        y: { beginAtZero: true, grid: { color: linea }, border: { display: false }, ticks: { color: tinta } },
      },
    },
    plugins: [cruz],
  });
}
