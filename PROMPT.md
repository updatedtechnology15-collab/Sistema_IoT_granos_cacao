# PROMPT: Sistema IoT para el ensayo de corte de cacao (nodo de borde, servidor y tablero web)

## 0. Cómo trabajar
Actúa como ingeniero de software y construye el sistema desde cero en esta carpeta. Avanza por las etapas de la sección 7. Al terminar cada etapa, detente, explícame cómo probarla y espera mi confirmación antes de seguir.

No agregues funciones que no estén en este documento. La interfaz, los comentarios del código y el README van en español. El sistema debe funcionar en Windows 11.

## 1. Contexto
El sistema automatiza el ensayo de corte de granos de cacao CCN-51 según la NTE INEN 176 (Ecuador). Un detector YOLO26 de Ultralytics clasifica las mitades de grano cortado en cuatro clases: fermentado, violeta, pizarroso y mohoso.

Los resultados se publicarán en un artículo científico. Por eso, cada número que muestre el sistema debe poder exportarse y reproducirse.

Escena de trabajo:
- 100 mitades de grano en una cuadrícula de 10 × 10 sobre fondo blanco;
- cámara cenital a 30 cm;
- video a 30 fps;
- la escena no se mueve durante la inspección.

Nodo de borde: portátil con AMD Ryzen 7 7445HS. Detecta si hay CUDA; si no hay, usa solo la CPU.

## 2. Arquitectura (no cambiarla)
- **Nodo de borde (Python):** procesa el video con YOLO26 y publica por MQTT/TLS (puerto 8883) en HiveMQ Cloud.
- **Servidor (Node.js, Express y Mongoose):** se suscribe por MQTT/TLS (8883) y guarda los datos en MongoDB Atlas.
- **Tablero web:** lo sirve el servidor y se conecta al broker por WSS (8884) para la vista en vivo.

No construyas una aplicación de escritorio. El tablero web es parte del sistema IoT que describe el artículo.

## 3. Punto de partida
La carpeta está vacía, salvo por estos archivos que yo coloco:
- `videos/Prueba_1_Cacao.mp4`, `videos/Prueba_2_Cacao.mp4` y `videos/Prueba_3_Cacao.mp4`: las tres pruebas de validación;
- `models/yolo26n.pt`, `models/yolo26s.pt` y `models/yolo26m.pt`: los modelos entrenados.

No hay código anterior: escribe todo según este documento y la estructura de la sección 5.

Problemas del sistema anterior que no deben repetirse:
1. Las credenciales del broker estaban escritas en el código (Python, `server.js` y `dashboard.js`).
2. El nodo leía siempre un archivo de video fijo.
3. No existían los lotes.
4. El conteo de una inspección no tenía una regla definida.
5. No se guardaba la imagen.
6. El informe sumaba los conteos de varios registros, así que contaba varias veces los mismos granos.

## 4. Requisitos

### 4.1 Configuración y seguridad
- Todos los parámetros van en `edge/config.yaml`; los secretos, en `.env`. Agrega `.env.example` y un `.gitignore` que excluya `.env`, `resultados/`, `models/*.pt`, `videos/` y `referencia_anterior/`.
- Se usan dos credenciales de HiveMQ:
  - `edge`, que publica y se suscribe;
  - `tablero`, que solo se suscribe. El tablero la obtiene del servidor en `GET /api/config/mqtt`.
- Valores por defecto en `config.yaml`:
  - `modelo: models/yolo26s.pt` (también existirán `yolo26n.pt` y `yolo26m.pt`)
  - `dispositivo: auto` (o `cpu`, `cuda`)
  - `fuente`: ruta de video, índice de cámara o URL
  - `fps_operacion: 5`: se procesa 1 de cada `round(fps_fuente / 5)` cuadros. En los cuadros que se saltan, usa `cap.grab()`. Si la fuente no informa sus fps, supone 30.
  - `imgsz: 640`
  - `conf: 0.45`
  - `ventana_s: 30`
  - `area_min_frac: 0.0012` y `area_max_frac: 0.12`: fracción del área del cuadro. Se descartan las cajas fuera de ese rango.
  - `fps_cuadro_vivo: 1`, `calidad_jpeg_vivo: 60` y `lado_max_vivo: 960`
  - `estacion_id: est01`
- YOLO26 detecta de extremo a extremo, sin NMS. No apliques un NMS adicional: deja `agnostic_nms` como opción en el config, desactivada. En cada inspección, registra el modo de inferencia (de extremo a extremo o con NMS).

### 4.2 Nodo de borde (Python 3.11 o superior)
Paquetes: `ultralytics` (una versión que soporte YOLO26), `opencv-python`, `paho-mqtt` 2.x, `numpy`, `pyyaml`, `python-dotenv` y `psutil`.

1. **Inicio:** el nodo espera el comando MQTT de inicio. También puede arrancar por consola, por ejemplo `python edge/main.py --lote L-001 --fuente videos/Prueba_1_Cacao.mp4`.
2. **Ventana de 30 s:** cada inspección procesa una ventana de 30 s.
   - Con un archivo de video, el tiempo es tiempo del video (índice de cuadro / fps).
   - Con una cámara en vivo, es tiempo de reloj.
3. **Cada cuadro procesado:**
   - ejecuta la inferencia, aplica el filtro de área y cuenta los granos por clase;
   - publica las detecciones con QoS 0;
   - publica el cuadro en vivo, pero solo a `fps_cuadro_vivo`.
4. **Latencia por cuadro:** mide con `time.perf_counter` cada etapa: lectura, preproceso, inferencia, posproceso (de `results[0].speed`), publicación y total. Descarta los primeros 20 cuadros, que son de calentamiento.
5. **Resultado de la inspección, al cerrar la ventana:**
   - Conteo por clase: la mediana, por clase, de los conteos de todos los cuadros procesados, redondeada a entero. El total es la suma de las cuatro clases.
   - Cuadro representativo: el cuadro cuyo vector de conteos tiene la menor distancia L1 a la mediana. Dibuja sus cajas con la clase y la confianza usando OpenCV y codifícalo en JPEG con calidad 85.
   - Latencia: media, desviación estándar, percentil 95 y fps máximo (1000 / media).
   - Recursos: memoria RSS máxima del proceso, CPU media en % y, si hay CUDA, memoria máxima de la GPU.
   - Metadatos:
     - modelo, dispositivo, nombre de la CPU y de la GPU;
     - versiones de Python, torch, ultralytics y opencv;
     - todos los parámetros del config;
     - número de cuadros procesados.
   - Publica el resultado completo con QoS 1, incluidas las detecciones del cuadro representativo.
6. **Copia local:** guarda en `resultados/<inspeccion_id>/` un CSV con la latencia de cada cuadro y otro con los conteos de cada cuadro.
7. **Cuadrícula (para validar mitad por mitad):** si el cuadro representativo tiene exactamente 100 detecciones, asígnalas a posiciones:
   1. ordena los centros de las cajas por y y divídelos en 10 filas de 10;
   2. ordena cada fila por x;
   3. numera fila 1–10 y columna 1–10 desde la esquina superior izquierda;
   4. guarda la posición, la clase y la confianza.

   Si no son 100, marca la inspección como `"cuadricula": "no asignable"`.

### 4.3 Tópicos MQTT (`cacao/<estacion_id>/...`)
Todos los mensajes incluyen `ts_pub`, la marca de tiempo de publicación en ISO 8601 con milisegundos. Los mensajes de `detecciones` llevan además `seq`, un número de secuencia que empieza en 1 en cada inspección. El resultado de `inspeccion` informa cuántos mensajes de detecciones publicó el nodo (`n_publicados`).
- `comando` (QoS 1): `{"accion":"iniciar","lote_id":"L-001","inspeccion_id":"...","ventana_s":30}`
- `estado` (QoS 1, retenido, con última voluntad `"desconectado"`): `{"estado":"listo|inspeccionando|desconectado","modelo":"yolo26s","dispositivo":"cuda","ts":"..."}`
- `detecciones` (QoS 0): `{"inspeccion_id":"...","cuadro":12,"t_video_s":2.4,"conteos":{...},"detecciones":[{"clase":"violeta","conf":0.93,"caja":[x1,y1,x2,y2]}],"latencia_ms":41.2}`
- `cuadro` (QoS 0): `{"inspeccion_id":"...","jpeg_b64":"...","ancho":960,"alto":960}`
- `inspeccion` (QoS 1): el resultado final del punto 4.2.5.

### 4.4 Servidor (Node.js 20 o superior: express, mqtt, mongoose y dotenv)
- Se suscribe a `estado` e `inspeccion` por MQTT/TLS (8883) y guarda cada inspección en MongoDB. Deja de guardar un registro cada 5 s.
- También se suscribe a `detecciones`, pero no guarda cada mensaje. Para cada inspección, solo calcula métricas de la red IoT:
  - mensajes recibidos y faltantes (según `seq`), y porcentaje de pérdida frente a `n_publicados`;
  - latencia del nodo al servidor = hora de recepción − `ts_pub`, como media, desviación estándar y percentil 95. Es válida porque el nodo y el servidor corren en el mismo portátil y comparten reloj; si el servidor se mueve a otro equipo, hay que sincronizar ambos relojes por NTP;
  - latencia del mensaje `inspeccion`;
  - tiempo total de la inspección: desde que el servidor publica el comando hasta que el resultado queda guardado en MongoDB.
  Estas métricas se guardan en el campo `iot` de la inspección.
- API REST:
  - `POST /api/lotes`, `GET /api/lotes`, `GET /api/lotes/:id`
  - `POST /api/inspecciones`: crea el `inspeccion_id` y publica el comando de inicio.
  - `GET /api/inspecciones?lote_id=` y `GET /api/inspecciones/:id`, que incluye la imagen.
  - `POST /api/validaciones` (conteos de la experta, o un CSV por posición) y `GET /api/validaciones/:inspeccion_id`
  - `GET /api/export/inspecciones.csv`, `GET /api/export/validaciones.csv` y `GET /api/export/iot.csv` (una fila por inspección con las métricas de la red IoT)
  - `GET /api/config/mqtt`: entrega solo la credencial de lectura.
- Sirve los archivos estáticos del tablero.

### 4.5 Base de datos (MongoDB Atlas; la cadena de conexión va en `.env`)
- **`lotes`:** `lote_id`, `origen` (finca o centro de acopio), `descripcion`, `operador` y `creado_en`.
- **`inspecciones`:**
  - identificación y tiempo: `inspeccion_id`, `lote_id`, `inicio`, `fin`, `ventana_s`, `fps_operacion`, `n_cuadros`;
  - conteos: `conteos` {fermentado, violeta, pizarroso, mohoso}, `total` y `porcentajes`;
  - rendimiento: `latencia` {media_ms, de_ms, p95_ms, fps_max} y `recursos` {rss_max_mb, cpu_media_pct, gpu_mem_max_mb};
  - entorno: `modelo`, `dispositivo`, `hardware`, `versiones`, `parametros`, `modo_inferencia`;
  - evidencia: `imagen_jpeg` (el cuadro representativo anotado, en base64), `detecciones_representativas` y `cuadricula`;
  - red IoT: `iot` {n_publicados, n_recibidos, perdida_pct, lat_borde_servidor_media_ms, lat_borde_servidor_de_ms, lat_borde_servidor_p95_ms, lat_resultado_ms, t_total_inspeccion_s}.
- **`validaciones`:**
  - siempre: `inspeccion_id`, `conteos_experta`, `diferencias_por_clase`, `C` y `tasa_deteccion`;
  - si hay posiciones: `matriz_confusion` (4 × 4), `exactitud_por_mitad`, `kappa` e `ic95_kappa`.

Se guarda una sola imagen por inspección, no una por cuadro, para no llenar el plan gratuito M0 (512 MB).

### 4.6 Tablero web (HTML, CSS y JavaScript sin framework; Chart.js; MQTT.js por WSS en el puerto 8884)
1. **En vivo:**
   - el cuadro en vivo con sus cajas;
   - el conteo por clase y la confianza media;
   - la latencia y los fps del nodo, y el estado del nodo (en línea o desconectado);
   - un botón "Iniciar inspección de 30 s" con selector de lote y barra de progreso.
2. **Lotes:** crear lotes y ver el historial de inspecciones de cada lote.
3. **Detalle de inspección:**
   - la imagen anotada, los conteos y los porcentajes;
   - el porcentaje de cada clase comparado con los límites de la NTE INEN 176 (tabla de abajo);
   - un aviso fijo: "Grado no asignado: el sistema no detecta la clase defectuoso";
   - la latencia, los recursos, el modelo, el dispositivo y las versiones;
   - las métricas de la red IoT (pérdida de mensajes, latencia del nodo al servidor y tiempo total);
   - un botón para exportar en CSV.
4. **Validación:**
   - un formulario para los conteos de la experta y la carga de un CSV por posición (`fila, columna, clase_experta`);
   - muestra C, las diferencias por clase y la tasa de detección;
   - si hay posiciones, también la matriz de confusión, la exactitud por mitad y el kappa con su IC 95 %;
   - exporta en CSV.

Límites de la NTE INEN 176, en % sobre 100 granos:

| Tipo | Grado 1 | Grado 2 | Grado 3 |
|---|---|---|---|
| Fermentados, mínimo | 75 | 65 | 53 |
| Violetas, máximo | 15 | 21 | 25 |
| Pizarrosos, máximo | 9 | 12 | 18 |
| Mohosos, máximo | 1 | 2 | 4 |
| Defectuosos, máximo | 0.5 | 1.0 | 3.0 |

### 4.7 Cálculos de validación
- **Concordancia de conteos:** C = (1 − Σ_k |n_k^E − n_k^S| / N) × 100, con N = 100. E es la experta y S el sistema.
- **Tasa de detección:** detecciones del sistema / 100 × 100.
- **Por posición:**
  - matriz de confusión experta × sistema;
  - exactitud = suma de la diagonal / N;
  - kappa de Cohen: κ = (p_o − p_e) / (1 − p_e), con p_e = Σ_k (fila_k · columna_k) / N²;
  - IC 95 % = κ ± 1.96 · √(p_o (1 − p_o) / (N (1 − p_e)²)).
- **Conteos de la experta, precargados para las pruebas existentes:**

| Prueba | Fermentado | Mohoso | Violeta | Pizarroso |
|---|---|---|---|---|
| 1 | 36 | 3 | 19 | 42 |
| 2 | 36 | 3 | 16 | 45 |
| 3 | 48 | 11 | 9 | 32 |

### 4.8 `herramientas/benchmark.py` (comparación de modelos)
- Ejecuta yolo26n, yolo26s y yolo26m en CPU y, si existe, en GPU, sobre los videos Prueba_1, Prueba_2 y Prueba_3.
- Usa el mismo pipeline y los mismos parámetros del nodo (5 fps de operación, conf 0.45, ventana de 30 s), pero sin MQTT.
- Mide al menos 300 cuadros procesados por cada combinación, después del calentamiento.

Salidas en `resultados/benchmark/`:
- `latencias_detalle.csv`: modelo, dispositivo, video, cuadro y los tiempos de lectura, preproceso, inferencia, posproceso y total en ms.
- `resumen.csv`: modelo, parámetros y GFLOPs (de `model.info()`), dispositivo, latencia media ± DE, percentil 95, fps máximo, RSS máxima, CPU media en % y memoria máxima de la GPU.
- `conteos_y_concordancia.csv`: modelo, dispositivo, prueba, conteo por clase, total y C frente a la experta. Al final, C media ± DE por modelo y dispositivo.
- `hardware.txt`: CPU, GPU, RAM, sistema operativo y versiones.

### 4.9 `herramientas/evaluar_modelos.py` (evaluación en el conjunto de prueba)
- Para cada modelo, corre una sola vez `model.val(data="data.yaml", split="test", imgsz=640, plots=True)`.
- Guarda en `resultados/evaluacion/metricas_prueba.csv` la P, la R, el mAP@0.5 y el mAP@0.5:0.95, en total y por clase. Copia también la matriz de confusión.
- Debe poder correr en Google Colab.

## 5. Estructura de carpetas
```
edge/          main.py, pipeline.py, mqtt_cliente.py, cuadricula.py, config.yaml
servidor/      server.js, modelos/, rutas/, public/ (tablero)
herramientas/  benchmark.py, evaluar_modelos.py, prueba_calculos.py
models/        yolo26n.pt, yolo26s.pt, yolo26m.pt (fuera de git)
videos/        Prueba_1_Cacao.mp4, Prueba_2_Cacao.mp4, Prueba_3_Cacao.mp4
resultados/    (fuera de git)
.env.example  .gitignore  requirements.txt  README.md
```

## 6. Criterios de aceptación
- Ningún archivo versionado contiene credenciales.
- Una inspección de 30 s sobre un video produce el conteo por mediana, la imagen anotada, la latencia y los recursos, y queda en MongoDB vinculada a su lote.
- Si se desconecta el nodo, el tablero muestra "desconectado" (por la última voluntad).
- Cada inspección guardada muestra la pérdida de mensajes, la latencia del nodo al servidor y el tiempo total de la inspección.
- `benchmark.py` corre los tres modelos y genera los cuatro archivos de salida.
- `prueba_calculos.py` verifica C y kappa con casos conocidos. Caso de C: experta (36, 3, 19, 42) y sistema (37, 3, 17, 43), en el orden fermentado, mohoso, violeta y pizarroso, debe dar C = 96.

## 7. Etapas (detente al final de cada una)
1. **Seguridad y configuración:** crear la estructura de carpetas, `.env`, `.env.example`, `.gitignore` y `config.yaml`. Ninguna credencial queda en el código.
2. **Nodo de borde y `benchmark.py`:** una inspección por consola sobre Prueba_1 que genere sus CSV, y luego el benchmark con los tres modelos.
3. **Servidor y MongoDB Atlas:** las inspecciones que llegan por MQTT se guardan con su imagen, y la API REST responde.
4. **Tablero:** las cuatro páginas, incluido el inicio de una inspección desde el tablero.
5. **Validación y exportación:** C y kappa, exportación CSV, `evaluar_modelos.py` y `prueba_calculos.py`.
6. **README:** instalación, configuración y cómo reproducir cada tabla del artículo con los scripts.
