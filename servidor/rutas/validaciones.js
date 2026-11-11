import { Router } from 'express';
import Inspeccion from '../modelos/Inspeccion.js';
import Validacion from '../modelos/Validacion.js';
import { ErrorHttp } from '../configuracion.js';
import {
  CLASES, N_GRANOS, concordancia, tasaDeteccion, diferencias, matrizConfusion, exactitud, kappaCohen, leerCsvPosiciones,
} from '../calculos.js';

const rutas = Router();
const PESADOS_SIN_IMAGEN = '-imagen_jpeg -detecciones_representativas -parametros -iot.latencias_ms -iot.seq_faltantes';

// POST /api/validaciones
//   { inspeccion_id, conteos_experta: {fermentado, violeta, pizarroso, mohoso} }    (los conteos suman 100)
//   { inspeccion_id, csv_posiciones: "fila,columna,clase_experta\n..." }             (100 posiciones)
// Con el CSV, los conteos de la experta salen del propio CSV.
rutas.post('/', async (req, res) => {
  const inspeccionId = String(req.body?.inspeccion_id ?? '');
  const ins = await Inspeccion.findOne({ inspeccion_id: inspeccionId }).select(PESADOS_SIN_IMAGEN).lean();
  if (!ins) throw new ErrorHttp(404, `No existe la inspección ${inspeccionId}`);
  const sistema = ins.conteos;

  const datos = { inspeccion_id: ins.inspeccion_id, lote_id: ins.lote_id, N: N_GRANOS };
  let experta;

  if (req.body?.csv_posiciones !== undefined) {
    if (!Array.isArray(ins.cuadricula)) {
      throw new ErrorHttp(400, 'La cuadrícula de esta inspección es «no asignable»; valide solo con los conteos');
    }
    const { posiciones, errores } = leerCsvPosiciones(req.body.csv_posiciones);
    if (errores.length) throw new ErrorHttp(400, `CSV no válido: ${errores.join('; ')}`);
    const delSistema = new Map(ins.cuadricula.map((p) => [`${p.fila},${p.columna}`, p.clase]));
    const pares = posiciones.map((p) => ({ ...p, clase_sistema: delSistema.get(`${p.fila},${p.columna}`) }));
    if (pares.some((p) => !CLASES.includes(p.clase_sistema))) throw new ErrorHttp(400, 'La cuadrícula del sistema está incompleta');

    experta = Object.fromEntries(CLASES.map((c) => [c, pares.filter((p) => p.clase_experta === c).length]));
    const m = matrizConfusion(pares.map((p) => ({ experta: p.clase_experta, sistema: p.clase_sistema })));
    const k = kappaCohen(m);
    Object.assign(datos, {
      origen_datos: 'csv_posiciones',
      n_posiciones: pares.length,
      matriz_confusion: m,
      exactitud_por_mitad: exactitud(m),
      kappa: k.kappa,
      ic95_kappa: k.ic95,
      p_o: k.p_o,
      p_e: k.p_e,
      posiciones: pares,
    });
  } else {
    const c = req.body?.conteos_experta ?? {};
    experta = Object.fromEntries(CLASES.map((k) => [k, Number(c[k])]));
    if (!CLASES.every((k) => Number.isInteger(experta[k]) && experta[k] >= 0)) {
      throw new ErrorHttp(400, 'Los conteos de la experta deben ser enteros mayores o iguales a 0');
    }
    const suma = CLASES.reduce((a, k) => a + experta[k], 0);
    if (suma !== N_GRANOS) throw new ErrorHttp(400, `Los conteos de la experta deben sumar ${N_GRANOS} (suman ${suma})`);
    Object.assign(datos, {
      origen_datos: 'conteos',
      n_posiciones: null, matriz_confusion: null, exactitud_por_mitad: null, kappa: null, ic95_kappa: null,
      p_o: null, p_e: null, posiciones: [],
    });
  }

  Object.assign(datos, {
    conteos_experta: experta,
    conteos_sistema: sistema,
    total_sistema: ins.total,
    diferencias_por_clase: diferencias(experta, sistema),
    C: concordancia(experta, sistema),
    tasa_deteccion: tasaDeteccion(ins.total),
    actualizado_en: new Date(),
  });

  const validacion = await Validacion.findOneAndUpdate(
    { inspeccion_id: ins.inspeccion_id },
    { $set: datos, $setOnInsert: { creado_en: new Date() } },
    { upsert: true, returnDocument: 'after', lean: true },
  );
  res.status(201).json(validacion);
});

// GET /api/validaciones/:inspeccion_id
rutas.get('/:id', async (req, res) => {
  const v = await Validacion.findOne({ inspeccion_id: String(req.params.id) }).lean();
  if (!v) throw new ErrorHttp(404, `La inspección ${req.params.id} no tiene validación`);
  res.json(v);
});

export default rutas;
