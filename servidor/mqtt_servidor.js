// Cliente MQTT/TLS (8883) del servidor, credencial "servidor".
//
// - estado: guarda en memoria el último estado del nodo (retenido en el broker).
// - detecciones (QoS 0): NO se guarda cada mensaje. Por inspección solo se
//   acumulan los números de secuencia recibidos y la latencia nodo → servidor.
// - inspeccion (QoS 1): se guarda el resultado en MongoDB con sus métricas IoT.
// - comando (QoS 1): lo publica POST /api/inspecciones.
//
// La latencia nodo → servidor = hora de recepción − ts_pub. Es válida porque el
// nodo y el servidor corren en el mismo equipo y comparten reloj; si el servidor
// se mueve a otro equipo, hay que sincronizar ambos relojes por NTP.
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import Inspeccion from './modelos/Inspeccion.js';
import Lote from './modelos/Lote.js';
import { config, topico, ahoraIso, log, ErrorHttp } from './configuracion.js';
import { media, desviacion, percentil, redondear } from './estadistica.js';

const UNA_HORA_MS = 60 * 60 * 1000;

// Límites de defensa ante mensajes malformados o abusivos (no afectan al uso normal).
export const ID_VALIDO = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const MAX_SEGUIMIENTOS = 100; // inspecciones seguidas a la vez
const MAX_SEQ = 100000; // mensajes de detecciones por inspección
const MAX_IMAGEN = 8 * 1024 * 1024; // caracteres base64 de la imagen
const MAX_DETECCIONES = 2000;

let cliente = null;
let ultimoEstado = null;

// inspeccion_id -> { t_comando, seqs: Set, latencias: [], creado }
const seguimiento = new Map();

function registroDe(inspeccionId) {
  let r = seguimiento.get(inspeccionId);
  if (!r) {
    if (seguimiento.size >= MAX_SEGUIMIENTOS) seguimiento.delete(seguimiento.keys().next().value); // el más antiguo
    r = { t_comando: null, seqs: new Set(), latencias: [], creado: Date.now() };
    seguimiento.set(inspeccionId, r);
  }
  return r;
}

// Descarta seguimientos de inspecciones cuyo resultado nunca llegó.
setInterval(() => {
  const limite = Date.now() - UNA_HORA_MS;
  for (const [id, r] of seguimiento) if (r.creado < limite) seguimiento.delete(id);
}, 10 * 60 * 1000).unref();

export function estadoNodo() {
  return ultimoEstado;
}

export function mqttConectado() {
  return Boolean(cliente?.connected);
}

export function iniciarMqtt() {
  const { host, puertoTls, servidor } = config.mqtt;
  // Sesión persistente (clean: false) con identificador fijo: si el servidor se
  // reinicia, el broker le guarda los resultados (QoS 1) publicados mientras tanto.
  cliente = mqtt.connect(`mqtts://${host}:${puertoTls}`, {
    username: servidor.usuario,
    password: servidor.clave,
    clientId: `servidor-${config.estacionId}`,
    clean: false,
    keepalive: 30,
    reconnectPeriod: 2000,
    connectTimeout: 15000,
  });

  cliente.on('connect', () => {
    log(`MQTT conectado a ${host}:${puertoTls} (TLS)`);
    cliente.subscribe(
      { [topico('estado')]: { qos: 1 }, [topico('inspeccion')]: { qos: 1 }, [topico('detecciones')]: { qos: 0 } },
      (err) => (err ? log('Error al suscribirse:', err.message) : log(`Suscrito a ${topico('{estado,inspeccion,detecciones}')}`)),
    );
  });
  cliente.on('reconnect', () => log('MQTT: reconectando...'));
  cliente.on('offline', () => log('MQTT: sin conexión con el broker'));
  cliente.on('error', (err) => log('MQTT error:', err.message));

  cliente.on('message', (tema, carga) => {
    const tRecepcion = Date.now(); // antes de decodificar el mensaje
    const sub = tema.slice(tema.lastIndexOf('/') + 1);
    let datos;
    try {
      datos = JSON.parse(carga.toString('utf8'));
    } catch {
      log(`Mensaje no JSON en ${tema}; se ignora`);
      return;
    }
    if (sub === 'detecciones') alRecibirDetecciones(datos, tRecepcion);
    else if (sub === 'inspeccion') alRecibirInspeccion(datos, tRecepcion).catch((e) => log('No se guardó la inspección:', e.message));
    else if (sub === 'estado') {
      ultimoEstado = { ...datos, recibido_en: new Date(tRecepcion).toISOString() };
      log(`Estado del nodo: ${datos.estado}`);
    }
  });
  return cliente;
}

export function cerrarMqtt() {
  return new Promise((resolve) => (cliente ? cliente.end(false, {}, resolve) : resolve()));
}

function alRecibirDetecciones(d, tRecepcion) {
  if (!ID_VALIDO.test(String(d.inspeccion_id)) || !Number.isInteger(d.seq) || d.seq < 1 || d.seq > MAX_SEQ) return;
  const r = registroDe(d.inspeccion_id);
  if (r.seqs.has(d.seq) || r.seqs.size >= MAX_SEQ) return; // duplicado o fuera de límite
  r.seqs.add(d.seq);
  const tPub = Date.parse(d.ts_pub);
  if (Number.isFinite(tPub)) r.latencias.push(tRecepcion - tPub);
}

/** Devuelve el motivo por el que un resultado no es válido, o null si lo es. */
function problemaDelResultado(d) {
  const entero = (x, max) => Number.isInteger(x) && x >= 0 && x <= max;
  if (!ID_VALIDO.test(String(d.inspeccion_id))) return 'inspeccion_id no válido';
  if (!ID_VALIDO.test(String(d.lote_id))) return 'lote_id no válido';
  if (!d.conteos || !['fermentado', 'violeta', 'pizarroso', 'mohoso'].every((c) => entero(d.conteos[c], 10000))) return 'conteos no válidos';
  if (!entero(d.total, 40000)) return 'total no válido';
  if (!entero(d.n_publicados, MAX_SEQ)) return 'n_publicados no válido';
  if (typeof d.imagen_jpeg !== 'string' || d.imagen_jpeg.length > MAX_IMAGEN || !/^[A-Za-z0-9+/]*={0,2}$/.test(d.imagen_jpeg)) return 'imagen no válida';
  if (d.detecciones_representativas !== undefined && (!Array.isArray(d.detecciones_representativas) || d.detecciones_representativas.length > MAX_DETECCIONES)) return 'detecciones no válidas';
  if (!Number.isFinite(Date.parse(d.ts_pub))) return 'ts_pub no válido';
  return null;
}

async function alRecibirInspeccion(d, tRecepcion) {
  const id = d.inspeccion_id;
  const problema = problemaDelResultado(d);
  if (problema) {
    log(`Resultado descartado (${problema})`);
    return;
  }
  if (await Inspeccion.exists({ inspeccion_id: id })) {
    log(`Resultado ${id} repetido (QoS 1); ya estaba guardado`);
    return;
  }

  const r = registroDe(id);
  const nPublicados = Number.isInteger(d.n_publicados) ? d.n_publicados : 0;
  const faltantes = [];
  for (let s = 1; s <= nPublicados; s += 1) if (!r.seqs.has(s)) faltantes.push(s);
  const tPub = Date.parse(d.ts_pub);

  const iot = {
    n_publicados: nPublicados,
    n_recibidos: r.seqs.size,
    n_faltantes: faltantes.length,
    perdida_pct: nPublicados ? redondear((100 * faltantes.length) / nPublicados, 2) : null,
    lat_borde_servidor_media_ms: redondear(media(r.latencias)),
    lat_borde_servidor_de_ms: redondear(desviacion(r.latencias)),
    lat_borde_servidor_p95_ms: redondear(percentil(r.latencias, 95)),
    lat_resultado_ms: Number.isFinite(tPub) ? tRecepcion - tPub : null,
    t_total_inspeccion_s: null,
    seq_faltantes: faltantes,
    latencias_ms: r.latencias,
  };

  const { n_publicados: _n, ...resultado } = d; // n_publicados queda dentro de iot
  try {
    await Inspeccion.create({ ...resultado, recibido_en: new Date(tRecepcion), iot });
  } catch (e) {
    if (e.code === 11000) return; // otra copia del mismo mensaje se guardó primero
    throw e;
  }
  const tGuardado = Date.now();

  // Tiempo total: desde que el servidor publicó el comando hasta que el resultado quedó guardado.
  if (r.t_comando !== null) {
    iot.t_total_inspeccion_s = redondear((tGuardado - r.t_comando) / 1000, 3);
    await Inspeccion.updateOne({ inspeccion_id: id }, { $set: { 'iot.t_total_inspeccion_s': iot.t_total_inspeccion_s } });
  }
  seguimiento.delete(id);

  log(
    `Inspección ${id} guardada | lote ${d.lote_id} | total ${d.total} | ` +
      `recibidos ${iot.n_recibidos}/${nPublicados} (pérdida ${iot.perdida_pct} %) | ` +
      `lat. nodo→servidor ${iot.lat_borde_servidor_media_ms} ms | resultado ${iot.lat_resultado_ms} ms | ` +
      `t total ${iot.t_total_inspeccion_s ?? '—'} s`,
  );
  if (!(await Lote.exists({ lote_id: d.lote_id }))) {
    log(`Aviso: el lote ${d.lote_id} no está registrado; cree el lote para verlo en el tablero`);
  }
}

function nuevoIdInspeccion() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const fecha = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `insp-${fecha}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Crea el inspeccion_id y publica el comando de inicio (QoS 1). Resuelve cuando el broker lo confirma. */
export function publicarComando(loteId, ventanaS) {
  return new Promise((resolve, reject) => {
    if (!mqttConectado()) {
      reject(new ErrorHttp(503, 'El servidor no está conectado al broker MQTT'));
      return;
    }
    const inspeccionId = nuevoIdInspeccion();
    const comando = { accion: 'iniciar', lote_id: loteId, inspeccion_id: inspeccionId, ventana_s: ventanaS };
    const r = registroDe(inspeccionId);
    r.t_comando = Date.now();
    cliente.publish(topico('comando'), JSON.stringify({ ...comando, ts_pub: ahoraIso() }), { qos: 1 }, (err) => {
      if (err) {
        seguimiento.delete(inspeccionId);
        reject(new ErrorHttp(502, `No se pudo publicar el comando: ${err.message}`));
      } else {
        log(`Comando de inicio publicado: ${inspeccionId} (lote ${loteId}, ${ventanaS} s)`);
        resolve(comando);
      }
    });
  });
}
