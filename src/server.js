const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const config = require('./config/config2');
const logger = require('./utils/logger');
const whatsappService = require('./services/whatsapp.service');
const dbRoles = require('./config/database');
const dbInmobiliaria = require('./config/database2');

const app = express();
const PORT = config.server.port || 3002;



// Estado global
let cleanupInProgress = false;
let initializationTimeout = null;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware de logging
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path} - IP: ${req.ip}`);
    next();
});

// ==================== FUNCIONES DE LIMPIEZA Y SALUD ====================

/**
 * Limpia las carpetas de sesión de WhatsApp
 * @param {number} retries - Número de reintentos
 */
async function cleanupSessionFolders(retries = 3) {
    if (cleanupInProgress) {
        logger.warn('[CLEANUP] Limpieza ya en progreso, esperando...');
        return false;
    }

    cleanupInProgress = true;
        logger.info('[CLEANUP] 🧹 Iniciando limpieza de carpetas de sesión...');

    const foldersToClean = ['.wwebjs_auth', '.wwebjs_cache'];

    for (const folder of foldersToClean) {
        const folderPath = path.join(__dirname, '..', folder);

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                if (!fs.existsSync(folderPath)) {
                    logger.info(`[CLEANUP] 📁 Carpeta ${folder} no existe`);
                    break;
                }

                // Esperar antes de intentar borrar
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));

                // Eliminar carpeta
                fs.rmSync(folderPath, {
                    recursive: true,
                    force: true,
                    maxRetries: 3,
                    retryDelay: 1000
                });

                logger.info(`[CLEANUP] ✅ Carpeta ${folder} eliminada (intento ${attempt})`);
                break;

            } catch (error) {
                logger.warn(`[CLEANUP] ⚠️ Error eliminando ${folder} (intento ${attempt}/${retries}):`, error.code);

                if (attempt === retries) {
                    logger.error(`[CLEANUP] ❌ No se pudo eliminar ${folder} después de ${retries} intentos`);

                     // Intentar renombrar como último recurso (Windows)
                    try {
                        const backupPath = folderPath + '_old_' + Date.now();
                        fs.renameSync(folderPath, backupPath);
                        logger.info(`[CLEANUP] Carpeta ${folder} renombrada a: ${backupPath}`);
                    } catch (renameError) {
                        logger.error(`[CLEANUP] No se pudo renombrar ${folder}:`, renameError.code);
                    }
                }
            }
        }
    }

    cleanupInProgress = false;
    logger.info('[CLEANUP] 🧹 Limpieza completada');
    return true;
}

/**
 * Verifica la salud de la sesión (detecta carpetas huérfanas)
 */
async function verifySessionHealth() {
    const authPath = path.join(__dirname, '..', '.wwebjs_auth');
    const cachePath = path.join(__dirname, '..', '.wwebjs_cache');
    const status = whatsappService.getStatus();

    // Si hay carpetas pero no hay sesión activa, limpiar
    if ((fs.existsSync(authPath) || fs.existsSync(cachePath)) &&
        !status.isReady && !status.isInitializing) {

        logger.warn('[HEALTH] ⚠️ Detectadas carpetas de sesión huérfanas, limpiando...');
        await cleanupSessionFolders();
    }
}

/**
 * Maneja errores de WhatsApp y limpia el estado
 * @param {string} errorMessage - Mensaje de error
 */
async function handleWhatsAppError(errorMessage) {
    logger.error(`[ERROR-HANDLER] ❌ Error de WhatsApp: ${errorMessage}`);

    // Limpiar timeout si existe
    if (initializationTimeout) {
        clearTimeout(initializationTimeout);
        initializationTimeout = null;
    }

    try {
        // Destruir cliente
        if (whatsappService.isClientReady() || whatsappService.getStatus().isInitializing) {
            logger.info('[ERROR-HANDLER] Deteniendo cliente...');
            await whatsappService.destroy();
        }

        // Esperar a que se liberen recursos
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Limpiar carpetas
        await cleanupSessionFolders();

        logger.info('[ERROR-HANDLER] ✅ Error manejado, estado limpiado');

    } catch (error) {
        logger.error('[ERROR-HANDLER] Error durante manejo de error:', error);
    }
}

// ==================== ENDPOINTS ====================

/**
 * POST /start-whatsapp
 * Inicia el bot de WhatsApp con rol y permisos
 */
app.post('/start-whatsapp', async (req, res) => {
    try {
        const { role, permissions } = req.body;

        logger.info(`[API] 🚀 Solicitud de inicio de WhatsApp - Rol: ${role}`);

        // Validar rol
        if (!role) {
            return res.status(400).json({
                success: false,
                message: 'El campo "role" es requerido'
            });
        }

        // Verificar estado actual
        const status = whatsappService.getStatus();

        if (status.isReady) {
            return res.json({
                success: true,
                message: 'WhatsApp ya está conectado',
                status: 'connected',
                role: status.role,
                qr: null
            });
        }

         if (status.isInitializing) {
            return res.json({
                success: true,
                message: 'WhatsApp se está inicializando',
                status: 'initializing',
                role: status.role,
                qr: whatsappService.getQRCode()
            });
        }

        // Verificar salud de sesión antes de iniciar
        await verifySessionHealth();

        // Establecer timeout de inicialización (30 segundos)
        initializationTimeout = setTimeout(async () => {
            logger.error('[API] ⏰ Timeout de inicialización (30s), limpiando...');
            await handleWhatsAppError('Timeout al iniciar WhatsApp');
        }, 30000);

        // Iniciar WhatsApp (proceso asíncrono)
        whatsappService.initialize(role, permissions || [])
            .then(() => {
                if (initializationTimeout) {
                    clearTimeout(initializationTimeout);
                    initializationTimeout = null;
                }
                logger.info('[API] ✅ WhatsApp inicializado correctamente');
            })
            .catch(async (error) => {
                logger.error('[API] ❌ Error inicializando WhatsApp:', error);
                await handleWhatsAppError(`Error de inicialización: ${error.message}`);
            });

        // Responder inmediatamente
        res.json({
            success: true,
            message: 'Inicialización de WhatsApp en progreso',
            status: 'initializing',
            role: role,
            qr: null
        });

            } catch (error) {
        logger.error('[API] Error en /start-whatsapp:', error);
        res.status(500).json({
            success: false,
            message: 'Error al iniciar WhatsApp: ' + error.message
        });
    }
});

/**
 * GET /get-qr
 * Obtiene el código QR actual o el estado de conexión
 */
app.get('/get-qr', async (req, res) => {
    try {
        const status = whatsappService.getStatus();
        const qrCode = whatsappService.getQRCode();

        if (status.isReady) {
            return res.json({
                status: 'connected',
                qr: null,
                message: 'WhatsApp está conectado',
                role: status.role,
                timestamp: new Date().toISOString()
            });
        }

        if (status.isInitializing && qrCode) {
            return res.json({
                status: 'qr_ready',
                qr: qrCode,
                message: 'Escanea el código QR',
                role: status.role,
                timestamp: new Date().toISOString()
            });
        }

        if (status.isInitializing && !qrCode) {
            return res.json({
                status: 'initializing',
                qr: null,
                message: 'Generando código QR...',
                role: status.role,
                timestamp: new Date().toISOString()
            });
        }

                res.json({
            status: 'disconnected',
            qr: null,
            message: 'WhatsApp no está conectado',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('[API] Error en /get-qr:', error);
        res.status(500).json({
            status: 'error',
            qr: null,
            message: 'Error obteniendo estado: ' + error.message
        });
    }
});

/**
 * POST /stop-whatsapp
 * Detiene el bot de WhatsApp
 */
app.post('/stop-whatsapp', async (req, res) => {
    try {
        logger.info('[API] 🛑 Solicitud de detener WhatsApp');

        const status = whatsappService.getStatus();

        if (!status.isReady && !status.isInitializing) {
            return res.json({
                success: true,
                message: 'WhatsApp ya está detenido',
                status: 'disconnected'
            });
        }

        // Limpiar timeout si existe
        if (initializationTimeout) {
            clearTimeout(initializationTimeout);
            initializationTimeout = null;
        }

        await whatsappService.destroy();

        res.json({
            success: true,
            message: 'WhatsApp detenido exitosamente',
            status: 'disconnected'
        });

    } catch (error) {
        logger.error('[API] Error en /stop-whatsapp:', error);
        res.status(500).json({
            success: false,
            message: 'Error al detener WhatsApp: ' + error.message
        });
    }
});

/**
 * POST /cleanup-session
 * Limpia la sesión de WhatsApp (fuerza nuevo escaneo de QR)
 */
app.post('/cleanup-session', async (req, res) => {
    try {
        logger.info('[API] 🧹 Solicitud de limpieza de sesión');

        // Limpiar timeout
        if (initializationTimeout) {
            clearTimeout(initializationTimeout);
            initializationTimeout = null;
        }

        // Detener cliente si está activo
        const status = whatsappService.getStatus();
        if (status.isReady || status.isInitializing) {
            await whatsappService.destroy();
        }

        // Esperar a que se cierre completamente
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Limpiar carpetas
        const cleaned = await cleanupSessionFolders();

        res.json({
            success: true,
            message: cleaned
                ? 'Sesión limpiada exitosamente. Puedes iniciar WhatsApp nuevamente.'
                : 'Hubo problemas al limpiar la sesión. Verifica manualmente.',
            cleaned,
            status: 'disconnected'
        });

    } catch (error) {
        logger.error('[API] Error en /cleanup-session:', error);
        res.status(500).json({
            success: false,
            message: 'Error al limpiar sesión: ' + error.message
        });
            }
});

app.post('/force-cleanup', async (req, res) => {
    try {
        logger.info('[API] 🧹💪 Solicitud de limpieza FORZADA');

        // Limpiar timeout
        if (initializationTimeout) {
            clearTimeout(initializationTimeout);
            initializationTimeout = null;
        }

        // Destruir cliente sin esperar mucho
        try {
            await Promise.race([
                whatsappService.destroy(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
            ]);
        } catch (e) {
            logger.warn('[API] Error/timeout destruyendo cliente (continuando):', e.message);
        }

        // Esperar más tiempo
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Limpiar con más reintentos
        const cleaned = await cleanupSessionFolders(5);

        res.json({
            success: cleaned,
            message: cleaned
                ? 'Limpieza forzada exitosa. Reinicia el servidor si persisten problemas.'
                : 'No se pudo limpiar. Reinicia el servidor y elimina carpetas manualmente.',
            cleaned,
            status: 'disconnected'
        });

    } catch (error) {
        logger.error('[API] Error en /force-cleanup:', error);
        res.status(500).json({
            success: false,
            message: 'Error en limpieza forzada: ' + error.message
        });
    }
});

app.post('/retry-connection', async (req, res) => {
    try {
        const { role, permissions } = req.body;

        logger.info('[API] 🔄 Reintento de conexión solicitado');

        if (!role) {
            return res.status(400).json({
                success: false,
                message: 'El campo "role" es requerido'
            });
        }

        // Limpiar sesión actual
        await handleWhatsAppError('Reintento manual de conexión');

        // Esperar a que se limpie
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Iniciar nuevamente
        whatsappService.initialize(role, permissions || [])
            .then(() => {
                logger.info('[API] ✅ WhatsApp reiniciado correctamente');
            })
            .catch(async (error) => {
                logger.error('[API] ❌ Error reiniciando WhatsApp:', error);
                await handleWhatsAppError(`Error de reinicio: ${error.message}`);
            });

        res.json({
            success: true,
            message: 'Reintentando conexión...',
            status: 'initializing'
        });

    } catch (error) {
        logger.error('[API] Error en /retry-connection:', error);
        res.status(500).json({
            success: false,
            message: 'Error al reintentar conexión: ' + error.message
        });
    }
});

/**
 * GET /status
 * Obtiene el estado general del bot
 */
app.get('/status', async (req, res) => {
    try {
        const status = whatsappService.getStatus();

        res.json({
            success: true,
            whatsapp: {
                connected: status.isReady,
                initializing: status.isInitializing,
                hasQR: status.hasQR,
                role: status.role
            },
            server: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                nodeVersion: process.version
            },
            cleanup: {
                inProgress: cleanupInProgress
            }
        });

    } catch (error) {
        logger.error('[API] Error en /status:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo estado: ' + error.message
        });
    }
}); 

/**
 * GET /health
 * Endpoint de health check
 */
app.get('/health', async (req, res) => {
    try {
        // Verificar conexiones a bases de datos
        await dbRoles.query('SELECT 1');
        await dbInmobiliaria.query('SELECT 1');

        const status = whatsappService.getStatus();

        res.json({
            success: true,
            status: 'healthy',
            timestamp: new Date().toISOString(),
            databases: {
                roles: 'connected',
                inmobiliaria: 'connected'
            },
            whatsapp: {
                status: status.isReady ? 'connected' : status.isInitializing ? 'initializing' : 'disconnected',
                role: status.role
            }
        });

    } catch (error) {
        logger.error('[API] Error en /health:', error);
        res.status(503).json({
            success: false,
            status: 'unhealthy',
            message: error.message
        });
    }
});

/**
 * GET /
 * Endpoint raíz
 */
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Bot de WhatsApp Inmobiliaria API',
        version: '2.0.0',
        endpoints: {
            'POST /start-whatsapp': 'Iniciar bot de WhatsApp',
            'GET /get-qr': 'Obtener código QR',
            'POST /stop-whatsapp': 'Detener bot',
            'POST /cleanup-session': 'Limpiar sesión',
            'POST /force-cleanup': 'Limpieza forzada de sesión',
            'POST /retry-connection': 'Reintentar conexión',
            'GET /status': 'Estado del sistema',
            'GET /health': 'Health check'
        }
    });
});

// Manejo de rutas no encontradas
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint no encontrado'
    });
});

// Manejo de errores global
app.use((err, req, res, next) => {
    logger.error('[API] Error no manejado:', err);
    res.status(500).json({
        success: false,
        message: 'Error interno del servidor',
        error: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
});

async function startServer() {
    try {
        // Verificar salud de sesión al inicio
        logger.info('[SERVER] Verificando salud de sesión...');
        await verifySessionHealth();

        // Verificar conexiones a base de datos
        logger.info('[SERVER] Verificando conexiones a base de datos...');

        await dbRoles.query('SELECT 1');
        logger.info('[SERVER] ✅ Conexión a BD de Roles OK');

        await dbInmobiliaria.query('SELECT 1');
        logger.info('[SERVER] ✅ Conexión a BD de Inmobiliaria OK');

        // Iniciar servidor Express
        app.listen(PORT, () => {
            logger.info('='.repeat(60));
            logger.info(`[SERVER] 🚀 Servidor iniciado en puerto ${PORT}`);
            logger.info(`[SERVER] 📡 URL: http://localhost:${PORT}`);
            logger.info(`[SERVER] 🕐 Fecha: ${new Date().toLocaleString()}`);
            logger.info(`[SERVER] 📋 Endpoints: ${Object.keys(app._router.stack.filter(r => r.route).map(r => r.route.path)).length} disponibles`);
            logger.info('='.repeat(60));
        });

    } catch (error) {
        logger.error('[SERVER] ❌ Error fatal al iniciar servidor:', error);
        process.exit(1);
    }
}



process.on('SIGINT', async () => {
    logger.info('[SERVER] Señal SIGINT recibida, cerrando servidor...');

    if (initializationTimeout) {
        clearTimeout(initializationTimeout);
    }

    try {
        await whatsappService.destroy();
        logger.info('[SERVER] WhatsApp cerrado correctamente');
        await new Promise(resolve => setTimeout(resolve, 2000));
        await cleanupSessionFolders();
    } catch (error) {
        logger.error('[SERVER] Error cerrando WhatsApp:', error);
    }

    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('[SERVER] Señal SIGTERM recibida, cerrando servidor...');

    if (initializationTimeout) {
        clearTimeout(initializationTimeout);
    }

    try {
        await whatsappService.destroy();
        logger.info('[SERVER] WhatsApp cerrado correctamente');
        await new Promise(resolve => setTimeout(resolve, 2000));
        await cleanupSessionFolders();
    } catch (error) {
        logger.error('[SERVER] Error cerrando WhatsApp:', error);
    }

    process.exit(0);
});

// Manejar errores no capturados
process.on('uncaughtException', async (error) => {
    logger.error('[SERVER] ❌ Excepción no capturada:', error);
    await handleWhatsAppError(`Excepción no capturada: ${error.message}`);
});

process.on('unhandledRejection', async (reason, promise) => {
    logger.error('[SERVER] ❌ Promesa rechazada no manejada:', reason);
    await handleWhatsAppError(`Promesa rechazada: ${reason}`);
});

// Iniciar servidor
startServer();

module.exports = app;