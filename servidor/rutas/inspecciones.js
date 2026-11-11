import { Router } from 'express';
import Lote from '../modelos/Lote.js';
import Inspeccion, { SIN_CAMPOS_PESADOS } from '../modelos/Inspeccion.js';
import { config, ErrorHttp } from '../configuracion.js';
import { estadoNodo, publicarComando } from '../mqtt_servidor.js';

const rutas = Router();

// POST /api/inspecciones  { lote_id, ventana_s? }
// Crea el inspeccion_id y publica el comando de inicio. El resultado llega
// después por MQTT y queda en MongoDB; se consulta con GET /api/inspecciones/:id.
rutas.post('/', async (req, res) => {
  const loteId = String(req.body?.lote_id ?? '').trim();
  if (!loteId) throw new ErrorHttp(400, 'Falta lote_id');
  if (!(await Lote.exists({ lote_id: loteId }))) throw new ErrorHttp(404, `No existe el lote ${loteId}`);

  const ventanaS = req.body?.ventana_s === undefined ? config.ventanaS : Number(req.body.ventana_s);
  if (!Number.isFinite(ventanaS) || ventanaS <= 0 || ventanaS > 600) throw new ErrorHttp(400, 'ventana_s debe estar entre 0 y 600 s');

  const estado = estadoNodo()?.estado ?? 'desconocido';
  if (estado !== 'listo') throw new ErrorHttp(409, `El nodo no está listo (estado: ${estado})`);

  const comando = await publicarComando(loteId, ventanaS);
  res.status(202).json(comando);
});

// GET /api/inspecciones?lote_id=   (sin la imagen ni otros campos pesados)
rutas.get('/', async (req, res) => {
  const filtro = req.query.lote_id ? { lote_id: String(req.query.lote_id) } : {};
  res.json(await Inspeccion.find(filtro).select(SIN_CAMPOS_PESADOS).sort({ inicio: -1 }).lean());
});

// GET /api/inspecciones/:id   (completa, con la imagen)
rutas.get('/:id', async (req, res) => {
  const inspeccion = await Inspeccion.findOne({ inspeccion_id: String(req.params.id) }).lean();
  if (!inspeccion) throw new ErrorHttp(404, `No existe la inspección ${req.params.id}`);
  res.json(inspeccion);
});

export default rutas;
