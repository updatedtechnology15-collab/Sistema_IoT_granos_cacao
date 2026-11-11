// Servidor del sistema IoT para el ensayo de corte de cacao.
// - Se suscribe por MQTT/TLS (8883) a EMQX Cloud y guarda las inspecciones en MongoDB Atlas.
// - Expone la API REST y sirve el tablero web (carpeta public/).
// Uso: cd servidor && npm start
import path from 'node:path';
import express from 'express';
import mongoose from 'mongoose';
import { config, DIR_SERVIDOR, RAIZ, log } from './configuracion.js';
import { iniciarMqtt, cerrarMqtt } from './mqtt_servidor.js';
import { encabezadosSeguridad, escuchaSoloLocal, verificarHost } from './seguridad.js';
import rutasLotes from './rutas/lotes.js';
import rutasInspecciones from './rutas/inspecciones.js';
import rutasConfig from './rutas/config.js';
import rutasValidaciones from './rutas/validaciones.js';
import rutasExportar from './rutas/exportar.js';

mongoose.set('sanitizeFilter', true); // impide inyectar operadores ($gt, $ne...) en las consultas

function manejarErrores(err, _req, res, _next) {
  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({ error: Object.values(err.errors).map((e) => e.message).join('; ') });
  } else if (err?.code === 11000) {
    res.status(409).json({ error: 'Ya existe un registro con ese identificador' });
  } else if (err?.status) {
    res.status(err.status).json({ error: err.message }); // ErrorHttp o JSON mal formado
  } else {
    log('Error interno:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function main() {
  log('Conectando a MongoDB Atlas...');
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 20000 });
  log(`MongoDB conectado (base "${mongoose.connection.db.databaseName}")`);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init())); // crea los índices

  iniciarMqtt();

  const app = express();
  app.disable('x-powered-by');
  app.use(verificarHost());
  app.use(encabezadosSeguridad());
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/lotes', rutasLotes);
  app.use('/api/inspecciones', rutasInspecciones);
  app.use('/api/config', rutasConfig);
  app.use('/api/validaciones', rutasValidaciones);
  app.use('/api/export', rutasExportar);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  // Tablero: archivos estáticos, librerías del navegador desde node_modules
  // (versiones fijadas en package-lock.json) y conteos de la experta precargados.
  const modulos = path.join(DIR_SERVIDOR, 'node_modules');
  app.get('/vendor/chart.umd.min.js', (_req, res) => res.sendFile(path.join(modulos, 'chart.js', 'dist', 'chart.umd.min.js')));
  app.get('/vendor/mqtt.min.js', (_req, res) => res.sendFile(path.join(modulos, 'mqtt', 'dist', 'mqtt.min.js')));
  app.get('/datos/conteos_experta.csv', (_req, res) => res.sendFile(path.join(RAIZ, 'herramientas', 'conteos_experta.csv')));
  app.use(express.static(path.join(DIR_SERVIDOR, 'public')));
  app.use(manejarErrores);

  const http = app.listen(config.puertoHttp, config.hostHttp, () => {
    log(`Servidor web en http://localhost:${config.puertoHttp}`);
    if (!escuchaSoloLocal()) {
      log(`AVISO: el servidor escucha en ${config.hostHttp}; cualquiera en la red puede usar la API (no tiene autenticación)`);
    }
  });

  const cerrar = async () => {
    log('Cerrando el servidor...');
    http.close();
    await cerrarMqtt();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', cerrar);
  process.on('SIGTERM', cerrar);
}

main().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err.message);
  process.exit(1);
});
