import { Router } from 'express';
import { config } from '../configuracion.js';

const rutas = Router();

// GET /api/config/mqtt  -> datos de conexión WSS del tablero. Entrega SOLO la
// credencial "tablero" (de solo suscripción); nunca la del nodo ni la del servidor.
rutas.get('/mqtt', (_req, res) => {
  const { host, puertoWss, rutaWss, tablero } = config.mqtt;
  res.set('Cache-Control', 'no-store');
  res.json({
    url: `wss://${host}:${puertoWss}${rutaWss}`,
    usuario: tablero.usuario,
    clave: tablero.clave,
    estacion_id: config.estacionId,
    base_topicos: `cacao/${config.estacionId}`,
    ventana_s: config.ventanaS,
    cuadros_calentamiento: config.cuadrosCalentamiento,
  });
});

export default rutas;
