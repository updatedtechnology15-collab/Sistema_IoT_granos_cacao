// Conexión del tablero al broker por MQTT sobre WebSocket seguro (WSS).
// Usa solo la credencial "tablero" (solo suscripción), que entrega GET /api/config/mqtt.
import { api } from './util.js';

const oyentes = new Set();
let cliente = null;

export const estado = {
  conectado: false,
  nodo: null,          // último mensaje de cacao/<est>/estado
  config: null,        // respuesta de /api/config/mqtt (sin usar la clave fuera de aquí)
};

function emitir(tipo, datos) {
  for (const fn of oyentes) {
    try { fn(tipo, datos); } catch (e) { console.error(e); }
  }
}

/** Registra una función (tipo, datos). Devuelve la función para anular el registro. */
export function escuchar(fn) {
  oyentes.add(fn);
  return () => oyentes.delete(fn);
}

export async function conectar() {
  const cfg = await api('/api/config/mqtt');
  estado.config = { base: cfg.base_topicos, estacionId: cfg.estacion_id, ventanaS: cfg.ventana_s,
    calentamiento: cfg.cuadros_calentamiento };
  const base = cfg.base_topicos;

  cliente = window.mqtt.connect(cfg.url, {
    username: cfg.usuario,
    password: cfg.clave,
    clientId: `tablero-${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
  });
  cliente.on('connect', () => {
    estado.conectado = true;
    cliente.subscribe([`${base}/estado`, `${base}/detecciones`, `${base}/cuadro`, `${base}/inspeccion`], { qos: 0 });
    emitir('conexion', true);
  });
  const desconectado = () => {
    if (estado.conectado) {
      estado.conectado = false;
      emitir('conexion', false);
    }
  };
  cliente.on('close', desconectado);
  cliente.on('offline', desconectado);
  cliente.on('error', (e) => console.warn('MQTT:', e.message));

  const decodificador = new TextDecoder();
  cliente.on('message', (tema, carga) => {
    const sub = tema.slice(tema.lastIndexOf('/') + 1);
    let datos;
    try { datos = JSON.parse(decodificador.decode(carga)); } catch { return; }
    if (sub === 'estado') estado.nodo = datos;
    emitir(sub, datos);
  });
}
