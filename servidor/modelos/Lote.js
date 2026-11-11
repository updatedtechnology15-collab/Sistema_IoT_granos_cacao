import mongoose from 'mongoose';

const esquemaLote = new mongoose.Schema(
  {
    lote_id: {
      type: String,
      required: [true, 'lote_id es obligatorio'],
      unique: true,
      trim: true,
      match: [/^[A-Za-z0-9._-]{1,64}$/, 'lote_id solo admite letras, números, punto, guion y guion bajo (máx. 64)'],
    },
    origen: { type: String, required: [true, 'origen es obligatorio (finca o centro de acopio)'], trim: true },
    descripcion: { type: String, trim: true, default: '' },
    operador: { type: String, trim: true, default: '' },
    creado_en: { type: Date, default: Date.now },
  },
  { collection: 'lotes', versionKey: false },
);

export default mongoose.model('Lote', esquemaLote);
