// Medidas de seguridad HTTP del servidor (sin dependencias y de costo despreciable).
//
// - Por defecto el servidor escucha solo en 127.0.0.1 (HOST_HTTP en .env): nadie
//   más en la red puede usar la API ni leer la credencial "tablero".
// - Con el servidor en una interfaz local se rechazan las peticiones cuyo encabezado
//   Host no sea local, para evitar ataques de DNS rebinding contra localhost.
// - Encabezados: Content-Security-Policy estricta (solo scripts propios y conexión
//   WSS al broker), nosniff, sin marcos, sin Referer, sin X-Powered-By.
import { config } from './configuracion.js';

const LOCALES = new Set(['127.0.0.1', 'localhost', '::1']);

export const escuchaSoloLocal = () => LOCALES.has(config.hostHttp);

export function verificarHost() {
  const permitidos = new Set(['localhost', '127.0.0.1', '[::1]'].map((h) => `${h}:${config.puertoHttp}`));
  return (req, res, next) => {
    if (!escuchaSoloLocal() || permitidos.has(String(req.headers.host ?? '').toLowerCase())) return next();
    res.status(403).json({ error: 'Host no permitido' });
  };
}

export function encabezadosSeguridad() {
  const { host, puertoWss } = config.mqtt;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // MQTT.js crea un worker desde un blob: para sus temporizadores (mantiene viva la
    // conexión con la pestaña en segundo plano). Solo los scripts propios pueden crearlo.
    "worker-src 'self' blob:",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' wss://${host}:${puertoWss}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return (_req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  };
}
