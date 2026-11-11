import { Router } from 'express';
import Lote from '../modelos/Lote.js';
import Inspeccion, { SIN_CAMPOS_PESADOS } from '../modelos/Inspeccion.js';
import { ErrorHttp } from '../configuracion.js';

const rutas = Router();

const texto = (v) => (v === undefined || v === null ? undefined : String(v));

// POST /api/lotes  { lote_id, origen, descripcion, operador }
rutas.post('/', async (req, res) => {
  const { lote_id, origen, descripcion, operador } = req.body ?? {};
  const loteId = texto(lote_id)?.trim();
  if (loteId && (await Lote.exists({ lote_id: loteId }))) {
    throw new ErrorHttp(409, `El lote ${loteId} ya existe`);
  }
  const lote = await Lote.create({
    lote_id: loteId,
    origen: texto(origen),
    descripcion: texto(descripcion),
    operador: texto(operador),
  });
  res.status(201).json(lote);
});

// GET /api/lotes
rutas.get('/', async (_req, res) => {
  res.json(await Lote.find().sort({ creado_en: -1 }).lean());
});

// GET /api/lotes/:id  -> el lote y el historial de sus inspecciones (sin campos pesados)
rutas.get('/:id', async (req, res) => {
  const lote = await Lote.findOne({ lote_id: String(req.params.id) }).lean();
  if (!lote) throw new ErrorHttp(404, `No existe el lote ${req.params.id}`);
  const inspecciones = await Inspeccion.find({ lote_id: lote.lote_id }).select(SIN_CAMPOS_PESADOS).sort({ inicio: -1 }).lean();
  res.json({ ...lote, inspecciones });
});

export default rutas;
