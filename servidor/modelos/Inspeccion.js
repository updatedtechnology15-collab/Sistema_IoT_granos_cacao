import mongoose from 'mongoose';

const { Mixed } = mongoose.Schema.Types;

// Conteos y porcentajes por clase, en el orden de la NTE INEN 176.
const porClase = { fermentado: Number, violeta: Number, pizarroso: Number, mohoso: Number };

const esquemaInspeccion = new mongoose.Schema(
  {
    // --- identificación y tiempo ---
    inspeccion_id: { type: String, required: true, unique: true },
    lote_id: { type: String, required: true, index: true },
    estacion_id: String,
    inicio: { type: Date, index: true },
    fin: Date,
    ventana_s: Number,
    fps_operacion: Number,
    n_cuadros: Number,
    n_cuadros_latencia: Number, // cuadros usados en la latencia (sin calentamiento)
    fuente: String,
    tipo_fuente: String, // archivo | en_vivo
    fps_fuente: Number,
    paso: Number, // se procesa 1 de cada `paso` cuadros

    // --- conteos (mediana por clase de todos los cuadros procesados) ---
    conteos: porClase,
    total: Number,
    porcentajes: porClase,

    // --- rendimiento del nodo ---
    latencia: { media_ms: Number, de_ms: Number, p95_ms: Number, fps_max: Number },
    recursos: { rss_max_mb: Number, cpu_media_pct: Number, gpu_mem_max_mb: Number },

    // --- entorno ---
    modelo: String,
    dispositivo: String,
    hardware: Mixed,
    versiones: Mixed,
    parametros: Mixed,
    modo_inferencia: String, // extremo_a_extremo | nms | nms_agnostico

    // --- evidencia (una sola imagen por inspección) ---
    imagen_jpeg: String, // cuadro representativo anotado, JPEG en base64
    cuadro_representativo: Mixed,
    detecciones_representativas: [Mixed],
    cuadricula: Mixed, // lista de 100 posiciones o "no asignable"

    // --- red IoT (calculado por el servidor) ---
    iot: {
      n_publicados: Number,
      n_recibidos: Number,
      n_faltantes: Number,
      perdida_pct: Number,
      lat_borde_servidor_media_ms: Number,
      lat_borde_servidor_de_ms: Number,
      lat_borde_servidor_p95_ms: Number,
      lat_resultado_ms: Number,
      t_total_inspeccion_s: Number, // null si la inspección se inició por consola
      seq_faltantes: [Number],
      latencias_ms: [Number], // latencia de cada mensaje de detecciones recibido, para reproducir media, DE y p95
    },

    ts_pub: Date, // publicación del resultado en el nodo
    recibido_en: Date, // recepción del resultado en el servidor
  },
  { collection: 'inspecciones', versionKey: false },
);

/** Campos pesados que se omiten en los listados. */
export const SIN_CAMPOS_PESADOS =
  '-imagen_jpeg -detecciones_representativas -cuadricula -parametros -iot.latencias_ms -iot.seq_faltantes';

export default mongoose.model('Inspeccion', esquemaInspeccion);
