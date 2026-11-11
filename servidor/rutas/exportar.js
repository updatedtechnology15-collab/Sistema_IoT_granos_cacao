// Exportación en CSV (coma como separador, punto decimal, UTF-8). Todas las rutas
// aceptan los filtros opcionales ?lote_id= e ?inspeccion_id=.
//   GET /api/export/inspecciones.csv   una fila por inspección
//   GET /api/export/validaciones.csv   una fila por validación
//   GET /api/export/iot.csv            una fila por inspección con las métricas de la red IoT
import { Router } from 'express';
import Inspeccion from '../modelos/Inspeccion.js';
import Validacion from '../modelos/Validacion.js';
import { CLASES } from '../calculos.js';

const rutas = Router();

function filtro(query) {
  const f = {};
  if (query.lote_id) f.lote_id = String(query.lote_id);
  if (query.inspeccion_id) f.inspeccion_id = String(query.inspeccion_id);
  return f;
}

function celda(v) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const texto = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function enviarCsv(res, nombre, columnas, filas) {
  const lineas = [columnas.map((c) => c[0]).join(',')];
  for (const f of filas) lineas.push(columnas.map(([, valor]) => celda(valor(f))).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(`${lineas.join('\r\n')}\r\n`);
}

const porClase = (prefijo, obtener) => CLASES.map((c) => [`${prefijo}${c}`, (x) => obtener(x)?.[c]]);

rutas.get('/inspecciones.csv', async (req, res) => {
  const filas = await Inspeccion.find(filtro(req.query))
    .select('-imagen_jpeg -detecciones_representativas -iot.latencias_ms -iot.seq_faltantes').sort({ inicio: 1 }).lean();
  enviarCsv(res, 'inspecciones.csv', [
    ['inspeccion_id', (i) => i.inspeccion_id],
    ['lote_id', (i) => i.lote_id],
    ['estacion_id', (i) => i.estacion_id],
    ['inicio', (i) => i.inicio],
    ['fin', (i) => i.fin],
    ['fuente', (i) => i.fuente],
    ['tipo_fuente', (i) => i.tipo_fuente],
    ['ventana_s', (i) => i.ventana_s],
    ['fps_operacion', (i) => i.fps_operacion],
    ['fps_fuente', (i) => i.fps_fuente],
    ['n_cuadros', (i) => i.n_cuadros],
    ['n_cuadros_latencia', (i) => i.n_cuadros_latencia],
    ['modelo', (i) => i.modelo],
    ['dispositivo', (i) => i.dispositivo],
    ['modo_inferencia', (i) => i.modo_inferencia],
    ['imgsz', (i) => i.parametros?.imgsz],
    ['conf', (i) => i.parametros?.conf],
    ['area_min_frac', (i) => i.parametros?.area_min_frac],
    ['area_max_frac', (i) => i.parametros?.area_max_frac],
    ...porClase('', (i) => i.conteos),
    ['total', (i) => i.total],
    ...porClase('pct_', (i) => i.porcentajes),
    ['latencia_media_ms', (i) => i.latencia?.media_ms],
    ['latencia_de_ms', (i) => i.latencia?.de_ms],
    ['latencia_p95_ms', (i) => i.latencia?.p95_ms],
    ['fps_max', (i) => i.latencia?.fps_max],
    ['rss_max_mb', (i) => i.recursos?.rss_max_mb],
    ['cpu_media_pct', (i) => i.recursos?.cpu_media_pct],
    ['gpu_mem_max_mb', (i) => i.recursos?.gpu_mem_max_mb],
    ['cpu', (i) => i.hardware?.cpu],
    ['gpu', (i) => i.hardware?.gpu],
    ['ram_gb', (i) => i.hardware?.ram_gb],
    ['so', (i) => i.hardware?.so],
    ['python', (i) => i.versiones?.python],
    ['torch', (i) => i.versiones?.torch],
    ['ultralytics', (i) => i.versiones?.ultralytics],
    ['opencv', (i) => i.versiones?.opencv],
    ['cuadro_representativo', (i) => i.cuadro_representativo?.cuadro],
    ['cuadricula', (i) => (Array.isArray(i.cuadricula) ? 'asignada' : i.cuadricula)],
  ], filas);
});

rutas.get('/validaciones.csv', async (req, res) => {
  const filas = await Validacion.find(filtro(req.query)).select('-posiciones').sort({ creado_en: 1 }).lean();
  const matriz = CLASES.flatMap((ce, i) => CLASES.map((cs, j) => [`mc_${ce}_${cs}`, (v) => v.matriz_confusion?.[i]?.[j]]));
  enviarCsv(res, 'validaciones.csv', [
    ['inspeccion_id', (v) => v.inspeccion_id],
    ['lote_id', (v) => v.lote_id],
    ['origen_datos', (v) => v.origen_datos],
    ['actualizado_en', (v) => v.actualizado_en],
    ['N', (v) => v.N],
    ...porClase('experta_', (v) => v.conteos_experta),
    ...porClase('sistema_', (v) => v.conteos_sistema),
    ['total_sistema', (v) => v.total_sistema],
    ...porClase('dif_', (v) => v.diferencias_por_clase),
    ['C', (v) => v.C],
    ['tasa_deteccion', (v) => v.tasa_deteccion],
    ['n_posiciones', (v) => v.n_posiciones],
    ['exactitud_por_mitad', (v) => v.exactitud_por_mitad],
    ['kappa', (v) => v.kappa],
    ['ic95_kappa_inf', (v) => v.ic95_kappa?.[0]],
    ['ic95_kappa_sup', (v) => v.ic95_kappa?.[1]],
    ['p_o', (v) => v.p_o],
    ['p_e', (v) => v.p_e],
    ...matriz,
  ], filas);
});

rutas.get('/iot.csv', async (req, res) => {
  const filas = await Inspeccion.find(filtro(req.query))
    .select('inspeccion_id lote_id inicio modelo dispositivo iot -_id').sort({ inicio: 1 }).lean();
  enviarCsv(res, 'iot.csv', [
    ['inspeccion_id', (i) => i.inspeccion_id],
    ['lote_id', (i) => i.lote_id],
    ['inicio', (i) => i.inicio],
    ['modelo', (i) => i.modelo],
    ['dispositivo', (i) => i.dispositivo],
    ['n_publicados', (i) => i.iot?.n_publicados],
    ['n_recibidos', (i) => i.iot?.n_recibidos],
    ['n_faltantes', (i) => i.iot?.n_faltantes],
    ['perdida_pct', (i) => i.iot?.perdida_pct],
    ['lat_borde_servidor_media_ms', (i) => i.iot?.lat_borde_servidor_media_ms],
    ['lat_borde_servidor_de_ms', (i) => i.iot?.lat_borde_servidor_de_ms],
    ['lat_borde_servidor_p95_ms', (i) => i.iot?.lat_borde_servidor_p95_ms],
    ['lat_resultado_ms', (i) => i.iot?.lat_resultado_ms],
    ['t_total_inspeccion_s', (i) => i.iot?.t_total_inspeccion_s],
  ], filas);
});

export default rutas;
