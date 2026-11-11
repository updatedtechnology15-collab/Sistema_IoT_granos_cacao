// Configuración del servidor. Los secretos vienen de .env (raíz del proyecto);
// estacion_id y ventana_s se leen de edge/config.yaml para que el nodo y el
// servidor usen los mismos tópicos y la misma ventana.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const DIR_SERVIDOR = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(DIR_SERVIDOR, '..');

dotenv.config({ path: path.join(RAIZ, '.env'), quiet: true });

function requerida(nombre) {
  const valor = process.env[nombre];
  if (!valor || !valor.trim()) {
    throw new Error(`Falta ${nombre} en .env (vea .env.example)`);
  }
  return valor;
}

// edge/config.yaml es plano (una clave por línea), así que se lee sin dependencias.
function valorDeConfigYaml(clave, porDefecto) {
  const texto = fs.readFileSync(path.join(RAIZ, 'edge', 'config.yaml'), 'utf8');
  const m = texto.match(new RegExp(`^${clave}:\\s*([^#\\r\\n]+)`, 'm'));
  return m ? m[1].trim() : porDefecto;
}

const estacionId = valorDeConfigYaml('estacion_id', 'est01');

export const config = {
  estacionId,
  ventanaS: Number(valorDeConfigYaml('ventana_s', '30')),
  cuadrosCalentamiento: Number(valorDeConfigYaml('cuadros_calentamiento', '20')),
  puertoHttp: Number(process.env.PUERTO_HTTP || 3000),
  // 127.0.0.1: solo este equipo. 0.0.0.0 expone la API a toda la red (sin autenticación).
  hostHttp: (process.env.HOST_HTTP || '127.0.0.1').trim(),
  mongodbUri: requerida('MONGODB_URI'),
  mqtt: {
    host: requerida('MQTT_HOST').trim(),
    puertoTls: Number(process.env.MQTT_PORT_TLS || 8883),
    puertoWss: Number(process.env.MQTT_PORT_WSS || 8084),
    rutaWss: process.env.MQTT_WSS_PATH || '/mqtt',
    // "servidor": se suscribe a los tópicos de la estación y publica el comando de inicio.
    servidor: { usuario: requerida('SERVIDOR_USER').trim(), clave: requerida('SERVIDOR_PASS') },
    // "tablero": solo lectura; se entrega al navegador en GET /api/config/mqtt.
    tablero: { usuario: requerida('TABLERO_USER').trim(), clave: requerida('TABLERO_PASS') },
  },
};

export const topico = (sub) => `cacao/${config.estacionId}/${sub}`;

/** Marca de tiempo UTC en ISO 8601 con milisegundos (igual que el nodo). */
export const ahoraIso = () => new Date().toISOString();

export function log(...partes) {
  console.log(new Date().toLocaleTimeString('es-EC', { hour12: false }), ...partes);
}

/** Error con código HTTP; el manejador de errores de server.js lo convierte en respuesta JSON. */
export class ErrorHttp extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}
