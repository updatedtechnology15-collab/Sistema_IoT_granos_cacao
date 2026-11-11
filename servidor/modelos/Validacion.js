import mongoose from 'mongoose';

const porClase = { fermentado: Number, violeta: Number, pizarroso: Number, mohoso: Number };

// Una validación por inspección; si se vuelve a enviar, se reemplaza.
const esquemaValidacion = new mongoose.Schema(
  {
    // --- siempre ---
    inspeccion_id: { type: String, required: true, unique: true },
    lote_id: { type: String, index: true },
    origen_datos: String, // conteos | csv_posiciones
    N: Number, // 100 mitades
    conteos_experta: porClase,
    conteos_sistema: porClase, // mediana de la inspección (copia, para reproducir C)
    total_sistema: Number,
    diferencias_por_clase: porClase, // sistema − experta
    C: Number,
    tasa_deteccion: Number,

    // --- solo con posiciones (CSV fila, columna, clase_experta) ---
    n_posiciones: Number,
    matriz_confusion: [[Number]], // filas: experta; columnas: sistema; orden fermentado, violeta, pizarroso, mohoso
    exactitud_por_mitad: Number, // fracción 0–1
    kappa: Number,
    ic95_kappa: [Number],
    p_o: Number,
    p_e: Number,
    posiciones: [{ _id: false, fila: Number, columna: Number, clase_experta: String, clase_sistema: String }],

    creado_en: { type: Date, default: Date.now },
    actualizado_en: { type: Date, default: Date.now },
  },
  { collection: 'validaciones', versionKey: false },
);

export default mongoose.model('Validacion', esquemaValidacion);
